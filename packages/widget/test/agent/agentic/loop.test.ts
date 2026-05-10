/**
 * Agent-loop integration tests.
 *
 * The loop is driven by an injectable `LoopLLMCall`. Each test scripts
 * the LLM's responses (a sequence of tool_calls), and asserts:
 *   - the loop dispatches inspection tools to the runners,
 *   - it appends observations as `tool` messages,
 *   - it returns the final Plan when finalize_plan is called,
 *   - it errors out on iteration-cap exhaustion or repeated unknown tools.
 */

import { tableFromJSON } from "apache-arrow";
import { describe, expect, it } from "vitest";
import type { InspectionRunCtx } from "../../../src/agent/agentic/inspect-runners.js";
import {
	type LoopLLMCall,
	runAgentLoop,
} from "../../../src/agent/agentic/loop.js";
import type {
	DatasetEntry,
	ExecutorEngine,
} from "../../../src/agent/executor/types.js";

function makeCtx(): InspectionRunCtx {
	const survey: DatasetEntry = {
		name: "survey",
		tableName: "survey",
		hasGeometry: false,
	};
	const engine: ExecutorEngine = {
		hasSpatial: true,
		async query(sql: string) {
			if (/pragma_table_info/.test(sql)) {
				return tableFromJSON([
					{ name: "Address", type: "VARCHAR", nullable: false },
				]);
			}
			if (/LIMIT 5/.test(sql)) {
				return tableFromJSON([
					{ Address: "6116 Harvard Avenue" },
					{ Address: "6169 Cascade" },
				]);
			}
			return tableFromJSON([{ ok: 1 }]);
		},
	};
	return { engine, datasets: new Map([["survey", survey]]) };
}

function scriptedLLM(
	sequence: ReadonlyArray<{
		text?: string;
		calls: Array<{ name: string; args: Record<string, unknown> }>;
	}>,
): LoopLLMCall {
	let i = 0;
	return async () => {
		const turn = sequence[i++];
		if (!turn) throw new Error("LLM script exhausted");
		return {
			text: turn.text ?? null,
			tool_calls: turn.calls.map((c, j) => ({ id: `call_${i}_${j}`, ...c })),
		};
	};
}

describe("runAgentLoop", () => {
	it("returns the Plan when finalize_plan is called immediately", async () => {
		const llmCall = scriptedLLM([
			{
				calls: [
					{
						name: "finalize_plan",
						args: {
							goal: "g",
							assumptions: [],
							dataset_refs: ["survey"],
							steps: [
								{
									id: "s1",
									tool: "render.summary",
									args: { text: "hi" },
									why: "final",
								},
							],
						},
					},
				],
			},
		]);
		const plan = await runAgentLoop({
			endpoint: "http://stub",
			apiKey: "k",
			model: "m",
			systemPrompt: "s",
			question: "q",
			ctx: makeCtx(),
			llmCall,
		});
		expect(plan.goal).toBe("g");
		expect(plan.steps).toHaveLength(1);
	});

	it("round-trips an inspection call before finalizing", async () => {
		const llmCall = scriptedLLM([
			{
				calls: [{ name: "inspect.list_columns", args: { dataset: "survey" } }],
			},
			{
				calls: [
					{
						name: "finalize_plan",
						args: {
							goal: "after-inspect",
							assumptions: [],
							dataset_refs: ["survey"],
							steps: [
								{
									id: "s1",
									tool: "render.summary",
									args: { text: "ok" },
									why: "final",
								},
							],
						},
					},
				],
			},
		]);
		const events: string[] = [];
		const plan = await runAgentLoop({
			endpoint: "http://stub",
			apiKey: "k",
			model: "m",
			systemPrompt: "s",
			question: "q",
			ctx: makeCtx(),
			llmCall,
			onStep: (e) => events.push(e.kind),
		});
		expect(plan.goal).toBe("after-inspect");
		expect(events).toContain("tool");
		expect(events).toContain("finalize");
	});

	it("errors when LLM calls unknown tools 3 times in a row", async () => {
		const llmCall = scriptedLLM([
			{ calls: [{ name: "mystery.tool", args: {} }] },
			{ calls: [{ name: "mystery.tool", args: {} }] },
			{ calls: [{ name: "mystery.tool", args: {} }] },
		]);
		await expect(
			runAgentLoop({
				endpoint: "http://stub",
				apiKey: "k",
				model: "m",
				systemPrompt: "s",
				question: "q",
				ctx: makeCtx(),
				llmCall,
			}),
		).rejects.toThrow(/unknown tools 3 times/);
	});

	it("errors on iteration-cap exhaustion", async () => {
		const llmCall = scriptedLLM(
			Array.from({ length: 10 }, () => ({
				calls: [{ name: "inspect.list_columns", args: { dataset: "survey" } }],
			})),
		);
		await expect(
			runAgentLoop({
				endpoint: "http://stub",
				apiKey: "k",
				model: "m",
				systemPrompt: "s",
				question: "q",
				ctx: makeCtx(),
				llmCall,
				maxIterations: 3,
			}),
		).rejects.toThrow(/exhausted 3 iterations/);
	});

	it("rejects malformed finalize_plan args and asks the LLM to retry", async () => {
		const llmCall = scriptedLLM([
			{
				calls: [
					{
						name: "finalize_plan",
						args: { goal: "", assumptions: [], dataset_refs: [], steps: [] },
					},
				],
			},
			{
				calls: [
					{
						name: "finalize_plan",
						args: {
							goal: "recovered",
							assumptions: [],
							dataset_refs: ["survey"],
							steps: [
								{
									id: "s1",
									tool: "render.summary",
									args: { text: "ok" },
									why: "final",
								},
							],
						},
					},
				],
			},
		]);
		const plan = await runAgentLoop({
			endpoint: "http://stub",
			apiKey: "k",
			model: "m",
			systemPrompt: "s",
			question: "q",
			ctx: makeCtx(),
			llmCall,
		});
		expect(plan.goal).toBe("recovered");
	});
});
