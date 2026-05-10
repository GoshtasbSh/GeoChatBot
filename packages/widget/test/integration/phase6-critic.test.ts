import { type Table as ArrowTable, tableFromJSON } from "apache-arrow";
// @vitest-environment happy-dom
/**
 * Phase 6 — engineered failure → critic patches → recover within 2 retries.
 *
 * Each test simulates a real-shaped DuckDB error (bad column, missing CRS)
 * by stubbing the engine. The critic is stubbed via __setCritic so we can
 * deterministically assert recovery without making a network call.
 *
 * The executor wraps every `sql` tool body in:
 *   CREATE OR REPLACE TEMPORARY VIEW "gcb_sql_<stepId>_<n>" AS <query>
 * so the engine's `query()` receives the full CREATE VIEW statement.
 * Engineered-failure predicates test for substrings within that wrapper.
 */
import { describe, expect, it, vi } from "vitest";

import "../../src/element.js";
import "../../src/agent/tools/index.js";
import "../../src/agent/executor/runners/index.js";
import type { ExecutorEngine } from "../../src/agent/executor/types.js";
import type { Step } from "../../src/agent/types.js";

interface TestEl extends HTMLElement {
	__setLlmCall: (fn: (input: unknown) => Promise<unknown>) => void;
	__setExecutorEngine: (engine: ExecutorEngine) => void;
	__setCritic: (c: { diagnose: (ctx: unknown) => Promise<unknown> }) => void;
	__lastExecution?: Promise<void>;
	setProvider: (p: {
		name: string;
		apiKey: string;
		generate: () => Promise<unknown>;
	}) => void;
	pushData: (d: unknown) => Promise<void>;
	ask: (q: string) => Promise<void>;
	approvePlan: () => void;
	setAttribute: (n: string, v: string) => void;
	shadowRoot: ShadowRoot | null;
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

async function seed(el: TestEl): Promise<void> {
	await el.pushData({
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
	(el as unknown as { _execDatasets: unknown[] })._execDatasets = [
		{
			name: "points",
			tableName: "points",
			geomView: "points_geom",
			hasGeometry: true,
		},
	];
}

/* -------------------------------------------------------------------------- */
/* Case 1 — bad column name → patch → recover                                */
/* -------------------------------------------------------------------------- */

describe("Phase 6 — bad column name → patch → recover", () => {
	it("recovers within 2 retries when the critic patches the SQL", async () => {
		const el = mount();
		await seed(el);

		// The executor wraps the query body as:
		//   CREATE OR REPLACE TEMPORARY VIEW "gcb_sql_s1_1" AS SELECT bad_col FROM points_geom
		// So we test for `bad_col` anywhere in the SQL string to detect failure.
		let nthSql = 0;
		const engine: ExecutorEngine = {
			hasSpatial: true,
			query: async (sql: string): Promise<ArrowTable> => {
				if (/bad_col/.test(sql)) {
					nthSql++;
					throw new Error(
						'Binder Error: Referenced column "bad_col" not found in FROM clause',
					);
				}
				return tableFromJSON([{ value: 1 }]);
			},
		};
		el.__setExecutorEngine(engine);

		const goodPlan = {
			goal: "g",
			assumptions: [],
			dataset_refs: ["points"],
			steps: [
				{
					id: "s1",
					tool: "sql",
					args: { query: "SELECT bad_col FROM points_geom" },
					output_var: "a",
					why: "first try",
				},
				{
					id: "s2",
					tool: "render.summary",
					args: { text: "done" },
					why: "final",
				},
			],
		};
		el.__setLlmCall(vi.fn().mockResolvedValue(goodPlan));

		const patchedStep: Step = {
			id: "s1",
			tool: "sql",
			args: { query: "SELECT name FROM points_geom" },
			output_var: "a",
			why: "fixed column name",
		};
		el.__setCritic({
			diagnose: vi.fn().mockResolvedValue({ action: "patch", patchedStep }),
		});

		const errors: Array<{ message: string }> = [];
		const results: Array<{ kind: string }> = [];
		el.shadowRoot?.host.addEventListener("error", (e: Event) =>
			errors.push((e as CustomEvent).detail),
		);
		el.shadowRoot?.host.addEventListener("result", (e: Event) =>
			results.push((e as CustomEvent).detail),
		);

		await el.ask("q");
		el.approvePlan();
		await el.__lastExecution;

		expect(errors).toEqual([]);
		expect(nthSql).toBe(1); // bad_col path hit exactly once before patch
		expect(results).toHaveLength(1);
		expect(results[0]?.kind).toBe("summary");
	});
});

/* -------------------------------------------------------------------------- */
/* Case 2 — missing CRS → patch → recover                                    */
/* -------------------------------------------------------------------------- */

describe("Phase 6 — missing CRS → patch → recover", () => {
	it("recovers when the critic supplies a CRS-safe replacement query", async () => {
		const el = mount();
		await seed(el);

		// The plan's s1 SELECT uses "ST_Buffer" keyword to signal a spatial op
		// that requires a CRS. On the first attempt the engine throws; after
		// the critic patches the step to remove the ST_Buffer reference, the
		// second call succeeds.
		let s1Attempts = 0;
		el.__setExecutorEngine({
			hasSpatial: true,
			query: async (sql: string): Promise<ArrowTable> => {
				// The wrapped form includes "AS SELECT * FROM points_geom" (no
				// ST_Buffer in the raw query — we track attempts by counting
				// executions against the view). Both the bad and the patched query
				// are wrapped the same way; we distinguish by attempt count.
				if (/SELECT \* FROM points_geom/.test(sql)) {
					s1Attempts++;
					if (s1Attempts === 1) {
						throw new Error(
							"Spatial: source layer has no CRS; ST_Buffer requires SRID",
						);
					}
				}
				return tableFromJSON([{ ok: 1 }]);
			},
		});

		el.__setLlmCall(
			vi.fn().mockResolvedValue({
				goal: "g",
				assumptions: [],
				dataset_refs: ["points"],
				steps: [
					{
						id: "s1",
						tool: "sql",
						args: { query: "SELECT * FROM points_geom" },
						output_var: "a",
						why: "p",
					},
					{
						id: "s2",
						tool: "render.summary",
						args: { text: "done" },
						why: "final",
					},
				],
			}),
		);

		// Patched step uses a WHERE clause as a stand-in for "CRS-safe" query
		const patchedStep: Step = {
			id: "s1",
			tool: "sql",
			args: { query: "SELECT * FROM points_geom WHERE 1=1" },
			output_var: "a",
			why: "add CRS-safe filter",
		};
		el.__setCritic({
			diagnose: vi.fn().mockResolvedValue({ action: "patch", patchedStep }),
		});

		const errors: Array<{ message: string }> = [];
		el.shadowRoot?.host.addEventListener("error", (e: Event) =>
			errors.push((e as CustomEvent).detail),
		);

		await el.ask("q");
		el.approvePlan();
		await el.__lastExecution;

		expect(errors).toEqual([]);
	});
});

/* -------------------------------------------------------------------------- */
/* Case 3 — persistent failure → terminal error after retries                */
/* -------------------------------------------------------------------------- */

describe("Phase 6 — persistent failure → terminal error after retries", () => {
	it("surfaces the original error after maxRetries=2 of patch+retry", async () => {
		const el = mount();
		await seed(el);

		// Engine always fails whenever the SQL contains bad_col.
		el.__setExecutorEngine({
			hasSpatial: true,
			query: async (sql: string): Promise<ArrowTable> => {
				if (/bad_col/.test(sql)) {
					throw new Error('Binder Error: column "bad_col" not found');
				}
				return tableFromJSON([{ ok: 1 }]);
			},
		});

		el.__setLlmCall(
			vi.fn().mockResolvedValue({
				goal: "g",
				assumptions: [],
				dataset_refs: ["points"],
				steps: [
					{
						id: "s1",
						tool: "sql",
						args: { query: "SELECT bad_col FROM points_geom" },
						output_var: "a",
						why: "p",
					},
					{
						id: "s2",
						tool: "render.summary",
						args: { text: "done" },
						why: "final",
					},
				],
			}),
		);

		// Critic always patches with another query that still references bad_col
		// → persistent failure exhausts the retry budget.
		el.__setCritic({
			diagnose: vi.fn().mockImplementation(async () => ({
				action: "patch",
				patchedStep: {
					id: "s1",
					tool: "sql",
					args: { query: "SELECT bad_col, 1 FROM points_geom" },
					output_var: "a",
					why: "still bad",
				},
			})),
		});

		const errors: Array<{ message: string }> = [];
		el.shadowRoot?.host.addEventListener("error", (e: Event) =>
			errors.push((e as CustomEvent).detail),
		);

		await el.ask("q");
		el.approvePlan();
		await el.__lastExecution;

		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toMatch(/bad_col/);
	});
});

/* -------------------------------------------------------------------------- */
/* Case 4 — critic event firing in headless mode                              */
/* -------------------------------------------------------------------------- */

describe("Phase 6 — critic event firing in headless mode", () => {
	it("emits a typed critic event per attempt without mounting plan-review", async () => {
		const el = mount();
		el.setAttribute("mode", "headless");
		await seed(el);

		let n = 0;
		el.__setExecutorEngine({
			hasSpatial: true,
			query: async (sql: string): Promise<ArrowTable> => {
				if (/bad_col/.test(sql)) {
					n++;
					if (n === 1) throw new Error("column not found: bad_col");
				}
				return tableFromJSON([{ ok: 1 }]);
			},
		});

		el.__setLlmCall(
			vi.fn().mockResolvedValue({
				goal: "g",
				assumptions: [],
				dataset_refs: ["points"],
				steps: [
					{
						id: "s1",
						tool: "sql",
						args: { query: "SELECT bad_col FROM points_geom" },
						output_var: "a",
						why: "p",
					},
					{
						id: "s2",
						tool: "render.summary",
						args: { text: "done" },
						why: "final",
					},
				],
			}),
		);

		const patchedStep: Step = {
			id: "s1",
			tool: "sql",
			args: { query: "SELECT name FROM points_geom" },
			output_var: "a",
			why: "fix",
		};
		el.__setCritic({
			diagnose: vi.fn().mockResolvedValue({ action: "patch", patchedStep }),
		});

		const critics: Array<{
			stepId: string;
			decision: string;
			attempt: number;
		}> = [];
		el.shadowRoot?.host.addEventListener("critic", (e: Event) =>
			critics.push((e as CustomEvent).detail),
		);

		await el.ask("q");
		el.approvePlan();
		await el.__lastExecution;

		expect(critics).toHaveLength(1);
		expect(critics[0]).toMatchObject({
			stepId: "s1",
			decision: "patch",
			attempt: 1,
		});
		// Headless mode: no plan-review should be mounted.
		expect(el.shadowRoot?.querySelector("plan-review")).toBeNull();
	});
});

/* -------------------------------------------------------------------------- */
/* Case 5 — abort decision shows a clean error and halts                      */
/* -------------------------------------------------------------------------- */

describe("Phase 6 — abort decision shows a clean error and halts", () => {
	it("does NOT retry when the critic returns abort", async () => {
		const el = mount();
		await seed(el);

		let attempts = 0;
		el.__setExecutorEngine({
			hasSpatial: true,
			query: async (): Promise<ArrowTable> => {
				attempts++;
				throw new Error("persistent failure");
			},
		});

		el.__setLlmCall(
			vi.fn().mockResolvedValue({
				goal: "g",
				assumptions: [],
				dataset_refs: ["points"],
				steps: [
					{
						id: "s1",
						tool: "sql",
						args: { query: "SELECT 1 FROM points_geom" },
						output_var: "a",
						why: "p",
					},
					{
						id: "s2",
						tool: "render.summary",
						args: { text: "done" },
						why: "final",
					},
				],
			}),
		);

		// Critic immediately aborts on first failure — no retry allowed.
		el.__setCritic({
			diagnose: vi.fn().mockResolvedValue({ action: "abort" }),
		});

		const errors: Array<{ message: string }> = [];
		el.shadowRoot?.host.addEventListener("error", (e: Event) =>
			errors.push((e as CustomEvent).detail),
		);

		await el.ask("q");
		el.approvePlan();
		await el.__lastExecution;

		expect(errors).toHaveLength(1);
		// Engine query called exactly once — abort prevents any retry.
		expect(attempts).toBe(1);
	});
});

/* -------------------------------------------------------------------------- */
/* Case 6 — plan-review shows critic patch line in full mode                  */
/* -------------------------------------------------------------------------- */

describe("Phase 6 — plan-review shows critic patch line in full mode", () => {
	it("populates criticPatches on plan-review when a patch decision is returned", async () => {
		const el = mount();
		await seed(el);

		let n = 0;
		el.__setExecutorEngine({
			hasSpatial: true,
			query: async (sql: string): Promise<ArrowTable> => {
				if (/bad_col/.test(sql)) {
					n++;
					if (n === 1) throw new Error("column missing");
				}
				return tableFromJSON([{ ok: 1 }]);
			},
		});

		el.__setLlmCall(
			vi.fn().mockResolvedValue({
				goal: "g",
				assumptions: [],
				dataset_refs: ["points"],
				steps: [
					{
						id: "s1",
						tool: "sql",
						args: { query: "SELECT bad_col FROM points_geom" },
						output_var: "a",
						why: "p",
					},
					{
						id: "s2",
						tool: "render.summary",
						args: { text: "done" },
						why: "final",
					},
				],
			}),
		);

		const patchedStep: Step = {
			id: "s1",
			tool: "sql",
			args: { query: "SELECT name FROM points_geom" },
			output_var: "a",
			why: "critic patched: typo in column name",
		};
		el.__setCritic({
			diagnose: vi.fn().mockResolvedValue({ action: "patch", patchedStep }),
		});

		await el.ask("q");
		el.approvePlan();
		await el.__lastExecution;

		const pr = el.shadowRoot?.querySelector("plan-review") as
			| (HTMLElement & {
					criticPatches?: Map<string, Step>;
					criticAttempts?: Map<string, Array<unknown>>;
			  })
			| null;
		expect(pr).not.toBeNull();
		expect(pr?.criticPatches?.get("s1")).toMatchObject({
			why: expect.stringContaining("typo"),
		});
		expect(pr?.criticAttempts?.get("s1")).toHaveLength(1);
	});
});
