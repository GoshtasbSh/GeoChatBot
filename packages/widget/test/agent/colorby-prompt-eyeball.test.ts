/**
 * Eyeball-output companion to colorby-prompt-snapshot.test.ts — prints
 * the exact planner-facing dataset block + ranker output for 4
 * representative datasets, so a human can read what the LLM sees.
 *
 * Run: `pnpm --filter @geochatbot/widget exec vitest run test/agent/colorby-prompt-eyeball.test.ts --reporter=verbose`
 */

import { describe, it } from "vitest";
import {
	type DatasetProfile,
	rankColorByCandidates,
	renderDatasetsBlock,
} from "../../src/agent/prompts/builders.js";

const cases: Array<{ label: string; profile: DatasetProfile }> = [
	{
		label: "USER'S SURVEY CSV (messy categorical text)",
		profile: {
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
					samples: ["6116 Harvard Avenue", "6169 Cascade"],
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
				{ name: "date", type: "Utf8", cardinality: 3 },
				{ name: "Second attempt", type: "Utf8", cardinality: 2 },
				{ name: "Other notes:", type: "Utf8", cardinality: 6 },
			],
			sample: [],
		},
	},
	{
		label: "CLEAN STRUCTURED DATASET",
		profile: {
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
		},
	},
	{
		label: "NUMERIC CHOROPLETH DATASET",
		profile: {
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
		},
	},
	{
		label: "TRIVIAL DATASET (no good column)",
		profile: {
			name: "trivial",
			kind: "table",
			rows: 100,
			columns: [
				{ name: "id", type: "Int64", cardinality: 100 },
				{ name: "Address", type: "Utf8", cardinality: 100 },
			],
			sample: [],
		},
	},
];

describe("colorBy hint — what the LLM ACTUALLY sees (eyeball test)", () => {
	for (const { label, profile } of cases) {
		it(label, () => {
			console.log(
				`\n${"=".repeat(70)}\n${label}\n${"=".repeat(70)}\n${renderDatasetsBlock(
					[profile],
				)}\n\nRanker top 5:\n${JSON.stringify(rankColorByCandidates(profile).slice(0, 5), null, 2)}\n`,
			);
		});
	}
});
