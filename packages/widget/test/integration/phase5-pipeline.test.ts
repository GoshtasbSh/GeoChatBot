import { type Table as ArrowTable, tableFromJSON } from "apache-arrow";
// @vitest-environment happy-dom
/**
 * Phase 5 integration: 4-step plan end-to-end through the widget element.
 *
 * Wires:
 *   pushData → __setExecutorEngine (spy) → __setLlmCall (stub) → ask
 *     → plan event → approvePlan → real Executor on the spy engine
 *     → progress events × 4 → result event
 *
 * Asserts:
 *   - Substitution chains correctly across sql → geometry → stats → render
 *   - Each step's emitted SQL includes the prior step's view name
 *   - All 4 progress(running) events fire BEFORE any progress(success)
 *     for any individual step (interleaved per step)
 *   - The final `result` event reaches the host with kind='summary'
 *   - In headless mode, no <result-canvas> mounts in shadow DOM
 */
import { describe, expect, it, vi } from "vitest";

import "../../src/element.js";
import "../../src/agent/tools/index.js";
import "../../src/agent/executor/runners/index.js";
import type { ExecutorEngine } from "../../src/agent/executor/types.js";

class SpyEngine implements ExecutorEngine {
	hasSpatial = true;
	public sqls: string[] = [];
	public mockResponse: ArrowTable = tableFromJSON([{ count: 3 }]);
	async query(sql: string): Promise<ArrowTable> {
		this.sqls.push(sql);
		return this.mockResponse;
	}
}

const fourStepPlan = {
	goal: "How many points fall within 50km of each centroid?",
	assumptions: ["Points are in EPSG:4326"],
	dataset_refs: ["points"],
	steps: [
		{
			id: "s1",
			tool: "sql",
			args: { query: "SELECT * FROM points_geom WHERE value > 5" },
			output_var: "filtered",
			why: "Pre-filter the points so downstream ops are smaller.",
		},
		{
			id: "s2",
			tool: "geometry.buffer",
			args: { layer: "${filtered}", distance: 50, units: "kilometers" },
			output_var: "buffered",
			why: "Expand each point to a 50 km service area.",
		},
		{
			id: "s3",
			tool: "stats.aggregate",
			args: {
				layer: "${buffered}",
				group_by: "name",
				agg_fn: "count",
				value_col: "value",
			},
			output_var: "totals",
			why: "Roll up the buffered features by name.",
		},
		{
			id: "s4",
			tool: "render.summary",
			args: { text: "3 points buffered and aggregated." },
			why: "Final answer.",
		},
	],
};

function mount(): {
	el: HTMLElement & {
		__setLlmCall: (fn: (input: unknown) => Promise<unknown>) => void;
		__setExecutorEngine: (engine: ExecutorEngine) => void;
		__lastExecution?: Promise<void>;
		setProvider: (p: {
			name: string;
			apiKey: string;
			generate: () => Promise<unknown>;
		}) => void;
		pushData: (d: unknown) => void;
		ask: (q: string) => Promise<void>;
		approvePlan: () => void;
		setMode: (m: "full" | "headless") => void;
		setAttribute: (n: string, v: string) => void;
		shadowRoot: ShadowRoot | null;
	};
	spy: SpyEngine;
} {
	const el = document.createElement("geo-chatbot") as never;
	const cast = el as unknown as ReturnType<typeof mount>["el"];
	document.body.appendChild(el as unknown as Node);
	const spy = new SpyEngine();
	cast.__setExecutorEngine(spy);
	cast.__setLlmCall(vi.fn().mockResolvedValue(fourStepPlan));
	cast.setProvider({
		name: "anthropic",
		apiKey: "k",
		generate: async () => ({ text: "" }),
	});
	cast.pushData({
		name: "points",
		kind: "layer",
		rows: 3,
		geometry: { kind: "point", column: "geom", crs: "EPSG:4326" },
		columns: [
			{ name: "name", type: "string" },
			{ name: "value", type: "integer" },
		],
		sample: [],
	});
	return { el: cast, spy };
}

