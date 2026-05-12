/**
 * Tests for the report.quickscan runner. The runner is deterministic
 * (no LLM, no network) so we drive it with a SpyEngine that returns
 * scripted Arrow tables for each SQL it's asked.
 */

import { type Table as ArrowTable, tableFromJSON } from "apache-arrow";
import { beforeEach, describe, expect, it } from "vitest";

import "../../../src/agent/executor/runners/index.js";
import { Executor } from "../../../src/agent/executor/executor.js";
import type {
	DatasetEntry,
	ExecutorEngine,
	ResultEvent,
	ResultPayload,
} from "../../../src/agent/executor/types.js";
import type { Plan } from "../../../src/agent/types.js";

/**
 * Scripted spy: each call to `query` consumes the next entry from
 * `responses`. If we run out, fall back to a generic stub. We don't
 * pattern-match on the SQL itself because the runner emits ~7 SQL
 * statements in order and we care about the high-level report shape,
 * not the exact text of each query.
 */
class ScriptedEngine implements ExecutorEngine {
	hasSpatial = true;
	public sqls: string[] = [];
	public responses: ArrowTable[] = [];
	private cursor = 0;
	async query(sql: string): Promise<ArrowTable> {
		this.sqls.push(sql);
		const next = this.responses[this.cursor++];
		return next ?? tableFromJSON([{}]);
	}
}

const sales: DatasetEntry = {
	name: "sales",
	tableName: "sales",
	hasGeometry: false,
};

async function runQuickscan(
	engine: ScriptedEngine,
	args: Record<string, unknown> = { dataset: "sales" },
): Promise<ResultPayload[]> {
	const plan: Plan = {
		goal: "scan",
		assumptions: [],
		dataset_refs: ["sales"],
		steps: [{ id: "s1", tool: "report.quickscan", args, why: "scan" }],
	};
	const exec = new Executor({ engine, datasets: [sales] });
	const payloads: ResultPayload[] = [];
	await exec.execute(plan, "pid", {
		onResult: (e: ResultEvent) => {
			const { planId, stepId, ...rest } = e;
			payloads.push(rest as ResultPayload);
		},
	});
	return payloads;
}

describe("runner: report.quickscan", () => {
	let engine: ScriptedEngine;
	beforeEach(() => {
		engine = new ScriptedEngine();
	});

	it("emits a render.summary payload with row/column counts", async () => {
		engine.responses = [
			// 1. row count
			tableFromJSON([{ n: 42 }]),
			// 2. pragma_table_info (schema)
			tableFromJSON([
				{ name: "price", type: "DOUBLE" },
				{ name: "region", type: "VARCHAR" },
			]),
			// 3. completeness (one SUM per column wrapped in a single SELECT)
			tableFromJSON([{ __null_price: 0, __null_region: 3 }]),
			// 4. sample rows (5)
			tableFromJSON([{ price: 100, region: "north" }]),
			// 5. numeric stats — price
			tableFromJSON([{ lo: 10, hi: 500, mu: 123.4, sd: 88.1 }]),
			// 6. spatial summary likely returns null because hasGeometry=false; runner
			//    may still attempt range queries on numeric cols — emit safe defaults.
			tableFromJSON([{ lo: 10, hi: 500 }]),
			// 7. dates — none, so this slot is unused; safety stub
			tableFromJSON([{}]),
			// 8. duplicates (single-row COUNT(*) - COUNT(DISTINCT …))
			tableFromJSON([{ dups: 0 }]),
		];
		const payloads = await runQuickscan(engine);
		expect(payloads).toHaveLength(1);
		const p = payloads[0];
		expect(p?.kind).toBe("summary");
		const text = (p as { kind: "summary"; text: string }).text;
		expect(text).toMatch(/Quick scan/);
		// Counts are wrapped in markdown bold: `**42** rows × **2** columns`.
		// Regex tolerates the asterisks rather than depending on a literal space.
		expect(text).toMatch(/42[^0-9a-z]*rows/i);
		expect(text).toMatch(/2[^0-9a-z]*columns/i);
		expect(text).toMatch(/Schema/);
		expect(text).toMatch(/price.*DOUBLE/);
		expect(text).toMatch(/region.*VARCHAR/);
	});

	it("includes completeness section with null percentages", async () => {
		engine.responses = [
			tableFromJSON([{ n: 100 }]),
			tableFromJSON([
				{ name: "a", type: "VARCHAR" },
				{ name: "b", type: "VARCHAR" },
			]),
			tableFromJSON([{ __null_a: 50, __null_b: 0 }]),
			tableFromJSON([{ a: "x", b: "y" }]),
			tableFromJSON([{ dups: 0 }]),
		];
		const payloads = await runQuickscan(engine);
		const text = (payloads[0] as { kind: "summary"; text: string }).text;
		expect(text).toMatch(/Completeness/);
		expect(text).toMatch(/50.*nulls.*50\.0%/);
		// 50% should be flagged with the warning glyph (>=50% threshold).
		expect(text).toMatch(/⚠️.*`a`/);
	});

	it("emits a non-empty plan that ends with report.quickscan as a valid last step", async () => {
		engine.responses = [tableFromJSON([{ n: 0 }])];
		const payloads = await runQuickscan(engine);
		// Even on a 0-row dataset, the runner emits one summary payload with
		// the "dataset is empty" verdict.
		expect(payloads).toHaveLength(1);
		const text = (payloads[0] as { kind: "summary"; text: string }).text;
		expect(text).toMatch(/Quick scan/);
		expect(text).toMatch(/0[^0-9a-z]*rows/i);
		expect(text).toMatch(/empty/i);
	});

	it("rejects an unknown dataset", async () => {
		const plan: Plan = {
			goal: "scan",
			assumptions: [],
			dataset_refs: [],
			steps: [
				{
					id: "s1",
					tool: "report.quickscan",
					args: { dataset: "nope" },
					why: "scan",
				},
			],
		};
		const exec = new Executor({ engine, datasets: [sales] });
		let errMsg = "";
		await exec.execute(plan, "pid", {
			onError: (e) => {
				errMsg = e.message;
			},
		});
		expect(errMsg).toMatch(/unknown layer|unknown dataset|nope/i);
	});
});
