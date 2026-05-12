/**
 * §J Parquet loader — edge cases under the test-environment stub.
 *
 * Context: `@loaders.gl/parquet` ships a Node-only native addon that fails
 * under Vitest's ESM loader. The vitest config aliases it to a stub that
 * always throws "ParquetLoader is stubbed in test environment." — so any
 * call that reaches parse() gets a PARSE_ERROR. The real happy-path fixture
 * test lives in parquet.test.ts and is excluded from the suite.
 *
 * Covered here:
 *   - EMPTY_FILE on 0-byte buffer (caught before stub is called)
 *   - PARSE_ERROR on 1-byte, garbage, truncated, wrong-magic inputs (stub throws)
 *   - LoaderError class identity
 *   - canLoad extension matching (.parquet, .PARQUET, others)
 *   - Post-parse utilities (deriveTableName, detectLatLon, normalizeRows)
 *     called directly on synthetic data that mimics parquet output — these
 *     validate the parquet loader's pipeline beyond the parse step.
 */

import { describe, expect, it } from "vitest";
import { LoaderError } from "../../src/data/contracts";
import {
	deriveTableName,
	detectLatLon,
	normalizeRows,
} from "../../src/data/loaders/_util";
import { parquetLoader } from "../../src/data/loaders/parquet";

describe("§J Parquet — error paths (stub-safe)", () => {
	it("throws EMPTY_FILE on a 0-byte buffer", async () => {
		await expect(
			parquetLoader.load({ name: "z.parquet", bytes: new Uint8Array(0) }),
		).rejects.toMatchObject({ name: "LoaderError", code: "EMPTY_FILE" });
	});

	it("throws on a 1-byte buffer (stub → PARSE_ERROR)", async () => {
		await expect(
			parquetLoader.load({
				name: "tiny.parquet",
				bytes: new Uint8Array([0x50]),
			}),
		).rejects.toMatchObject({ name: "LoaderError" });
	});

	it("throws on random garbage bytes", async () => {
		const garbage = new Uint8Array(2048);
		for (let i = 0; i < garbage.length; i++)
			garbage[i] = Math.floor(Math.random() * 256);
		await expect(
			parquetLoader.load({ name: "g.parquet", bytes: garbage }),
		).rejects.toMatchObject({ name: "LoaderError" });
	});

	it("throws on PNG-magic bytes masquerading as parquet", async () => {
		const pngMagic = new Uint8Array([
			0x89,
			0x50,
			0x4e,
			0x47,
			0x0d,
			0x0a,
			0x1a,
			0x0a,
			...new Array(100).fill(0),
		]);
		await expect(
			parquetLoader.load({ name: "img.parquet", bytes: pngMagic }),
		).rejects.toMatchObject({ name: "LoaderError" });
	});

	it("throws on ZIP-magic bytes masquerading as parquet", async () => {
		const zipMagic = new Uint8Array([
			0x50,
			0x4b,
			0x03,
			0x04,
			...new Array(100).fill(0),
		]);
		await expect(
			parquetLoader.load({ name: "notparquet.parquet", bytes: zipMagic }),
		).rejects.toMatchObject({ name: "LoaderError" });
	});

	it("LoaderError is the thrown class for EMPTY_FILE", async () => {
		try {
			await parquetLoader.load({
				name: "z.parquet",
				bytes: new Uint8Array(0),
			});
		} catch (err) {
			expect(err).toBeInstanceOf(LoaderError);
		}
	});
});

describe("§J Parquet — canLoad", () => {
	it("accepts .parquet (lower case)", () => {
		expect(parquetLoader.canLoad("a.parquet")).toBe(true);
	});

	it("accepts .PARQUET (upper case)", () => {
		expect(parquetLoader.canLoad("a.PARQUET")).toBe(true);
	});

	it("rejects .csv", () => {
		expect(parquetLoader.canLoad("a.csv")).toBe(false);
	});

	it("rejects .geojson", () => {
		expect(parquetLoader.canLoad("a.geojson")).toBe(false);
	});

	it("rejects .zip", () => {
		expect(parquetLoader.canLoad("a.zip")).toBe(false);
	});

	it("rejects .xlsx", () => {
		expect(parquetLoader.canLoad("a.xlsx")).toBe(false);
	});
});

describe("§J Parquet — post-parse pipeline utilities (synthetic rows)", () => {
	// These directly test the functions the parquet loader calls after parse(),
	// validating the pipeline without needing the real native parquet loader.

	const SYNTHETIC_ROWS = [
		{
			id: 1,
			name: "Gainesville",
			latitude: 29.65,
			longitude: -82.32,
			population: 141085,
		},
		{
			id: 2,
			name: "Tampa",
			latitude: 27.95,
			longitude: -82.46,
			population: 399700,
		},
		{
			id: 3,
			name: "Miami",
			latitude: 25.77,
			longitude: -80.19,
			population: 454279,
		},
	];

	it("deriveTableName sanitizes numeric-leading filenames", () => {
		expect(deriveTableName("2024_survey.parquet")).toMatch(/^t_/);
		expect(deriveTableName("2024_survey.parquet")).toMatch(
			/^[A-Za-z_][A-Za-z0-9_]*$/,
		);
	});

	it("deriveTableName honors override", () => {
		expect(deriveTableName("any.parquet", "my_table")).toBe("my_table");
	});

	it("detectLatLon finds latitude/longitude columns in synthetic rows", () => {
		const geometry = detectLatLon(SYNTHETIC_ROWS);
		expect(geometry).toBeDefined();
		expect(geometry?.kind).toBe("lonlat");
		if (geometry?.kind === "lonlat") {
			expect(geometry.latColumn).toBe("latitude");
			expect(geometry.lonColumn).toBe("longitude");
		}
	});

	it("detectLatLon respects noGeometry option", () => {
		expect(detectLatLon(SYNTHETIC_ROWS, { noGeometry: true })).toBeUndefined();
	});

	it("detectLatLon accepts latColumn/lonColumn overrides", () => {
		const rows = [{ lat_dd: 29.65, lon_dd: -82.32, id: 1 }];
		const geometry = detectLatLon(rows, {
			latColumn: "lat_dd",
			lonColumn: "lon_dd",
		});
		expect(geometry?.kind).toBe("lonlat");
	});

	it("normalizeRows back-fills missing columns with null", () => {
		const sparse = [
			{ id: 1, name: "A" },
			{ id: 2, extra: "B" },
		];
		const norm = normalizeRows(sparse);
		expect(norm[0]).toHaveProperty("extra", null);
		expect(norm[1]).toHaveProperty("name", null);
	});

	it("normalizeRows drops __EMPTY placeholder column names", () => {
		const rows = [{ id: 1, __EMPTY: "x", __EMPTY_1: "y" }];
		const norm = normalizeRows(rows);
		expect(Object.keys(norm[0])).not.toContain("__EMPTY");
		expect(Object.keys(norm[0])).not.toContain("__EMPTY_1");
	});

	it("normalizeRows drops blank-string column names", () => {
		const rows = [{ "": "garbage", id: 1 }];
		const norm = normalizeRows(rows);
		expect(Object.keys(norm[0])).not.toContain("");
		expect(Object.keys(norm[0])).toContain("id");
	});
});
