import { tableFromJSON } from "apache-arrow";
import { describe, expect, it } from "vitest";

import type { LoadResult } from "../src/data/contracts.js";
import { profileDataset } from "../src/data/profile/index.js";

function makeResult(
	rows: Record<string, unknown>[],
	geometry?: LoadResult["geometry"],
): LoadResult {
	return {
		name: "test",
		table: tableFromJSON(rows as Record<string, unknown>[]),
		source: "csv",
		filename: "test.csv",
		geometry,
	};
}

describe("profileDataset", () => {
	it("computes numeric stats (integer + float) and null counts", () => {
		const rows = [
			{ i: 1, f: 1.5 },
			{ i: 2, f: 2.5 },
			{ i: 3, f: 3.5 },
			{ i: 4, f: null },
			{ i: null, f: 4.5 },
		];
		const profile = profileDataset(makeResult(rows));
		expect(profile.rowCount).toBe(5);

		const i = profile.columns.find((c) => c.name === "i");
		expect(i).toBeDefined();
		expect(["integer", "float"]).toContain(i?.kind);
		expect(i?.nullCount).toBe(1);
		expect(i?.numeric).toBeDefined();
		expect(i?.numeric?.min).toBe(1);
		expect(i?.numeric?.max).toBe(4);
		expect(i?.numeric?.count).toBe(4);
		expect(i?.numeric?.mean).toBeCloseTo(2.5, 6);

		const f = profile.columns.find((c) => c.name === "f");
		expect(f).toBeDefined();
		expect(f?.kind).toBe("float");
		expect(f?.nullCount).toBe(1);
		expect(f?.numeric?.min).toBeCloseTo(1.5, 6);
		expect(f?.numeric?.max).toBeCloseTo(4.5, 6);
		expect(f?.numeric?.count).toBe(4);
		expect(f?.numeric?.mean).toBeCloseTo(3.0, 6);

		expect(profile.profileMs).toBeGreaterThanOrEqual(0);
	});

	it("builds top-K and distinct estimate for string columns", () => {
		const rows = [
			{ s: "a" },
			{ s: "a" },
			{ s: "a" },
			{ s: "b" },
			{ s: "b" },
			{ s: "c" },
			{ s: null },
		];
		const profile = profileDataset(makeResult(rows), { topK: 2 });
		const s = profile.columns.find((c) => c.name === "s");
		expect(s).toBeDefined();
		expect(s?.kind).toBe("string");
		expect(s?.nullCount).toBe(1);
		expect(s?.categorical).toBeDefined();
		expect(s?.categorical?.distinct).toBe(3);
		expect(s?.categorical?.top.length).toBeLessThanOrEqual(2);
		expect(s?.categorical?.top[0]).toEqual({ value: "a", count: 3 });
	});

	it("computes lonlat bbox with crsGuess wgs84", () => {
		const rows = [
			{ id: 1, lon: -82.0, lat: 29.0 },
			{ id: 2, lon: -83.5, lat: 30.5 },
			{ id: 3, lon: -81.0, lat: 28.0 },
		];
		const profile = profileDataset(
			makeResult(rows, { kind: "lonlat", lonColumn: "lon", latColumn: "lat" }),
		);
		expect(profile.geometry).toBeDefined();
		expect(profile.geometry?.encoding).toBe("lonlat");
		expect(profile.geometry?.crsGuess).toBe("wgs84");
		expect(profile.geometry?.sampledCount).toBe(3);
		expect(profile.geometry?.bbox).toEqual([-83.5, 28.0, -81.0, 30.5]);
	});

	it("computes geojson-string bbox and tolerates invalid JSON rows", () => {
		const rows = [
			{ geom: JSON.stringify({ type: "Point", coordinates: [-100, 40] }) },
			{ geom: "not-json" },
			{
				geom: JSON.stringify({
					type: "LineString",
					coordinates: [
						[-110, 35],
						[-90, 45],
					],
				}),
			},
			{
				geom: JSON.stringify({
					type: "Polygon",
					coordinates: [
						[
							[-95, 38],
							[-92, 38],
							[-92, 41],
							[-95, 41],
							[-95, 38],
						],
					],
				}),
			},
		];
		const profile = profileDataset(
			makeResult(rows, { kind: "geojson-string", column: "geom" }),
		);
		expect(profile.geometry).toBeDefined();
		expect(profile.geometry?.encoding).toBe("geojson-string");
		expect(profile.geometry?.bbox).toEqual([-110, 35, -90, 45]);
		expect(profile.geometry?.crsGuess).toBe("wgs84");
		// 3 valid geometries (the parse failure was skipped).
		expect(profile.geometry?.sampledCount).toBe(3);
	});

	it("flags out-of-range projected coordinates as crsGuess=projected", () => {
		const rows = [
			{
				geom: JSON.stringify({
					type: "Point",
					coordinates: [500_000, 4_500_000],
				}),
			},
			{
				geom: JSON.stringify({
					type: "Point",
					coordinates: [510_000, 4_510_000],
				}),
			},
		];
		const profile = profileDataset(
			makeResult(rows, { kind: "geojson-string", column: "geom" }),
		);
		expect(profile.geometry?.crsGuess).toBe("projected");
		expect(profile.geometry?.bbox).toEqual([
			500_000, 4_500_000, 510_000, 4_510_000,
		]);
	});

	it("counts nulls correctly across heterogeneous columns", () => {
		const rows = [
			{ a: 1, b: "x" },
			{ a: null, b: "y" },
			{ a: 3, b: null },
			{ a: null, b: null },
		];
		const profile = profileDataset(makeResult(rows));
		const a = profile.columns.find((c) => c.name === "a");
		const b = profile.columns.find((c) => c.name === "b");
		expect(a).toBeDefined();
		expect(b).toBeDefined();
		expect(a?.nullCount).toBe(2);
		expect(b?.nullCount).toBe(2);
	});

	it("reports profileMs >= 0", () => {
		const rows = [{ x: 1 }, { x: 2 }];
		const profile = profileDataset(makeResult(rows));
		expect(profile.profileMs).toBeGreaterThanOrEqual(0);
	});
});
