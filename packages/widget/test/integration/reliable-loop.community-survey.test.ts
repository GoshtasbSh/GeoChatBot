/**
 * End-to-end regression test: community_survey_raw.csv → profile → bucketize → legend.
 *
 * This test drives the REAL messy survey CSV through the units fixed on the
 * feat/reliable-agentic-loop branch and asserts a sane outcome. It would have
 * caught the two bugs that prompted this branch:
 *   1. Geocoding produced 0 points (Address column not detected as "address").
 *   2. Color-by collapsed all 317 points to one color (First attempt was not
 *      bucketed, raw high-cardinality text → degenerate legend).
 *
 * NO network, NO DuckDB — all pure unit composition.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { bucketLabel } from "../../src/agent/executor/runners/bucketize.js";
import { augmentProfile } from "../../src/agent/profile/augment.js";
import type { DatasetProfile } from "../../src/agent/prompts/builders.js";
import { computeLegend } from "../../src/ui/MapView.js";

/* -------------------------------------------------------------------------- */
/* Minimal RFC-4180-compliant CSV parser (handles quoted fields with commas). */
/* -------------------------------------------------------------------------- */

function parseCSV(text: string): string[][] {
	const rows: string[][] = [];
	const lines = text.split(/\r?\n/);
	for (const line of lines) {
		if (line.trim() === "") continue;
		const fields: string[] = [];
		let inQuotes = false;
		let cur = "";
		for (let i = 0; i < line.length; i++) {
			const ch = line[i] as string;
			if (inQuotes) {
				if (ch === '"') {
					// Peek for escaped quote
					if (i + 1 < line.length && line[i + 1] === '"') {
						cur += '"';
						i++;
					} else {
						inQuotes = false;
					}
				} else {
					cur += ch;
				}
			} else {
				if (ch === '"') {
					inQuotes = true;
				} else if (ch === ",") {
					fields.push(cur.trim());
					cur = "";
				} else {
					cur += ch;
				}
			}
		}
		fields.push(cur.trim());
		rows.push(fields);
	}
	return rows;
}

/* -------------------------------------------------------------------------- */
/* Load + parse the real CSV once.                                             */
/* -------------------------------------------------------------------------- */

const csvText = readFileSync(
	resolve(__dirname, "../../public/community_survey_raw.csv"),
	"utf8",
);

const allRows = parseCSV(csvText);
// First row is the header
const [headerRow, ...dataRows] = allRows;
const headers = (headerRow ?? []).map((h) => h.trim());

// Column indices
const addrIdx = headers.indexOf("Address");
const firstAttemptIdx = headers.indexOf("First attempt");

/* -------------------------------------------------------------------------- */
/* Test A — augmentProfile detects Address role and First attempt bucketing   */
/* -------------------------------------------------------------------------- */

describe("Test A — DatasetProfile augmentation on community_survey_raw.csv", () => {
	it("parses the expected number of data rows", () => {
		// Header is 1 row, 317 data rows expected
		expect(dataRows.length).toBeGreaterThanOrEqual(300);
	});

	it("Address column gets role='address'", () => {
		// Build DatasetProfile for the real CSV
		const rowCount = dataRows.length;

		const colProfiles = headers.map((name) => {
			const colIdx = headers.indexOf(name);
			const values = dataRows
				.map((r) => (r[colIdx] ?? "").trim())
				.filter((v) => v.length > 0);
			const distinct = new Set(values);
			const samples = [...distinct].slice(0, 3);
			return {
				name,
				type: "string" as const,
				cardinality: distinct.size,
				nulls: rowCount - values.length,
				samples,
			};
		});

		const profile: DatasetProfile = {
			name: "community_survey_raw",
			kind: "table",
			rows: rowCount,
			sample: [],
			columns: colProfiles,
		};

		const augmented = augmentProfile(profile);

		const addrCol = augmented.columns.find((c) => c.name === "Address");
		const firstAttemptCol = augmented.columns.find(
			(c) => c.name === "First attempt",
		);

		// Verify Address column is detected as address role
		expect(addrCol?.role).toBe("address");

		// Verify First attempt column has needsBucketing = true
		// (high cardinality free-text → distinctRatio > 0.5 → free_text_category)
		expect(firstAttemptCol?.needsBucketing).toBe(true);
		expect(firstAttemptCol?.role).toBe("free_text_category");
	});
});

/* -------------------------------------------------------------------------- */
/* Test B — bucketize + non-degenerate color legend                           */
/* -------------------------------------------------------------------------- */

describe("Test B — bucketLabel produces variety; computeLegend is non-degenerate", () => {
	it("produces >= 5 distinct bucket labels across the dataset", () => {
		const buckets = dataRows.map((row) => {
			const rawVal = (row[firstAttemptIdx] ?? "").trim();
			return bucketLabel(rawVal);
		});

		const distinctBuckets = new Set(buckets);
		// We expect at least: completed, refused, inaccessible, no answer, other
		expect(distinctBuckets.size).toBeGreaterThanOrEqual(5);
	});

	it("computeLegend has distinct swatches and no degeneracy warning", () => {
		const features = dataRows.map((row, i) => {
			const rawVal = (row[firstAttemptIdx] ?? "").trim();
			const bucket = bucketLabel(rawVal);
			return {
				type: "Feature" as const,
				properties: { status: bucket },
				geometry: {
					type: "Point" as const,
					// Unique fake coordinates so each point is distinct
					coordinates: [-82 + i * 1e-4, 29.78 + i * 1e-4],
				},
			};
		}) as unknown as GeoJSON.Feature[];

		const spec = computeLegend(features, {
			colorBy: "status",
			classification: "categorical",
		});

		// Distinct swatches — at least 3 (completed / no answer / other)
		const swatchKeys = new Set(spec.entries.map((e) => e.swatch.join(",")));
		expect(swatchKeys.size).toBeGreaterThanOrEqual(3);

		// No degeneracy warning (breakdown is healthy)
		expect(spec.warning).toBeUndefined();
	});
});