describe("Phase 5 — 4-step plan end-to-end", () => {
	it("runs all 4 steps in order, emitting progress and a final result", async () => {
		const { el, spy } = mount();

		// Register the dataset directly into the executor view so the
		// sql step ("FROM points_geom") resolves. We can't easily exercise
		// engine.registerArrow without a real DuckDB, so we synthesize the
		// executor entry — pushData() did the planner-side; this completes
		// the executor side.
		(el as unknown as { _execDatasets: unknown[] })._execDatasets = [
			{
				name: "points",
				tableName: "points",
				geomView: "points_geom",
				hasGeometry: true,
			},
		];

		const progress: Array<{ stepId: string; status: string }> = [];
		const results: unknown[] = [];
		const errors: unknown[] = [];
		el.shadowRoot?.host.addEventListener("progress", (e: Event) => {
			progress.push((e as CustomEvent).detail);
		});
		el.shadowRoot?.host.addEventListener("result", (e: Event) => {
			results.push((e as CustomEvent).detail);
		});
		el.shadowRoot?.host.addEventListener("error", (e: Event) => {
			errors.push((e as CustomEvent).detail);
		});

		await el.ask("How many points within 50km?");
		el.approvePlan();
		await el.__lastExecution;

		// No errors anywhere in the pipeline.
		expect(errors).toEqual([]);

		// Each of the 4 steps emits running + success → 8 progress events.
		expect(progress.map((p) => p.stepId)).toEqual([
			"s1",
			"s1",
			"s2",
			"s2",
			"s3",
			"s3",
			"s4",
			"s4",
		]);
		expect(progress.map((p) => p.status)).toEqual([
			"running",
			"success",
			"running",
			"success",
			"running",
			"success",
			"running",
			"success",
		]);

		// Final render.summary surfaces as the only result event.
		expect(results).toHaveLength(1);
		expect((results[0] as { kind: string; text: string }).kind).toBe("summary");
		expect((results[0] as { text: string }).text).toContain("3 points");

		// Substitution chain: s2 must reference s1's view, s3 must reference s2's view.
		const allSql = spy.sqls.join("\n");
		expect(/CREATE OR REPLACE TEMPORARY VIEW "gcb_sql_s1_/.test(allSql)).toBe(
			true,
		);
		expect(/ST_Buffer\(geom, 50000\)/.test(allSql)).toBe(true);
		expect(/FROM "gcb_sql_s1_/.test(allSql)).toBe(true);
		expect(/FROM "gcb_buffer_s2_/.test(allSql)).toBe(true);
		// AUDIT-008: count semantics use COUNT(*) (group size). The
		// previous COUNT("value") was sample-size of non-null value, not
		// the canonical "rows in group". The plan still passes value_col
		// for the output alias name (`count_value`), but the SQL counts
		// rows.
		expect(/COUNT\(\*\)/.test(allSql)).toBe(true);
		expect(/AS "count_value"/.test(allSql)).toBe(true);
	});

	it("halts on the first step failure and reports it", async () => {
		const { el } = mount();
		(el as unknown as { _execDatasets: unknown[] })._execDatasets = [
			{
				name: "points",
				tableName: "points",
				geomView: "points_geom",
				hasGeometry: true,
			},
		];
		// Inject an engine that always rejects — even the first SQL fails.
		const failing: ExecutorEngine = {
			hasSpatial: true,
			query: () => Promise.reject(new Error("engine offline")),
		};
		el.__setExecutorEngine(failing);

		const progress: Array<{ stepId: string; status: string; error?: string }> =
			[];
		const errors: Array<{ message: string }> = [];
		el.shadowRoot?.host.addEventListener("progress", (e: Event) => {
			progress.push((e as CustomEvent).detail);
		});
		el.shadowRoot?.host.addEventListener("error", (e: Event) => {
			errors.push((e as CustomEvent).detail);
		});

		await el.ask("q");
		el.approvePlan();
		await el.__lastExecution;

		// Only the first step's progress should have fired.
		expect(progress.map((p) => p.stepId)).toEqual(["s1", "s1"]);
		expect(progress.at(-1)?.status).toBe("fail");
		expect(progress.at(-1)?.error).toContain("engine offline");
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toContain("engine offline");
	});

	it("rejects pre-approval if any sql step fails the §4 validator", async () => {
		const { el } = mount();
		el.__setLlmCall(
			vi.fn().mockResolvedValue({
				...fourStepPlan,
				steps: [
					{
						id: "s1",
						tool: "sql",
						args: { query: "DROP TABLE points" },
						output_var: "x",
						why: "bad",
					},
					{
						id: "s2",
						tool: "render.summary",
						args: { text: "never" },
						why: "final",
					},
				],
			}),
		);
		const errors: Array<{ message: string; code?: string }> = [];
		el.shadowRoot?.host.addEventListener("error", (e: Event) => {
			errors.push((e as CustomEvent).detail);
		});

		await el.ask("q");
		el.approvePlan();
		await el.__lastExecution;
		expect(errors.length).toBeGreaterThanOrEqual(1);
		expect(errors[0]?.message).toMatch(/forbidden keyword|drop/i);
	});

	it("headless mode: no result-canvas mounts; result events still fire", async () => {
		const { el } = mount();
		el.setAttribute("mode", "headless");
		(el as unknown as { _execDatasets: unknown[] })._execDatasets = [
			{
				name: "points",
				tableName: "points",
				geomView: "points_geom",
				hasGeometry: true,
			},
		];
		const results: unknown[] = [];
		el.shadowRoot?.host.addEventListener("result", (e: Event) => {
			results.push((e as CustomEvent).detail);
		});

		await el.ask("q");
		el.approvePlan();
		await el.__lastExecution;

		expect(results).toHaveLength(1);
		expect(el.shadowRoot?.querySelector("result-canvas")).toBeNull();
	});

	it("full mode: a result-canvas mounts and receives the summary payload", async () => {
		const { el } = mount();
		(el as unknown as { _execDatasets: unknown[] })._execDatasets = [
			{
				name: "points",
				tableName: "points",
				geomView: "points_geom",
				hasGeometry: true,
			},
		];
		await el.ask("q");
		el.approvePlan();
		await el.__lastExecution;

		interface Turn {
			results: Array<{ kind: string; text?: string }>;
		}
		const canvas = el.shadowRoot?.querySelector("result-canvas") as
			| (HTMLElement & { updateComplete: Promise<unknown>; _turns: Turn[] })
			| null;
		expect(canvas).not.toBeNull();
		await canvas?.updateComplete;
		// Internal state captured via setResult(); proves the executor →
		// element → canvas wiring without depending on happy-dom shadow text.
		const allResults = canvas?._turns.flatMap((t) => t.results);
		const summary = allResults.find((r) => r.kind === "summary");
		expect(summary).toMatchObject({
			kind: "summary",
			text: expect.stringContaining("3 points"),
		});
	});
});
