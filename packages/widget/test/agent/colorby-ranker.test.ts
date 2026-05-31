/**
 * 2026-05-21 — colorBy suitability ranker.
 *
 * Companion to test/ui/mapview-legend.test.ts. Pins the deterministic
 * "which column should the planner color by?" scoring rubric so a weak
 * model can't pick the date column on a 6-row dataset just because
 * inspect.list_columns returned it first.
 */

import { describe, expect, it } from "vitest";
import {
	type DatasetProfile,
	rankColorByCandidates,
	scoreColorByCandidate,
} from "../../src/agent/prompts/builders.js";

describe("scoreColorByCandidate — string columns", () => {
	it("scores status-named low-card categorical at 3/3 and generic low-card at 2/3", () => {
		// Status-named takes the top tier exclusively so it beats a same-
		// cardinality column that isn't semantically a status (the
		// 2026-05-21 regression: a 3-value `date` was outranking a
		// 7-value `contact_status`).
		expect(
			scoreColorByCandidate({
				name: "status",
				type: "Utf8",
				cardinality: 6,
			}).score,
		).toBe(3);
		expect(
			scoreColorByCandidate({
				name: "species",
				type: "Utf8",
				cardinality: 3,
			}).score,
		).toBe(2);
	});

	it("scores high-cardinality free text at 1/3 (must bucket via SQL)", () => {
		const result = scoreColorByCandidate({
			name: "First attempt",
			type: "Utf8",
			cardinality: 150,
		});
		expect(result.score).toBe(1);
		expect(result.reason.toLowerCase()).toMatch(/bucket/);
	});

	it("bumps high-card to 2/3 when the name is a status-like signal", () => {
		expect(
			scoreColorByCandidate({
				name: "contact_status",
				type: "Utf8",
				cardinality: 150,
			}).score,
		).toBe(2);
	});

	it("scores binary categorical at 2/3", () => {
		expect(
			scoreColorByCandidate({
				name: "active",
				type: "Utf8",
				cardinality: 2,
			}).score,
		).toBe(2);
	});

	it("scores single-value column at 0/3", () => {
		expect(
			scoreColorByCandidate({
				name: "state",
				type: "Utf8",
				cardinality: 1,
			}).score,
		).toBe(0);
	});

	it("rejects ID-like unique-per-row columns at 0/3", () => {
		expect(
			scoreColorByCandidate({
				name: "row_id",
				type: "Utf8",
				cardinality: 500,
				rows: 500,
			}).score,
		).toBe(0);
		expect(
			scoreColorByCandidate({
				name: "uuid",
				type: "Utf8",
				cardinality: 1000,
				rows: 1000,
			}).score,
		).toBe(0);
	});
});

describe("scoreColorByCandidate — numeric columns", () => {
	it("scores continuous numeric (cardinality > 20) at 3/3", () => {
		const r = scoreColorByCandidate({
			name: "population",
			type: "Int32",
			cardinality: 500,
		});
		expect(r.score).toBe(3);
		expect(r.reason.toLowerCase()).toMatch(/choropleth|numeric/);
	});

	it("scores near-constant numeric at 1/3", () => {
		expect(
			scoreColorByCandidate({
				name: "version",
				type: "Int32",
				cardinality: 2,
			}).score,
		).toBe(1);
	});

	it("scores numeric with limited range (3-20) at 2/3", () => {
		expect(
			scoreColorByCandidate({
				name: "ward",
				type: "Int32",
				cardinality: 12,
			}).score,
		).toBe(2);
	});
});

describe("scoreColorByCandidate — types that must score 0", () => {
	it("rejects the geometry column", () => {
		expect(
			scoreColorByCandidate({
				name: "geom",
				type: "Binary",
				geometryColumn: "geom",
			}).score,
		).toBe(0);
	});

	it("rejects WKT-shaped strings (semantic hint)", () => {
		const r = scoreColorByCandidate({
			name: "wkt",
			type: "Utf8",
			cardinality: 100,
			samples: ["POINT(0 0)", "POINT(1 1)"],
		});
		expect(r.score).toBe(0);
	});

	it("rejects latitude / longitude name patterns", () => {
		expect(
			scoreColorByCandidate({
				name: "lat",
				type: "Float64",
				cardinality: 500,
			}).score,
		).toBe(0);
		expect(
			scoreColorByCandidate({
				name: "lon",
				type: "Float64",
				cardinality: 500,
			}).score,
		).toBe(0);
	});

	it("rejects street-address columns", () => {
		const r = scoreColorByCandidate({
			name: "Address",
			type: "Utf8",
			cardinality: 200,
			rows: 200,
			samples: ["123 Main St", "456 Elm Avenue"],
		});
		expect(r.score).toBe(0);
	});
});

describe("rankColorByCandidates — end-to-end on a survey-like profile", () => {
	it("picks the bucketed status column over messy text and sparse dates", () => {
		const profile: DatasetProfile = {
			name: "survey",
			kind: "layer",
			rows: 250,
			geometry: { kind: "point", column: "geom" },
			columns: [
				{ name: "geom", type: "Binary" },
				{ name: "Address", type: "Utf8", cardinality: 248 },
				{
					name: "First attempt",
					type: "Utf8",
					cardinality: 180,
				},
				{ name: "date", type: "Utf8", cardinality: 3 },
				{
					name: "contact_status",
					type: "Utf8",
					cardinality: 7,
				},
			],
			sample: [],
		};
		const ranked = rankColorByCandidates(profile);
		expect(ranked[0]?.name).toBe("contact_status");
		expect(ranked[0]?.score).toBe(3);
		// geom, Address, and the messy "First attempt" should NOT outrank it.
		const geomRank = ranked.findIndex((r) => r.name === "geom");
		expect(ranked[geomRank]?.score).toBe(0);
		const addressRank = ranked.findIndex((r) => r.name === "Address");
		expect(ranked[addressRank]?.score).toBe(0);
	});

	it("returns 0-score winner for a dataset with no good columns (signals 'ask user')", () => {
		const profile: DatasetProfile = {
			name: "trivial",
			kind: "table",
			rows: 100,
			columns: [
				{ name: "id", type: "Int64", cardinality: 100 },
				{ name: "Address", type: "Utf8", cardinality: 100 },
			],
			sample: [],
		};
		const ranked = rankColorByCandidates(profile);
		// id is named ID-like and is unique-per-row, Address is street-address — both 0.
		expect(ranked.every((r) => r.score === 0)).toBe(true);
	});
});
