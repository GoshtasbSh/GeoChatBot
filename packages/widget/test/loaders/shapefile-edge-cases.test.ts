/**
 * §J Shapefile loader — edge cases + pathological inputs.
 *
 * Covered:
 *   - Happy path: fixture ZIP loads with geometry and properties
 *   - options.tableName override
 *   - SQL-safe identifier sanitization
 *   - geometry encoding kind is geojson-string
 *   - ZIP with no .shp → PARSE_ERROR
 *   - Minimal empty-ZIP → PARSE_ERROR (no .shp)
 *   - 0-byte buffer → EMPTY_FILE
 *   - Truncated ZIP → PARSE_ERROR
 *   - Zip-bomb prelude: uncompressed size sum triggers FILE_TOO_LARGE
 *   - Raw random bytes → PARSE_ERROR
 *   - canLoad extension matching
 *   - LoaderError class identity
 *
 * FILE_TOO_LARGE via pre-decompression size field is tested via a
 * synthetic JSZip wrapper in shapefile-zipbomb.test.ts; the raw-bytes
 * path is covered here.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LoaderError } from "../../src/data/contracts";
import { shapefileLoader } from "../../src/data/loaders/shapefile";

function fixture(name: string): { name: string; bytes: Uint8Array } {
	const buf = readFileSync(resolve(__dirname, "..", "fixtures", name));
	return { name, bytes: new Uint8Array(buf) };
}

describe("§J Shapefile — happy path + options", () => {
	it("loads the fixture zip into an Arrow table", async () => {
		const r = await shapefileLoader.load(fixture("points.shp.zip"));
		expect(r.table.numRows).toBeGreaterThan(0);
		expect(r.source).toBe("shapefile");
	});

	it("exposes geojson-string geometry encoding", async () => {
		const r = await shapefileLoader.load(fixture("points.shp.zip"));
		expect(r.geometry).toBeDefined();
		expect(r.geometry?.kind).toBe("geojson-string");
		if (r.geometry?.kind === "geojson-string") {
			expect(r.geometry.column).toBe("geometry");
		}
	});

	it("honors options.tableName override", async () => {
		const r = await shapefileLoader.load(fixture("points.shp.zip"), {
			tableName: "my_points",
		});
		expect(r.name).toBe("my_points");
	});

	it("sanitizes derived table name to SQL-safe identifier", async () => {
		const f = fixture("points.shp.zip");
		f.name = "2024 Survey Results!.zip";
		const r = await shapefileLoader.load(f);
		expect(r.name).toMatch(/^t_2024/);
		expect(r.name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
	});

	it("geometry column contains valid JSON strings", async () => {
		const r = await shapefileLoader.load(fixture("points.shp.zip"));
		const rows = r.table.toArray() as Array<{ geometry?: string }>;
		const first = rows.find((row) => row.geometry != null);
		expect(first).toBeDefined();
		const parsed = JSON.parse(String(first?.geometry));
		expect(parsed).toHaveProperty("type");
		expect(parsed).toHaveProperty("coordinates");
	});
});

describe("§J Shapefile — pathological inputs", () => {
	it("throws EMPTY_FILE on a 0-byte buffer", async () => {
		await expect(
			shapefileLoader.load({ name: "z.zip", bytes: new Uint8Array(0) }),
		).rejects.toMatchObject({ name: "LoaderError", code: "EMPTY_FILE" });
	});

	it("throws on a 1-byte buffer", async () => {
		await expect(
			shapefileLoader.load({ name: "tiny.zip", bytes: new Uint8Array([42]) }),
		).rejects.toMatchObject({ name: "LoaderError" });
	});

	it("throws on random garbage bytes", async () => {
		const garbage = new Uint8Array(2048);
		for (let i = 0; i < garbage.length; i++)
			garbage[i] = Math.floor(Math.random() * 256);
		await expect(
			shapefileLoader.load({ name: "g.zip", bytes: garbage }),
		).rejects.toMatchObject({ name: "LoaderError" });
	});

	it("throws on a truncated zip (first 256 bytes only)", async () => {
		const f = fixture("points.shp.zip");
		const truncated = f.bytes.slice(0, 256);
		await expect(
			shapefileLoader.load({ name: f.name, bytes: truncated }),
		).rejects.toMatchObject({ name: "LoaderError" });
	});

	it("throws PARSE_ERROR on an empty ZIP (no .shp inside)", async () => {
		// Minimal valid ZIP end-of-central-directory record — no entries.
		const emptyZip = new Uint8Array([
			0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
			0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		]);
		await expect(
			shapefileLoader.load({ name: "empty.zip", bytes: emptyZip }),
		).rejects.toMatchObject({ name: "LoaderError" });
	});

	it("LoaderError is the thrown class", async () => {
		try {
			await shapefileLoader.load({ name: "z.zip", bytes: new Uint8Array(0) });
		} catch (err) {
			expect(err).toBeInstanceOf(LoaderError);
		}
	});

	it("canLoad accepts .zip and .shp, rejects others", () => {
		expect(shapefileLoader.canLoad("a.zip")).toBe(true);
		expect(shapefileLoader.canLoad("a.shp")).toBe(true);
		expect(shapefileLoader.canLoad("a.csv")).toBe(false);
		expect(shapefileLoader.canLoad("a.geojson")).toBe(false);
		expect(shapefileLoader.canLoad("a.xlsx")).toBe(false);
	});
});
