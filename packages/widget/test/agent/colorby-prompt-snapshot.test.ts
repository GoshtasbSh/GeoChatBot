/**
 * Synthetic end-to-end verification of the planner-facing dataset block
 * for the 2026-05-21 colorBy fix.
 *
 * Why this exists: the user reported "color code" producing 2 groups on a
 * community-survey CSV. The fix relies on the LLM seeing the new
 * `colorBy:N/3` hints and the `best color-by candidates:` line. This test
 * pins what the LLM ACTUALLY sees for 4 representative dataset shapes:
 *
 *   1. Messy survey (user's actual CSV shape) → should rank a status-
 *      bucketed column above the sparse date column.
 *   2. Clean structured data → status column should win cleanly.
 *   3. Numeric choropleth dataset → a continuous numeric should win.
 *   4. Trivial dataset with no good column → ranker should report NONE
 *      so the planner asks the user.
 *
 * Plain unit tests on the ranker prove the rubric; this test proves the
 * rubric SHOWS UP in the planner-visible prompt text.
 */

import { describe, expect, it } from "vitest";
import {
	type DatasetProfile,
	rankColorByCandidates,
	renderDatasetsBlock,
} from "../../src/agent/prompts/builders.js";

const survey: DatasetProfile = {
	name: "survey",
	kind: "layer",
	rows: 250,
	geometry: { kind: "point", column: "geom" },
	columns: [
		{ name: "geom", type: "Binary" },
		{
			name: "Address",
			type: "Utf8",
			cardinality: 248,
			samples: ["6116 Harvard Avenue", "6169 Cascade", "6173 Harvard Avenue"],
		},
		{
			name: "First attempt",
			type: "Utf8",
			cardinality: 180,
			samples: [
				"Gated, inaccessible; left flier",
				"completed survey",
				"No one home; left flier",
			],
		},
		{
			name: "date",
			type: "Utf8",
			cardinality: 3,
			samples: ["1/17/2026", "1/28", "1/29"],
		},
		{ name: "Second attempt", type: "Utf8", cardinality: 2 },
		{ name: "Other notes:", type: "Utf8", cardinality: 6 },
	],
	sample: [],
};

const incidents: DatasetProfile = {
	name: "incidents",
	kind: "layer",
	rows: 500,
	geometry: { kind: "point", column: "geom" },
	columns: [
		{ name: "geom", type: "Binary" },
		{
			name: "status",
			type: "Utf8",
			cardinality: 5,
			samples: ["open", "closed", "pending"],
		},
		{ name: "severity", type: "Int32", cardinality: 4 },
		{ name: "reported_at", type: "Timestamp", cardinality: 480 },
	],
	sample: [],
};

const tracts: DatasetProfile = {
	name: "tracts",
	kind: "layer",
	rows: 800,
	geometry: { kind: "polygon", column: "geom" },
	columns: [
		{ name: "geom", type: "Binary" },
		{ name: "tract_id", type: "Utf8", cardinality: 800 },
		{ name: "median_hh_income", type: "Int32", cardinality: 750 },
		{ name: "pop_density", type: "Float64", cardinality: 800 },
	],
	sample: [],
};

const trivial: DatasetProfile = {
	name: "trivial",
	kind: "table",
	rows: 100,
	columns: [
		{ name: "id", type: "Int64", cardinality: 100 },
		{ name: "Address", type: "Utf8", cardinality: 100 },
	],
	sample: [],
};

describe("renderDatasetsBlock — colorBy hint visibility (2026-05-21)", () => {
	it("survey CSV: the prompt block flags `First attempt` as needing bucketing and surfaces top picks", () => {
		const block = renderDatasetsBlock([survey]);
		// `First attempt` must NOT be picked raw (the original bug).
		expect(block).toMatch(/First attempt:[^\n]+colorBy:1\/3[^\n]*bucket/i);
		// `date` is technically low-card but lacks a status-like name — it
		// must score 2/3, not 3/3, so a status-named column would beat it.
		expect(block).toMatch(/date:[^\n]+colorBy:2\/3/);
		// `Address` must be rejected.
		expect(block).toMatch(/Address:[^\n]+colorBy:0\/3/);
		// The summary line must appear so the planner sees the top picks.
		expect(block).toContain("best color-by candidates:");
	});

	it("survey CSV ranker output: top picks are not the address or unique ID columns", () => {
		const ranked = rankColorByCandidates(survey).slice(0, 3);
		// No 0-scored column may appear in top 3 of a real result.
		// (geom is 0, Address is 0; they must not be near the top.)
		expect(ranked.every((r) => r.score > 0)).toBe(true);
		expect(ranked.map((r) => r.name)).not.toContain("geom");
		expect(ranked.map((r) => r.name)).not.toContain("Address");
	});

	it("clean structured data: `status` wins the 3/3 tier", () => {
		const ranked = rankColorByCandidates(incidents);
		expect(ranked[0]?.name).toBe("status");
		expect(ranked[0]?.score).toBe(3);
	});

	it("numeric choropleth dataset: a continuous numeric is top-ranked", () => {
		const ranked = rankColorByCandidates(tracts);
		expect(ranked[0]?.score).toBe(3);
		// Either median_hh_income or pop_density wins — both are valid 3/3
		// candidates. tract_id is ID-like and must NOT be selected.
		expect(["median_hh_income", "pop_density"]).toContain(ranked[0]?.name);
		expect(ranked[0]?.name).not.toBe("tract_id");
	});

	it("trivial dataset with no good column: prompt block says NONE so planner asks user", () => {
		const block = renderDatasetsBlock([trivial]);
		expect(block).toContain("best color-by candidates: NONE");
		expect(block).toContain("ask the user");
	});
});
