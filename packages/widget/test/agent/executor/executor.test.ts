import { type Table as ArrowTable, tableFromJSON } from "apache-arrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	Executor,
	MissingRunnerError,
} from "../../../src/agent/executor/executor.js";
import {
	_resetRunnerRegistry,
	registerRunner,
} from "../../../src/agent/executor/runtime.js";
import type {
	DatasetEntry,
	ExecutorEngine,
} from "../../../src/agent/executor/types.js";
import type { Plan } from "../../../src/agent/types.js";

class FakeEngine implements ExecutorEngine {
	hasSpatial = true;
	public queries: string[] = [];
	public response: ArrowTable = tableFromJSON([{ count: 1 }]);
	async query(sql: string): Promise<ArrowTable> {
		this.queries.push(sql);
		return this.response;
	}
}

const ds: DatasetEntry = {
	name: "sales",
	tableName: "sales",
	geomView: "sales_geom",
	hasGeometry: true,
};

beforeEach(() => {
	_resetRunnerRegistry();
});

describe("Executor — orchestration", () => {
	it("runs each step and emits success progress in order", async () => {
		registerRunner("mock.a", async () => ({
			output: { kind: "table", ref: "a_view" },
		}));
		registerRunner("mock.b", async () => ({
			output: { kind: "table", ref: "b_view" },
		}));
		registerRunner("render.summary", async (args) => ({
			output: { kind: "rendered", ref: "rendered" },
			payload: { kind: "summary", text: String(args.text) },
		}));

		const exec = new Executor({ engine: new FakeEngine(), datasets: [ds] });
		const progress = vi.fn();
		const result = vi.fn();

		const plan: Plan = {
			goal: "demo",
			assumptions: [],
			dataset_refs: ["sales"],
			steps: [
				{ id: "s1", tool: "mock.a", args: {}, output_var: "a", why: "first" },
				{ id: "s2", tool: "mock.b", args: {}, output_var: "b", why: "second" },
				{
					id: "s3",
					tool: "render.summary",
					args: { text: "done" },
					why: "final",
				},
			],
		};

		await exec.execute(plan, "plan_x", {
			onProgress: progress,
			onResult: result,
		});

		const stepIds = progress.mock.calls.map((c) => c[0].stepId);
		expect(stepIds).toEqual(["s1", "s1", "s2", "s2", "s3", "s3"]);
		const statuses = progress.mock.calls.map((c) => c[0].status);
		expect(statuses).toEqual([
			"running",
			"success",
			"running",
			"success",
			"running",
			"success",
		]);
		expect(result).toHaveBeenCalledOnce();
		expect(result.mock.calls[0]?.[0]).toMatchObject({
			planId: "plan_x",
			stepId: "s3",
			kind: "summary",
			text: "done",
		});
	});

	it("threads output_var through ${var} substitution", async () => {
		const seen: unknown[] = [];
		registerRunner("produce", async () => ({
			output: { kind: "table", ref: "first_view" },
		}));
		registerRunner("consume", async (args) => {
			seen.push(args);
			return { output: { kind: "table", ref: "second_view" } };
		});
		registerRunner("render.summary", async () => ({
			output: { kind: "rendered", ref: "rendered" },
			payload: { kind: "summary", text: "ok" },
		}));

		const exec = new Executor({ engine: new FakeEngine(), datasets: [ds] });

		const plan: Plan = {
			goal: "g",
			assumptions: [],
			dataset_refs: ["sales"],
			steps: [
				{ id: "s1", tool: "produce", args: {}, output_var: "a", why: "p" },
				{
					id: "s2",
					tool: "consume",
					args: { layer: "${a}" },
					output_var: "b",
					why: "c",
				},
				{ id: "s3", tool: "render.summary", args: { text: "x" }, why: "f" },
			],
		};
		await exec.execute(plan, "plan_y");

		expect(seen).toHaveLength(1);
		const args = seen[0] as { layer: { kind: string; ref: string } };
		expect(args.layer).toEqual({ kind: "table", ref: "first_view" });
	});

	it("halts execution and reports the error when a step throws", async () => {
		registerRunner("fail", async () => {
			throw new Error("boom");
		});
		registerRunner("after", async () => ({
			output: { kind: "table", ref: "unused" },
		}));

		const exec = new Executor({ engine: new FakeEngine(), datasets: [ds] });
		const progress = vi.fn();
		const errorCb = vi.fn();
		const plan: Plan = {
			goal: "g",
			assumptions: [],
			dataset_refs: ["sales"],
			steps: [
				{ id: "s1", tool: "fail", args: {}, why: "will fail" },
				{ id: "s2", tool: "after", args: {}, why: "never runs" },
			],
		};

		await exec.execute(plan, "plan_z", {
			onProgress: progress,
			onError: errorCb,
		});

		const stepIds = progress.mock.calls.map((c) => c[0].stepId);
		expect(stepIds).toEqual(["s1", "s1"]);
		expect(progress.mock.calls.at(-1)?.[0].status).toBe("fail");
		expect(errorCb).toHaveBeenCalledOnce();
		expect(errorCb.mock.calls[0]?.[0]).toMatchObject({
			planId: "plan_z",
			stepId: "s1",
			message: "boom",
		});
	});

	it("throws MissingRunnerError when a tool has no registered runner", async () => {
		const exec = new Executor({ engine: new FakeEngine(), datasets: [ds] });
		const errorCb = vi.fn();
		const plan: Plan = {
			goal: "g",
			assumptions: [],
			dataset_refs: ["sales"],
			steps: [{ id: "s1", tool: "no.such.tool", args: {}, why: "" }],
		};
		await exec.execute(plan, "plan_e", { onError: errorCb });
		expect(errorCb).toHaveBeenCalledOnce();
		expect(errorCb.mock.calls[0]?.[0].code).toBe("MISSING_RUNNER");
	});

	it("mints unique view names per step", async () => {
		const minted: string[] = [];
		registerRunner("mint", async (_args, ctx) => {
			minted.push(ctx.newView("out"));
			return { output: { kind: "table", ref: "unused" } };
		});
		registerRunner("render.summary", async () => ({
			output: { kind: "rendered", ref: "rendered" },
			payload: { kind: "summary", text: "x" },
		}));

		const exec = new Executor({ engine: new FakeEngine(), datasets: [ds] });
		await exec.execute(
			{
				goal: "g",
				assumptions: [],
				dataset_refs: ["sales"],
				steps: [
					{ id: "s1", tool: "mint", args: {}, why: "a" },
					{ id: "s2", tool: "mint", args: {}, why: "b" },
					{ id: "s3", tool: "render.summary", args: { text: "x" }, why: "f" },
				],
			},
			"pid",
		);
		expect(new Set(minted).size).toBe(2);
		expect(minted[0]).not.toBe(minted[1]);
	});
});

