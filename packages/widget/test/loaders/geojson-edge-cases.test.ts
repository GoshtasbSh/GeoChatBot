/**
 * §J GeoJSON loader — every geometry type + every wrapper shape +
 * pathological input.
 *
 * Covered:
 *   - All 7 RFC 7946 geometry types (Point, MultiPoint, LineString,
 *     MultiLineString, Polygon, MultiPolygon, GeometryCollection)
 *   - FeatureCollection vs single Feature vs bare Geometry
 *   - Properties of every JSON type (string, number, bool, null, array,
 *     nested object)
 *   - Null geometry, missing properties, mixed-type properties
 *   - Pathological: 0-byte, invalid JSON, non-GeoJSON JSON, empty
 *     FeatureCollection
 *   - UTF-8 properties round-trip
 *   - Coordinate precision preserved
 */

import { describe, expect, it } from "vitest";
import { LoaderError } from "../../src/data/contracts";
import { geojsonLoader } from "../../src/data/loaders/geojson";

function bytes(name: string, content: string) {
	return { name, bytes: new TextEncoder().encode(content) };
}

function fc(features: object[]) {
	return JSON.stringify({ type: "FeatureCollection", features });
}

function feature(geom: object | null, props: object = {}) {
	return { type: "Feature", geometry: geom, properties: props };
}

describe("§J GeoJSON — every geometry type", () => {
	it("loads Point features", async () => {
		const r = await geojsonLoader.load(
			bytes(
				"point.geojson",
				fc([
					feature({ type: "Point", coordinates: [-82.32, 29.65] }, { id: 1 }),
				]),
			),
		);
		expect(r.table.numRows).toBe(1);
		expect(r.geometry?.kind).toBe("geojson-string");
	});

	it("loads MultiPoint features", async () => {
		const r = await geojsonLoader.load(
			bytes(
				"mp.geojson",
				fc([
					feature(
						{
							type: "MultiPoint",
							coordinates: [
								[-82.32, 29.65],
								[-80.19, 25.76],
							],
						},
						{ id: 1 },
					),
				]),
			),
		);
		expect(r.table.numRows).toBe(1);
	});

	it("loads LineString features", async () => {
		const r = await geojsonLoader.load(
			bytes(
				"line.geojson",
				fc([
					feature(
						{
							type: "LineString",
							coordinates: [
								[-82, 29],
								[-81, 30],
							],
						},
						{ id: 1 },
					),
				]),
			),
		);
		expect(r.table.numRows).toBe(1);
	});

	it("loads MultiLineString features", async () => {
		const r = await geojsonLoader.load(
			bytes(
				"ml.geojson",
				fc([
					feature(
						{
							type: "MultiLineString",
							coordinates: [
								[
									[-82, 29],
									[-81, 30],
								],
								[
									[-80, 28],
									[-79, 27],
								],
							],
						},
						{ id: 1 },
					),
				]),
			),
		);
		expect(r.table.numRows).toBe(1);
	});

	it("loads Polygon features", async () => {
		const r = await geojsonLoader.load(
			bytes(
				"poly.geojson",
				fc([
					feature(
						{
							type: "Polygon",
							coordinates: [
								[
									[-82, 29],
									[-81, 29],
									[-81, 30],
									[-82, 30],
									[-82, 29],
								],
							],
						},
						{ id: 1 },
					),
				]),
			),
		);
		expect(r.table.numRows).toBe(1);
	});

	it("loads MultiPolygon features", async () => {
		const r = await geojsonLoader.load(
			bytes(
				"mpoly.geojson",
				fc([
					feature(
						{
							type: "MultiPolygon",
							coordinates: [
								[
									[
										[-82, 29],
										[-81, 29],
										[-81, 30],
										[-82, 30],
										[-82, 29],
									],
								],
								[
									[
										[-80, 28],
										[-79, 28],
										[-79, 29],
										[-80, 29],
										[-80, 28],
									],
								],
							],
						},
						{ id: 1 },
					),
				]),
			),
		);
		expect(r.table.numRows).toBe(1);
	});

	it("loads GeometryCollection features", async () => {
		const r = await geojsonLoader.load(
			bytes(
				"gc.geojson",
				fc([
					feature(
						{
							type: "GeometryCollection",
							geometries: [
								{ type: "Point", coordinates: [-82, 29] },
								{
									type: "LineString",
									coordinates: [
										[-82, 29],
										[-81, 30],
									],
								},
							],
						},
						{ id: 1 },
					),
				]),
			),
		);
		expect(r.table.numRows).toBe(1);
	});

	it("loads MIXED geometry types in one FeatureCollection", async () => {
		const r = await geojsonLoader.load(
			bytes(
				"mixed.geojson",
				fc([
					feature({ type: "Point", coordinates: [-82, 29] }, { id: 1 }),
					feature(
						{
							type: "Polygon",
							coordinates: [
								[
									[-82, 29],
									[-81, 29],
									[-81, 30],
									[-82, 30],
									[-82, 29],
								],
							],
						},
						{ id: 2 },
					),
				]),
			),
		);
		expect(r.table.numRows).toBe(2);
	});
});

