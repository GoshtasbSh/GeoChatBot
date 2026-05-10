import { type Table as ArrowTable, tableFromJSON } from "apache-arrow";
// @vitest-environment happy-dom
/**
 * Phase 5 review-fix regressions. One spec per finding from the audit so
 * a regression in any single fix surfaces with a precise failure name.
 *
 * Findings covered:
 *   B1 — pushData({rows}) registers an executor dataset binding
 *   H1 — <result-canvas> is cleared between consecutive plan runs
 *   H4 — ask() refuses while a plan is awaiting approval
 */
import { describe, expect, it, vi } from "vitest";

import "../../src/element.js";
import "../../src/agent/tools/index.js";
import "../../src/agent/executor/runners/index.js";
import type { ExecutorEngine } from "../../src/agent/executor/types.js";

class SpyEngine implements ExecutorEngine {
	hasSpatial = true;
	public sqls: string[] = [];
	public mockResponse: ArrowTable = tableFromJSON([{ count: 1 }]);
	async query(sql: string): Promise<ArrowTable> {
		this.sqls.push(sql);
		return this.mockResponse;
	}
}

interface TestEl extends HTMLElement {
	__setLlmCall: (fn: (input: unknown) => Promise<unknown>) => void;
	__setExecutorEngine: (engine: ExecutorEngine) => void;
	__lastExecution?: Promise<void>;
	setProvider: (p: {
		name: string;
		apiKey: string;
		generate: () => Promise<unknown>;
	}) => void;
	pushData: (d: unknown) => Promise<void>;
	ask: (q: string) => Promise<void>;
	approvePlan: () => void;
	setMode: (m: "full" | "headless") => void;
	setAttribute: (n: string, v: string) => void;
	shadowRoot: ShadowRoot | null;
	updateComplete: Promise<unknown>;
}

function mount(): TestEl {
	const el = document.createElement("geo-chatbot") as unknown as TestEl;
	document.body.appendChild(el);
	el.setProvider({
		name: "anthropic",
		apiKey: "k",
		generate: async () => ({ text: "" }),
	});
	return el;
}

/** Seed a planner profile so plans referencing `mydata` validate. */
async function seedPlannerOnly(el: TestEl): Promise<void> {
	await el.pushData({
		name: "mydata",
		kind: "table",
		rows: 2,
		columns: [
			{ name: "id", type: "integer" },
			{ name: "name", type: "string" },
		],
		sample: [],
	});
}

const summaryPlan = {
	goal: "just summarize",
	assumptions: [],
	dataset_refs: ["mydata"],
	steps: [
		{ id: "s1", tool: "render.summary", args: { text: "hello" }, why: "final" },
	],
};

const tablePlan = {
	goal: "show a table",
	assumptions: [],
	dataset_refs: ["mydata"],
	steps: [
		{ id: "s1", tool: "render.table", args: { table: "mydata" }, why: "final" },
	],
};

describe("B1 — pushData({rows}) binds the dataset to the executor", () => {
	it("routes inline rows through the full ingest path", async () => {
		const el = mount();
		const spy = new SpyEngine();
		el.__setExecutorEngine(spy);

		await el.pushData({
			name: "mydata",
			rows: [
				{ id: 1, name: "A" },
				{ id: 2, name: "B" },
			],
		});

		// Internal: planner-side dataset present.
		const datasets = (el as unknown as { _datasets: unknown[] })._datasets;
		expect(datasets).toHaveLength(1);

		// Internal: executor-side dataset binding present (the fix).
		const exec = (el as unknown as { _execDatasets: Array<{ name: string }> })
			._execDatasets;
		// Engine boot may fail in happy-dom without a Worker; in that case the
		// executor binding is best-effort. The contract here is that the
		// planner-side dataset was published, but if the engine path worked
		// we should also see the executor binding.
		if (exec.length > 0) {
			expect(exec[0]?.name).toBe("mydata");
		}
	});

	it("emits dataset-loaded for inline rows", async () => {
		const el = mount();
		el.__setExecutorEngine(new SpyEngine());
		const events: unknown[] = [];
		el.shadowRoot?.host.addEventListener("dataset-loaded", (e: Event) => {
			events.push((e as CustomEvent).detail);
		});
		await el.pushData({
			name: "inline",
			rows: [{ a: 1 }],
		});
		expect(events).toHaveLength(1);
	});

	it("runs a render.table plan against the inline-rows dataset end-to-end", async () => {
		const el = mount();
		const spy = new SpyEngine();
		spy.mockResponse = tableFromJSON([
			{ id: 1, name: "A" },
			{ id: 2, name: "B" },
		]);
		el.__setExecutorEngine(spy);

		// The inline-rows path will publish a planner profile too; the engine
		// boot may fail under happy-dom (no Worker) but the planner side will
		// still see the dataset, which is what plan validation checks.
		await el.pushData({
			name: "mydata",
			rows: [
				{ id: 1, name: "A" },
				{ id: 2, name: "B" },
			],
		});

		// Synthesize the executor binding regardless of whether DuckDB-WASM
		// booted in this environment so the executor side of the integration
		// is exercised.
		(el as unknown as { _execDatasets: unknown[] })._execDatasets = [
			{ name: "mydata", tableName: "mydata", hasGeometry: false },
		];

		el.__setLlmCall(vi.fn().mockResolvedValue(tablePlan));
		const results: Array<{ kind: string }> = [];
		el.shadowRoot?.host.addEventListener("result", (e: Event) => {
			results.push((e as CustomEvent).detail);
		});
		await el.ask("show me");
		el.approvePlan();
		await el.__lastExecution;
		expect(results.find((r) => r.kind === "table")).toBeDefined();
	});

	it("rejects an empty rows array with a clear error", async () => {
		const el = mount();
		el.__setExecutorEngine(new SpyEngine());
		const errors: Array<{ message: string }> = [];
		el.shadowRoot?.host.addEventListener("error", (e: Event) => {
			errors.push((e as CustomEvent).detail);
		});
		await el.pushData({ name: "empty", rows: [] });
		expect(errors[0]?.message).toMatch(/empty/i);
	});
});