describe("Executor — Phase 6 critic hook (onStepError)", () => {
	// Snapshot the tool registry around each test in this block. The Phase 6
	// tests call _resetRegistry() to install test-only ToolDefs, which would
	// otherwise leak into later test files (notably the integration tests
	// that rely on the real geometry/joins/stats catalog). Snapshot/restore
	// makes these cases hermetic regardless of vitest's parallel worker
	// ordering.
	let _toolsSnapshot: import("../../../src/agent/tools/types.js").ToolDef[] =
		[];
	beforeEach(async () => {
		const reg = await import("../../../src/agent/tools/registry.js");
		_toolsSnapshot = reg.listTools();
	});
	afterEach(async () => {
		const reg = await import("../../../src/agent/tools/registry.js");
		reg._resetRegistry();
		for (const t of _toolsSnapshot) reg.registerTool(t);
	});

	it("aborts when no critic is provided (existing behavior)", async () => {
		registerRunner("boom", async () => {
			throw new Error("initial fail");
		});
		registerRunner("after", async () => ({
			output: { kind: "table", ref: "unused" },
		}));
		const exec = new Executor({ engine: new FakeEngine(), datasets: [ds] });
		const progress = vi.fn();
		const errorCb = vi.fn();
		const plan: Plan = {
			goal: "g",
			assumptions: [],
			dataset_refs: ["sales"],
			steps: [
				{ id: "s1", tool: "boom", args: {}, why: "fails" },
				{ id: "s2", tool: "after", args: {}, why: "never runs" },
			],
		};
		await exec.execute(plan, "pid", { onProgress: progress, onError: errorCb });
		expect(errorCb).toHaveBeenCalledOnce();
		// s2 must not run.
		expect(progress.mock.calls.map((c) => c[0].stepId)).toEqual(["s1", "s1"]);
	});

	it('retries the same step when critic returns {action: "retry"}', async () => {
		let attempts = 0;
		registerRunner("flaky", async () => {
			attempts++;
			if (attempts < 2) throw new Error("transient");
			return { output: { kind: "table", ref: "ok" } };
		});
		registerRunner("render.summary", async () => ({
			output: { kind: "rendered", ref: "r" },
			payload: { kind: "summary", text: "done" },
		}));

		const exec = new Executor({ engine: new FakeEngine(), datasets: [ds] });
		const errorCb = vi.fn();
		const onStepError = vi.fn().mockResolvedValue({ action: "retry" as const });
		const plan: Plan = {
			goal: "g",
			assumptions: [],
			dataset_refs: ["sales"],
			steps: [
				{
					id: "s1",
					tool: "flaky",
					args: {},
					output_var: "a",
					why: "fails once",
				},
				{ id: "s2", tool: "render.summary", args: { text: "x" }, why: "final" },
			],
		};
		await exec.execute(plan, "pid", { onError: errorCb, onStepError });

		expect(attempts).toBe(2);
		expect(onStepError).toHaveBeenCalledOnce();
		// Critic decided retry → no terminal error.
		expect(errorCb).not.toHaveBeenCalled();
	});

	it('replaces the step when critic returns {action: "patch"}', async () => {
		// Phase 5 alignment: critic-patched steps must reference a registered
		// ToolDef so the executor can validate args against the tool's zod
		// schema. A runner without a ToolDef would now fail validation.
		const { registerTool, _resetRegistry } = await import(
			"../../../src/agent/tools/registry.js"
		);
		_resetRegistry();
		const { z } = await import("zod");
		registerTool({
			id: "fixed",
			description: "fixed tool",
			args: z.object({}),
			output_kind: "table",
		});
		registerRunner("typo", async () => {
			throw new Error("typo: column not found");
		});
		registerRunner("fixed", async () => ({
			output: { kind: "table", ref: "fixed_view" },
		}));
		registerRunner("render.summary", async () => ({
			output: { kind: "rendered", ref: "r" },
			payload: { kind: "summary", text: "done" },
		}));

		const exec = new Executor({ engine: new FakeEngine(), datasets: [ds] });
		const onStepError = vi.fn().mockImplementation(async (ctx) => ({
			action: "patch" as const,
			patchedStep: {
				id: ctx.step.id,
				tool: "fixed",
				args: {},
				output_var: "fixed_var",
				why: "critic patched the typo",
			},
		}));
		const errorCb = vi.fn();
		const plan: Plan = {
			goal: "g",
			assumptions: [],
			dataset_refs: ["sales"],
			steps: [
				{ id: "s1", tool: "typo", args: {}, why: "fails" },
				{ id: "s2", tool: "render.summary", args: { text: "x" }, why: "final" },
			],
		};
		await exec.execute(plan, "pid", { onError: errorCb, onStepError });
		expect(errorCb).not.toHaveBeenCalled();
	});

	it("aborts after maxRetries (default 2) of consistent failures", async () => {
		registerRunner("always_fail", async () => {
			throw new Error("persistent");
		});
		const exec = new Executor({ engine: new FakeEngine(), datasets: [ds] });
		const onStepError = vi.fn().mockResolvedValue({ action: "retry" as const });
		const errorCb = vi.fn();
		const plan: Plan = {
			goal: "g",
			assumptions: [],
			dataset_refs: ["sales"],
			steps: [{ id: "s1", tool: "always_fail", args: {}, why: "always fails" }],
		};
		await exec.execute(plan, "pid", { onError: errorCb, onStepError });
		// 1 initial + 2 retries = 3 attempts → critic invoked twice (after the
		// 1st and 2nd failures), then the budget is exhausted and the 3rd
		// failure becomes terminal.
		expect(onStepError).toHaveBeenCalledTimes(2);
		expect(errorCb).toHaveBeenCalledOnce();
		expect(errorCb.mock.calls[0]?.[0].message).toBe("persistent");
	});

	it('aborts immediately when critic returns {action: "abort"}', async () => {
		registerRunner("boom", async () => {
			throw new Error("fatal");
		});
		const exec = new Executor({ engine: new FakeEngine(), datasets: [ds] });
		const onStepError = vi.fn().mockResolvedValue({ action: "abort" as const });
		const errorCb = vi.fn();
		await exec.execute(
			{
				goal: "g",
				assumptions: [],
				dataset_refs: ["sales"],
				steps: [{ id: "s1", tool: "boom", args: {}, why: "fails" }],
			},
			"pid",
			{ onError: errorCb, onStepError },
		);
		expect(onStepError).toHaveBeenCalledOnce();
		expect(errorCb).toHaveBeenCalledOnce();
	});

	it("rejects a critic patch that changes step.id", async () => {
		registerRunner("boom", async () => {
			throw new Error("fatal");
		});
		const exec = new Executor({ engine: new FakeEngine(), datasets: [ds] });
		const onStepError = vi.fn().mockResolvedValue({
			action: "patch" as const,
			patchedStep: { id: "s999", tool: "boom", args: {}, why: "wrong id" },
		});
		const errorCb = vi.fn();
		await exec.execute(
			{
				goal: "g",
				assumptions: [],
				dataset_refs: ["sales"],
				steps: [{ id: "s1", tool: "boom", args: {}, why: "fails" }],
			},
			"pid",
			{ onError: errorCb, onStepError },
		);
		expect(errorCb).toHaveBeenCalledOnce();
		expect(errorCb.mock.calls[0]?.[0].code).toBe("CRITIC_PATCH_INVALID");
	});

	it("rejects a critic patch that fails StepSchema validation", async () => {
		registerRunner("boom", async () => {
			throw new Error("fatal");
		});
		const exec = new Executor({ engine: new FakeEngine(), datasets: [ds] });
		const onStepError = vi.fn().mockResolvedValue({
			action: "patch" as const,
			// Missing required `why` and `tool` fields → StepSchema rejects.
			patchedStep: { id: "s1", tool: "", args: {}, why: "" } as never,
		});
		const errorCb = vi.fn();
		await exec.execute(
			{
				goal: "g",
				assumptions: [],
				dataset_refs: ["sales"],
				steps: [{ id: "s1", tool: "boom", args: {}, why: "fails" }],
			},
			"pid",
			{ onError: errorCb, onStepError },
		);
		expect(errorCb).toHaveBeenCalledOnce();
		expect(errorCb.mock.calls[0]?.[0].code).toBe("CRITIC_PATCH_INVALID");
	});

	it("treats a throwing critic as abort with original error preserved", async () => {
		registerRunner("boom", async () => {
			throw new Error("underlying");
		});
		const exec = new Executor({ engine: new FakeEngine(), datasets: [ds] });
		const onStepError = vi.fn().mockRejectedValue(new Error("critic crashed"));
		const errorCb = vi.fn();
		await exec.execute(
			{
				goal: "g",
				assumptions: [],
				dataset_refs: ["sales"],
				steps: [{ id: "s1", tool: "boom", args: {}, why: "fails" }],
			},
			"pid",
			{ onError: errorCb, onStepError },
		);
		expect(errorCb).toHaveBeenCalledOnce();
		// The original step error message is preserved (not the critic crash).
		expect(errorCb.mock.calls[0]?.[0].message).toBe("underlying");
	});

	it("exposes priorOutputs to the critic for diagnostics", async () => {
		registerRunner("produce", async () => ({
			output: { kind: "table", ref: "first_view" },
		}));
		registerRunner("boom", async () => {
			throw new Error("boom");
		});
		const exec = new Executor({ engine: new FakeEngine(), datasets: [ds] });
		let captured: ReadonlyMap<string, unknown> | undefined;
		const onStepError = vi.fn().mockImplementation(async (ctx) => {
			captured = ctx.priorOutputs;
			return { action: "abort" };
		});
		await exec.execute(
			{
				goal: "g",
				assumptions: [],
				dataset_refs: ["sales"],
				steps: [
					{ id: "s1", tool: "produce", args: {}, output_var: "a", why: "p" },
					{ id: "s2", tool: "boom", args: {}, why: "fails" },
				],
			},
			"pid",
			{ onStepError },
		);
		expect(captured).toBeDefined();
		expect(captured?.get("a")).toEqual({ kind: "table", ref: "first_view" });
	});

	it("respects maxRetries: 0 — critic never called", async () => {
		registerRunner("boom", async () => {
			throw new Error("fatal");
		});
		const exec = new Executor({
			engine: new FakeEngine(),
			datasets: [ds],
			maxRetries: 0,
		});
		const onStepError = vi.fn();
		const errorCb = vi.fn();
		await exec.execute(
			{
				goal: "g",
				assumptions: [],
				dataset_refs: ["sales"],
				steps: [{ id: "s1", tool: "boom", args: {}, why: "fails" }],
			},
			"pid",
			{ onError: errorCb, onStepError },
		);
		expect(onStepError).not.toHaveBeenCalled();
		expect(errorCb).toHaveBeenCalledOnce();
	});

	it("rejects a critic patch whose args fail the per-tool args schema", async () => {
		// The executor consults the agent/tools registry to validate args
		// for critic-patched steps (Phase 5 alignment with validate-plan.ts).
		// We register a real ToolDef + a matching runner so the patched step
		// has the same surface area as a planner-emitted step.
		const { registerTool, _resetRegistry } = await import(
			"../../../src/agent/tools/registry.js"
		);
		_resetRegistry();
		const { z } = await import("zod");
		registerTool({
			id: "patched.real",
			description: "test tool",
			args: z.object({ count: z.number().int().min(1) }),
			output_kind: "table",
		});
		registerRunner("patched.real", async () => ({
			output: { kind: "table", ref: "r" },
		}));
		registerRunner("boom", async () => {
			throw new Error("initial fail");
		});

		const exec = new Executor({ engine: new FakeEngine(), datasets: [ds] });
		const onStepError = vi.fn().mockResolvedValue({
			action: "patch" as const,
			// count must be a positive int — passing a string makes zod reject.
			patchedStep: {
				id: "s1",
				tool: "patched.real",
				args: { count: "oops" },
				why: "patched",
			},
		});
		const errorCb = vi.fn();
		await exec.execute(
			{
				goal: "g",
				assumptions: [],
				dataset_refs: ["sales"],
				steps: [{ id: "s1", tool: "boom", args: {}, why: "fails" }],
			},
			"pid",
			{ onError: errorCb, onStepError },
		);
		expect(errorCb).toHaveBeenCalledOnce();
		expect(errorCb.mock.calls[0]?.[0].code).toBe("CRITIC_PATCH_INVALID");
		expect(errorCb.mock.calls[0]?.[0].message).toMatch(/args/i);
	});

	it("rejects a critic patch whose tool id is not registered", async () => {
		const { _resetRegistry } = await import(
			"../../../src/agent/tools/registry.js"
		);
		_resetRegistry();
		registerRunner("boom", async () => {
			throw new Error("initial fail");
		});

		const exec = new Executor({ engine: new FakeEngine(), datasets: [ds] });
		const onStepError = vi.fn().mockResolvedValue({
			action: "patch" as const,
			patchedStep: {
				id: "s1",
				tool: "never.registered",
				args: {},
				why: "patched",
			},
		});
		const errorCb = vi.fn();
		await exec.execute(
			{
				goal: "g",
				assumptions: [],
				dataset_refs: ["sales"],
				steps: [{ id: "s1", tool: "boom", args: {}, why: "fails" }],
			},
			"pid",
			{ onError: errorCb, onStepError },
		);
		expect(errorCb).toHaveBeenCalledOnce();
		expect(errorCb.mock.calls[0]?.[0].code).toBe("CRITIC_PATCH_INVALID");
		expect(errorCb.mock.calls[0]?.[0].message).toMatch(/unknown tool/);
	});
});

describe("MissingRunnerError", () => {
	it("carries stepId and tool", () => {
		const e = new MissingRunnerError("s4", "foo.bar");
		expect(e.stepId).toBe("s4");
		expect(e.tool).toBe("foo.bar");
		expect(e.name).toBe("MissingRunnerError");
	});
});
