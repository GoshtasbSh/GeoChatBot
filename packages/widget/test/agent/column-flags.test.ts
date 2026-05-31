/**
 * Column quality flags surfaced to the planner.
 *
 * Two cheap, high-value EDA traps (research: data-science-agent survey,
 * PV-SQL):
 *  - a CONSTANT column (1 distinct value) must not be used to color/group —
 *    it produces a one-color map / single-bucket chart;
 *  - a numeric column that is really a CATEGORICAL CODE (few distinct values,
 *    e.g. 0/1 flags, FIPS, zip-as-int) must not be averaged/summed as a
 *    measure.
 */

import { describe, expect, it } from "vitest";
import { detectColumnFlags } from "../../src/agent/profile/column-flags.js";

describe("detectColumnFlags — constant", () => {
	it("flags a single-distinct-value column as constant", () => {
		expect(
			detectColumnFlags({ type: "VARCHAR", cardinality: 1, nonNullCount: 40 })
				.constant,
		).toBe(true);
	});
	it("does not flag a multi-value column", () => {
		expect(
			detectColumnFlags({ type: "VARCHAR", cardinality: 6, nonNullCount: 40 })
				.constant,
		).toBe(false);
	});
});

describe("detectColumnFlags — categorical-disguised-as-numeric", () => {
	it("flags an integer column with very few distinct values over many rows", () => {
		// e.g. a 0/1 flag across 500 rows
		expect(
			detectColumnFlags({ type: "BIGINT", cardinality: 2, nonNullCount: 500 })
				.categoricalNumeric,
		).toBe(true);
	});
	it("does NOT flag a genuine continuous measure", () => {
		// revenue: 480 distinct values over 500 rows
		expect(
			detectColumnFlags({ type: "DOUBLE", cardinality: 480, nonNullCount: 500 })
				.categoricalNumeric,
		).toBe(false);
	});
	it("does NOT flag a small dataset where low distinct is expected", () => {
		// 8 distinct over 10 rows — not enough rows to conclude it's a code
		expect(
			detectColumnFlags({ type: "INTEGER", cardinality: 8, nonNullCount: 10 })
				.categoricalNumeric,
		).toBe(false);
	});
	it("never flags a string column as categoricalNumeric", () => {
		expect(
			detectColumnFlags({ type: "VARCHAR", cardinality: 2, nonNullCount: 500 })
				.categoricalNumeric,
		).toBe(false);
	});
});

describe("detectColumnFlags — missing data", () => {
	it("returns all-false when cardinality is unknown", () => {
		const f = detectColumnFlags({ type: "INTEGER", nonNullCount: 100 });
		expect(f.constant).toBe(false);
		expect(f.categoricalNumeric).toBe(false);
	});
});
