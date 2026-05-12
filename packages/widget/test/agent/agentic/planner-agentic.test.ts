/**
 * End-to-end test: Planner in agentic mode.
 *
 * Wires the synthetic embedder + a scripted agentic LLM + a spy engine
 * and asserts the Planner returns a validated Plan that incorporates
 * the inspection observation.
 */

import { tableFromJSON } from "apache-arrow";
import { beforeEach, describe, expect, it } from "vitest";
import type { LoopLLMCall } from "../../../src/agent/agentic/loop.js";
import type {
	DatasetEntry,
	ExecutorEngine,
} from "../../../src/agent/executor/types.js";
import { Planner } from "../../../src/agent/planner.js";
import {
	EMBEDDING_DIM,
	__setTestEmbedder,
} from "../../../src/agent/retrieval/embedder.js";
import { __resetRetrieverForTests } from "../../../src/agent/retrieval/retriever.js";
// Side-effect import: registers all terminal tools so the planner schema
// references resolve during validation.
import "../../../src/agent/tools/index.js";

beforeEach(async () => {
	// Synthetic bag-of-words embedder so the planner's RAG path runs in
	// ~milliseconds instead of downloading 22 MB of weights.
	__setTestEmbedder(() => new Float32Array(EMBEDDING_DIM));
	await __resetRetrieverForTests();
});

describe('Planner.plan({ mode: "agentic" })', () => {
	it("runs an inspection call and returns a validated Plan", async () => {
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
				return tableFromJSON([{ ok: 1 }]);
			},
		};

		const llmCall: LoopLLMCall = (() => {
			let i = 0;
			const turns: Array<{
				tool_calls: {
					id: string;
					name: string;
					args: Record<string, unknown>;
				}[];
			}> = [
				{
					tool_calls: [
						{
							id: "c1",
							name: "inspect.list_columns",
							args: { dataset: "survey" },
						},
					],
				},
				{
					tool_calls: [
						{
							id: "c2",
							name: "finalize_plan",
							args: {
								goal: "show-on-map",
								assumptions: ["address column needs geocoding"],
								dataset_refs: ["survey"],
								steps: [
									{
										id: "s1",
										tool: "geocode.address",
										args: {
											layer: "survey",
											address_cols: ["Address"],
											country_code: "us",
											region_hint: "Cedar Key, FL, USA",
										},
										output_var: "survey_geo",
										why: "attach a region hint so single-column street resolves correctly",
									},
									{
										id: "s2",
										tool: "render.map",
										args: { layer: "${survey_geo}" },
										why: "final render",
									},
								],
							},
						},
					],
				},
			];
			return async () => {
				const turn = turns[i++];
				if (!turn) throw new Error("LLM script exhausted");
				return { text: null, tool_calls: turn.tool_calls };
			};
		})();

		const planner = new Planner({
			provider: "groq",
			apiKey: "test",
			model: "llama-3.3-70b-versatile",
			mode: "agentic",
			agenticEndpoint: "http://stub.example/chat/completions",
			agenticLlmCall: llmCall,
			agenticCtx: { engine, datasets: new Map([["survey", survey]]) },
			retrieval: "off", // skip embedding to keep the test deterministic
			dangerouslyAllowBrowser: true,
		});

		const plan = await planner.plan({
			question: "Show this Cedar Key, FL community survey on a map.",
			datasets: [
				{
					name: "survey",
					kind: "table",
					rows: 269,
					columns: [{ name: "Address", type: "Utf8" }],
					sample: [],
				},
			],
		});

		expect(plan.goal).toBe("show-on-map");
		expect(plan.steps).toHaveLength(2);
		expect(plan.steps[0]?.tool).toBe("geocode.address");
		expect(plan.steps[1]?.tool).toBe("render.map");
		expect((plan.steps[0]?.args as { region_hint?: string }).region_hint).toBe(
			"Cedar Key, FL, USA",
		);
	});

	// AUDIT-K1 (2026-05-11): regression for the recovery loop. The agentic
	// planner used to dead-end if the LLM's first finalize_plan landed a
	// PlanValidationError (e.g. a `${var}` referencing a step that never
	// ran). It now re-asks the model once with the validation message as
	// feedback and returns the corrected plan.
	it("retries once when the first agentic plan fails validation", async () => {
		const survey: DatasetEntry = {
			name: "survey",
			tableName: "survey",
			hasGeometry: false,
		};
		const engine: ExecutorEngine = {
			hasSpatial: true,
			async query() {
				return tableFromJSON([{ ok: 1 }]);
			},
		};

		const feedbackSeen: string[] = [];
		const llmCall: LoopLLMCall = (req) => {
			// Capture the user message on each turn so we can prove the retry
			// feeds the validation error back in.
			const lastUser = [...req.messages]
				.reverse()
				.find((m) => m.role === "user");
			if (lastUser && typeof lastUser.content === "string") {
				feedbackSeen.push(lastUser.content);
			}
			// First call: emit a broken plan (dangling `${var}` reference
			// — last step references a var that no step produces).
			// Second call: emit a clean plan.
			const isFirst = !feedbackSeen.some((u) => /previous plan failed/.test(u));
			if (isFirst) {
				return Promise.resolve({
					text: null,
					tool_calls: [
						{
							id: "c1",
							name: "finalize_plan",
							args: {
								goal: "show",
								assumptions: [],
								dataset_refs: ["survey"],
								steps: [
									{
										id: "s1",
										tool: "render.map",
										args: { layer: "${missing}" },
										why: "render",
									},
								],
							},
						},
					],
				});
			}
			return Promise.resolve({
				text: null,
				tool_calls: [
					{
						id: "c2",
						name: "finalize_plan",
						args: {
							goal: "show",
							assumptions: [],
							dataset_refs: ["survey"],
							steps: [
								{
									id: "s1",
									tool: "render.map",
									args: { layer: "survey" },
									why: "render",
								},
							],
						},
					},
				],
			});
		};

		const planner = new Planner({
			provider: "groq",
			apiKey: "test",
			model: "llama-3.3-70b-versatile",
			mode: "agentic",
			agenticEndpoint: "http://stub.example/chat/completions",
			agenticLlmCall: llmCall,
			agenticCtx: { engine, datasets: new Map([["survey", survey]]) },
			retrieval: "off",
			dangerouslyAllowBrowser: true,
		});

		const plan = await planner.plan({
			question: "Show the survey.",
			datasets: [
				{
					name: "survey",
					kind: "table",
					rows: 1,
					columns: [{ name: "Address", type: "Utf8" }],
					sample: [],
				},
			],
		});

		// Final returned plan is the corrected one.
		expect(plan.steps).toHaveLength(1);
		expect(plan.steps[0]?.tool).toBe("render.map");
		// And the retry actually carried the validation feedback to the LLM.
		expect(
			feedbackSeen.some((u) => /previous plan failed validation/.test(u)),
		).toBe(true);
	});
});
