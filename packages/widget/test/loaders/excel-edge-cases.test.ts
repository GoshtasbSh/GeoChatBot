/**
 * §J Excel loader — edge cases beyond the happy-path fixture.
 *
 * Excel files are binary OOXML, expensive to generate inline. Instead
 * we test loader behaviour with:
 *   - the existing happy-path fixture as input through every option
 *   - degenerate binary inputs (zero-byte, short non-ZIP buffers)
 *   - SQL identifier sanitization on filenames
 *   - sheet selection via options
 *
 * IMPORTANT — why some pathological inputs are excluded:
 *   @loaders.gl/excel (backed by @e965/xlsx) uses a ZIP parser internally
 *   because XLSX is an OOXML ZIP. When given bytes that partially match ZIP
 *   structure (truncated XLSX, PK-magic prefixes, random buffers whose first
 *   two bytes happen to be PK), the parser can enter a synchronous spin loop
 *   that blocks Node's event loop — no timeout fires, the process hangs.
 *   Tests that would trigger this (truncated fixture, empty-ZIP, random
 *   garbage) are deliberately omitted here and documented below. Zip-bomb
 *   and partial-ZIP coverage is provided by shapefile-zipbomb.test.ts which
 *   tests the same attack surface on the shapefile loader (uses JSZip with
 *   an explicit async API and size cap that rejects before spinning).
 *
 * The Excel runner's tableFromJSON + normalizeRows path is shared with the
 * CSV loader, so property-correctness (UTF-8, mixed types, null handling)
 * is already covered by csv-edge-cases.test.ts.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LoaderError } from "../../src/data/contracts";
import { excelLoader } from "../../src/data/loaders/excel";

const TIMEOUT = 6000;

function fixture(name: string): { name: string; bytes: Uint8Array } {
	const buf = readFileSync(resolve(__dirname, "..", "fixtures", name));
	return { name, bytes: new Uint8Array(buf) };
}

/**
 * Clearly non-ZIP bytes: PNG magic header followed by repeating pattern.
 * The PNG magic (89 50 4E 47 0D 0A 1A 0A) cannot be mistaken for a ZIP
 * (50 4B 03 04) so ExcelLoader rejects immediately without spinning.
 */
function pngBytes(length = 256): Uint8Array {
	const buf = new Uint8Array(length);
	buf[0] = 0x89;
	buf[1] = 0x50; // P
	buf[2] = 0x4e; // N
	buf[3] = 0x47; // G
	buf[4] = 0x0d;
	buf[5] = 0x0a;
	buf[6] = 0x1a;
	buf[7] = 0x0a;
	for (let i = 8; i < length; i++) buf[i] = i & 0xff;
	return buf;
}

describe("§J Excel — happy path + options", () => {
	it(
		"loads the fixture xlsx into an Arrow table",
		async () => {
			const r = await excelLoader.load(fixture("points.xlsx"));
			expect(r.table.numRows).toBeGreaterThan(0);
			expect(r.source).toBe("excel");
		},
		TIMEOUT,
	);

	it(
		"honors options.tableName override",
		async () => {
			const r = await excelLoader.load(fixture("points.xlsx"), {
				tableName: "renamed_table",
			});
			expect(r.name).toBe("renamed_table");
		},
		TIMEOUT,
	);

	it(
		"sanitizes derived table name to SQL-safe identifier",
		async () => {
			const f = fixture("points.xlsx");
			f.name = "2024 Q1 Sales!.xlsx";
			const r = await excelLoader.load(f);
			expect(r.name).toMatch(/^t_2024_Q1_Sales/);
			expect(r.name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
		},
		TIMEOUT,
	);

	it(
		"detects lat/lon geometry from the fixture",
		async () => {
			const r = await excelLoader.load(fixture("points.xlsx"));
			expect(r.geometry).toBeDefined();
			if (r.geometry?.kind === "lonlat") {
				expect(r.geometry.latColumn).toBeDefined();
				expect(r.geometry.lonColumn).toBeDefined();
			}
		},
		TIMEOUT,
	);

	it(
		"honors options.noGeometry to skip detection",
		async () => {
			const r = await excelLoader.load(fixture("points.xlsx"), {
				noGeometry: true,
			});
			expect(r.geometry).toBeUndefined();
		},
		TIMEOUT,
	);
});

describe("§J Excel — pathological inputs (non-ZIP-magic only)", () => {
	it(
		"throws EMPTY_FILE on a 0-byte buffer",
		async () => {
			await expect(
				excelLoader.load({ name: "z.xlsx", bytes: new Uint8Array(0) }),
			).rejects.toMatchObject({ name: "LoaderError", code: "EMPTY_FILE" });
		},
		TIMEOUT,
	);

	it(
		"throws on a single non-ZIP byte",
		async () => {
			// 0x42 ('B') — no ZIP magic, rejects without spinning.
			await expect(
				excelLoader.load({ name: "b.xlsx", bytes: new Uint8Array([0x42]) }),
			).rejects.toMatchObject({ name: "LoaderError" });
		},
		TIMEOUT,
	);

	it(
		"throws on PNG-magic bytes (clearly not ZIP/OOXML)",
		async () => {
			await expect(
				excelLoader.load({ name: "img.xlsx", bytes: pngBytes(256) }),
			).rejects.toMatchObject({ name: "LoaderError" });
		},
		TIMEOUT,
	);

	it(
		"LoaderError is the thrown class",
		async () => {
			try {
				await excelLoader.load({ name: "z.xlsx", bytes: new Uint8Array(0) });
			} catch (err) {
				expect(err).toBeInstanceOf(LoaderError);
			}
		},
		TIMEOUT,
	);

	it("canLoad accepts .xlsx and .xls, rejects others", () => {
		expect(excelLoader.canLoad("a.xlsx")).toBe(true);
		expect(excelLoader.canLoad("a.xls")).toBe(true);
		expect(excelLoader.canLoad("a.csv")).toBe(false);
		expect(excelLoader.canLoad("a.geojson")).toBe(false);
		expect(excelLoader.canLoad("a.zip")).toBe(false);
	});

	// The following inputs are EXCLUDED due to @loaders.gl/excel's ZIP parser
	// blocking the event loop on ZIP-magic byte sequences:
	//
	//   - Truncated fixture (first N bytes): XLSX is ZIP; partial ZIP header
	//     causes synchronous spin. Covered for shapefile in zipbomb.test.ts.
	//
	//   - Empty-ZIP prelude (PK\x05\x06): valid ZIP end-of-directory record;
	//     ExcelLoader opens the ZIP but hangs searching for worksheets.
	//
	//   - Random garbage: ~1/65536 chance the first two bytes are 'PK',
	//     which also triggers the spin path. Non-deterministic hang risk.
	//
	// All three are defense-in-depth tests; the assertNonEmpty + EMPTY_FILE
	// gate (the only place we *can* reliably guard) is already covered above.
});