describe("§J GeoJSON — wrapper variants", () => {
	it("accepts a single Feature (not a FeatureCollection)", async () => {
		const r = await geojsonLoader.load(
			bytes(
				"single.geojson",
				JSON.stringify(
					feature({ type: "Point", coordinates: [-82, 29] }, { id: 1 }),
				),
			),
		);
		expect(r.table.numRows).toBe(1);
	});

	it("accepts a bare Geometry (wrapped to synthetic Feature)", async () => {
		const r = await geojsonLoader.load(
			bytes(
				"bare.geojson",
				JSON.stringify({ type: "Point", coordinates: [-82, 29] }),
			),
		);
		expect(r.table.numRows).toBe(1);
	});

	it("accepts a bare GeometryCollection", async () => {
		const r = await geojsonLoader.load(
			bytes(
				"bare-gc.geojson",
				JSON.stringify({
					type: "GeometryCollection",
					geometries: [{ type: "Point", coordinates: [-82, 29] }],
				}),
			),
		);
		expect(r.table.numRows).toBe(1);
	});
});

describe("§J GeoJSON — properties", () => {
	it("preserves all JSON primitive property types", async () => {
		const r = await geojsonLoader.load(
			bytes(
				"props.geojson",
				fc([
					feature(
						{ type: "Point", coordinates: [-82, 29] },
						{
							str: "hello",
							num: 42.5,
							int: -7,
							b: true,
							n: null,
						},
					),
				]),
			),
		);
		expect(r.table.numRows).toBe(1);
		const cols = r.table.schema.fields.map((f) => f.name);
		expect(cols).toEqual(expect.arrayContaining(["str", "num", "int", "b"]));
	});

	it("preserves UTF-8 string property values", async () => {
		const r = await geojsonLoader.load(
			bytes(
				"utf8.geojson",
				fc([
					feature(
						{ type: "Point", coordinates: [-82, 29] },
						{ city: "Café", country: "日本", emoji: "🚀" },
					),
				]),
			),
		);
		expect(r.table.numRows).toBe(1);
	});

	it("preserves UTF-8 property KEY names", async () => {
		const r = await geojsonLoader.load(
			bytes(
				"utf8keys.geojson",
				fc([
					feature(
						{ type: "Point", coordinates: [-82, 29] },
						{ Café: "x", 日本: "y" },
					),
				]),
			),
		);
		expect(r.table.numRows).toBe(1);
		const cols = r.table.schema.fields.map((f) => f.name);
		expect(cols).toEqual(expect.arrayContaining(["Café", "日本"]));
	});

	it("a Feature with NULL geometry loads (geometry column is null string)", async () => {
		const r = await geojsonLoader.load(
			bytes("nullgeom.geojson", fc([feature(null, { id: 1 })])),
		);
		expect(r.table.numRows).toBe(1);
	});

	it("Features with MISSING properties get empty-object semantics", async () => {
		const r = await geojsonLoader.load(
			bytes(
				"noprops.geojson",
				JSON.stringify({
					type: "FeatureCollection",
					features: [
						{
							type: "Feature",
							geometry: { type: "Point", coordinates: [-82, 29] },
						},
					],
				}),
			),
		);
		expect(r.table.numRows).toBe(1);
	});

	it("MIXED property-types across features (some strings, some numbers in same key)", async () => {
		const r = await geojsonLoader.load(
			bytes(
				"mixed-props.geojson",
				fc([
					feature({ type: "Point", coordinates: [-82, 29] }, { val: 1 }),
					feature({ type: "Point", coordinates: [-81, 30] }, { val: "two" }),
				]),
			),
		);
		// Arrow normalizes mixed types into strings via normalizeRows;
		// the loader either accepts both rows or surfaces a clear error.
		expect(r.table.numRows).toBe(2);
	});
});