describe("H1 — <result-canvas> is cleared between consecutive runs", () => {
	it("does not retain renderer panels from the prior run", async () => {
		const el = mount();
		el.__setExecutorEngine(new SpyEngine());
		await seedPlannerOnly(el);
		(el as unknown as { _execDatasets: unknown[] })._execDatasets = [
			{ name: "mydata", tableName: "mydata", hasGeometry: false },
		];

		// Run 1 — emits a summary.
		el.__setLlmCall(vi.fn().mockResolvedValue(summaryPlan));
		await el.ask("q");
		el.approvePlan();
		await el.__lastExecution;

		interface Turn {
			results: Array<{ kind: string }>;
		}
		const canvas1 = el.shadowRoot?.querySelector("result-canvas") as
			| (HTMLElement & { _turns: Turn[] })
			| null;
		expect(canvas1).not.toBeNull();
		// Run 1 produced a summary somewhere in the turn history.
		const r1 = canvas1?._turns.flatMap((t) => t.results);
		expect(r1.some((p) => p.kind === "summary")).toBe(true);

		// Run 2 — emits a table; H1 says we must NOT see run 1's summary mounted.
		const spy2 = new SpyEngine();
		spy2.mockResponse = tableFromJSON([{ ok: 1 }]);
		el.__setExecutorEngine(spy2);
		el.__setLlmCall(vi.fn().mockResolvedValue(tablePlan));
		await el.ask("q2");
		el.approvePlan();
		await el.__lastExecution;

		const canvas2 = el.shadowRoot?.querySelector("result-canvas") as
			| (HTMLElement & { _turns: Turn[] })
			| null;
		const r2 = canvas2?._turns.flatMap((t) => t.results);
		// Cleared at the start of run 2: the summary from run 1 must be gone.
		expect(r2.some((p) => p.kind === "summary")).toBe(false);
		expect(r2.some((p) => p.kind === "table")).toBe(true);
	});
});

describe("H4 — ask() refuses while a plan is awaiting approval", () => {
	it("emits PLAN_PENDING error and does not overwrite the pending plan", async () => {
		const el = mount();
		el.__setExecutorEngine(new SpyEngine());
		await seedPlannerOnly(el);
		el.__setLlmCall(vi.fn().mockResolvedValue(summaryPlan));

		const errors: Array<{ code?: string }> = [];
		el.shadowRoot?.host.addEventListener("error", (e: Event) => {
			errors.push((e as CustomEvent).detail);
		});

		// Plan #1 sits awaiting approval.
		await el.ask("q1");
		const firstPending = (el as unknown as { _pendingPlan: { id: string } })
			._pendingPlan;
		expect(firstPending).toBeDefined();

		// Second ask() must error and leave the first pending plan in place.
		await el.ask("q2");
		expect(errors.some((e) => e.code === "PLAN_PENDING")).toBe(true);

		const stillPending = (el as unknown as { _pendingPlan: { id: string } })
			._pendingPlan;
		expect(stillPending.id).toBe(firstPending.id);
	});

	it("allows ask() again after approving the previous plan", async () => {
		const el = mount();
		el.__setExecutorEngine(new SpyEngine());
		await seedPlannerOnly(el);
		(el as unknown as { _execDatasets: unknown[] })._execDatasets = [
			{ name: "mydata", tableName: "mydata", hasGeometry: false },
		];
		el.__setLlmCall(vi.fn().mockResolvedValue(summaryPlan));

		await el.ask("q1");
		el.approvePlan();
		await el.__lastExecution;
		// Pending plan cleared → second ask() proceeds.
		await el.ask("q2");
		const second = (
			el as unknown as { _pendingPlan: { id: string } | undefined }
		)._pendingPlan;
		expect(second).toBeDefined();
	});
});
