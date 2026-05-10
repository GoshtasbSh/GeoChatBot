import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Table } from "apache-arrow";
import { describe, expect, it } from "vitest";
import { shapefileLoader } from "../../src/data/loaders/shapefile";

function fixture(name: string): { name: string; bytes: Uint8Array } {
	const buf = readFileSync(resolve(__dirname, "..", "fixtures", name));
	return { name, bytes: new Uint8Array(buf) };
}

describe("shapefileLoader", () => {
	it("loads points.shp.zip into an Arrow table with geojson-string geometry", async () => {
		const result = await shapefileLoader.load(fixture("points.shp.zip"));
		expect(result.table).toBeInstanceOf(Table);
		expect(result.table.numRows).toBe(5);
		expect(result.source).toBe("shapefile");
		expect(result.geometry).toEqual({
			kind: "geojson-string",
			column: "geometry",
		});

		const cols = result.table.schema.fields.map((f) => f.name);
		expect(cols).toContain("geometry");

		const first = result.table.getChild("geometry")?.get(0);
		expect(typeof first).toBe("string");
		const parsed = JSON.parse(first as string);
		expect(parsed.type).toBe("Point");
		expect(Array.isArray(parsed.coordinates)).toBe(true);
		expect(parsed.coordinates.length).toBeGreaterThanOrEqual(2);
	});

	it("throws EMPTY_FILE on an empty buffer", async () => {
		await expect(
			shapefileLoader.load({ name: "empty.zip", bytes: new Uint8Array(0) }),
		).rejects.toMatchObject({ code: "EMPTY_FILE" });
	});

	it("canLoad recognizes zip and shp", () => {
		expect(shapefileLoader.canLoad("foo.zip")).toBe(true);
		expect(shapefileLoader.canLoad("foo.shp")).toBe(true);
		expect(shapefileLoader.canLoad("foo.csv")).toBe(false);
	});

	it("honors options.tableName", async () => {
		const result = await shapefileLoader.load(fixture("points.shp.zip"), {
			tableName: "my_shapes",
		});
		expect(result.name).toBe("my_shapes");
	});
});