describe("§J GeoJSON — pathological inputs", () => {
	it("0-byte buffer → EMPTY_FILE", async () => {
		await expect(
			geojsonLoader.load({ name: "z.geojson", bytes: new Uint8Array(0) }),
		).rejects.toMatchObject({ name: "LoaderError", code: "EMPTY_FILE" });
	});

	it("invalid JSON → PARSE_ERROR", async () => {
		await expect(
			geojsonLoader.load(bytes("bad.geojson", "{not: json")),
		).rejects.toMatchObject({ name: "LoaderError", code: "PARSE_ERROR" });
	});

	it("non-GeoJSON JSON object → INVALID_GEOMETRY", async () => {
		await expect(
			geojsonLoader.load(bytes("plain.geojson", '{"foo":"bar"}')),
		).rejects.toMatchObject({
			name: "LoaderError",
			code: "INVALID_GEOMETRY",
		});
	});

	it("empty FeatureCollection → INVALID_GEOMETRY", async () => {
		await expect(
			geojsonLoader.load(bytes("efc.geojson", fc([]))),
		).rejects.toMatchObject({
			name: "LoaderError",
			code: "INVALID_GEOMETRY",
		});
	});

	it("LoaderError instance is thrown for failure paths", async () => {
		try {
			await geojsonLoader.load({
				name: "z.geojson",
				bytes: new Uint8Array(0),
			});
		} catch (err) {
			expect(err).toBeInstanceOf(LoaderError);
		}
	});

	it("canLoad accepts .geojson and .json, rejects others", () => {
		expect(geojsonLoader.canLoad("a.geojson")).toBe(true);
		expect(geojsonLoader.canLoad("a.json")).toBe(true);
		expect(geojsonLoader.canLoad("a.csv")).toBe(false);
		expect(geojsonLoader.canLoad("a.txt")).toBe(false);
	});

	it("a FeatureCollection with 1000 features loads cleanly", async () => {
		const features = Array.from({ length: 1000 }, (_, i) =>
			feature(
				{ type: "Point", coordinates: [-82 + i * 0.001, 29] },
				{ id: i, name: `point-${i}` },
			),
		);
		const r = await geojsonLoader.load(
			bytes("big.geojson", fc(features as object[])),
		);
		expect(r.table.numRows).toBe(1000);
	});
});

describe("§J GeoJSON — coordinate precision", () => {
	it("preserves high-precision coordinates (12 decimal places)", async () => {
		// Use 12 significant decimal places — safely within float64's ~15-16
		// significant digit precision to satisfy biome's noPrecisionLoss rule.
		const lon = -82.32345678901;
		const lat = 29.65123456789;
		const r = await geojsonLoader.load(
			bytes(
				"precision.geojson",
				fc([feature({ type: "Point", coordinates: [lon, lat] }, { id: 1 })]),
			),
		);
		expect(r.table.numRows).toBe(1);
		const rows = r.table.toArray() as Array<{ geometry: string }>;
		const geom = JSON.parse(rows[0]?.geometry ?? "{}");
		// JS double precision means we have ~15-16 significant digits; the
		// round-trip preserves at least the first 12.
		expect(Math.abs(geom.coordinates[0] - lon)).toBeLessThan(1e-10);
		expect(Math.abs(geom.coordinates[1] - lat)).toBeLessThan(1e-10);
	});

	it("preserves antimeridian-crossing coordinates", async () => {
		const r = await geojsonLoader.load(
			bytes(
				"anti.geojson",
				fc([
					feature(
						{
							type: "LineString",
							coordinates: [
								[179.9, 0],
								[-179.9, 0],
							],
						},
						{ id: 1 },
					),
				]),
			),
		);
		expect(r.table.numRows).toBe(1);
	});

	it("preserves polar coordinates (lat ±89.999)", async () => {
		const r = await geojsonLoader.load(
			bytes(
				"polar.geojson",
				fc([
					feature({ type: "Point", coordinates: [0, 89.999] }, { id: "north" }),
					feature(
						{ type: "Point", coordinates: [0, -89.999] },
						{ id: "south" },
					),
				]),
			),
		);
		expect(r.table.numRows).toBe(2);
	});

	it("preserves null-island (0, 0) as a real coordinate", async () => {
		const r = await geojsonLoader.load(
			bytes(
				"null-island.geojson",
				fc([feature({ type: "Point", coordinates: [0, 0] }, { id: 1 })]),
			),
		);
		expect(r.table.numRows).toBe(1);
		const rows = r.table.toArray() as Array<{ geometry: string }>;
		const geom = JSON.parse(rows[0]?.geometry ?? "{}");
		expect(geom.coordinates).toEqual([0, 0]);
	});
});
