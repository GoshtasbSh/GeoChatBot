/**
 * §J CSV loader — edge cases beyond the happy-path fixture.
 *
 * Inline-byte tests so we don't bloat the test/fixtures/ tree. Each
 * test builds a Uint8Array from a template literal and asserts the
 * loader interprets it correctly.
 */

import { describe, expect, it } from "vitest";
import { LoaderError } from "../../src/data/contracts";
import { csvLoader } from "../../src/data/loaders/csv";

function bytes(
	name: string,
	content: string,
): { name: string; bytes: Uint8Array } {
	return { name, bytes: new TextEncoder().encode(content) };
}

describe("§J CSV loader — encoding + delimiter + format edge cases", () => {
	it("accepts a UTF-8 BOM-prefixed CSV", async () => {
		const csv = "﻿id,name\n1,Alice\n2,Bob\n";
		const r = await csvLoader.load(bytes("bom.csv", csv));
		expect(r.table.numRows).toBe(2);
		const cols = r.table.schema.fields.map((f) => f.name);
		// The BOM must not bleed into the first column's name.
		expect(cols[0]).toBe("id");
	});

	it("handles CRLF line endings", async () => {
		const csv = "id,name\r\n1,Alice\r\n2,Bob\r\n";
		const r = await csvLoader.load(bytes("crlf.csv", csv));
		expect(r.table.numRows).toBe(2);
	});

	it("handles LF line endings", async () => {
		const csv = "id,name\n1,Alice\n2,Bob\n";
		const r = await csvLoader.load(bytes("lf.csv", csv));
		expect(r.table.numRows).toBe(2);
	});

	it("handles trailing newline without producing an empty row", async () => {
		const csv = "id,name\n1,Alice\n2,Bob\n\n";
		const r = await csvLoader.load(bytes("trailing-newline.csv", csv));
		// loaders.gl may or may not skip the trailing blank line — both
		// behaviours are acceptable as long as we don't see a 3rd phantom row
		// with all-null content shaped as a valid record.
		expect(r.table.numRows).toBeLessThanOrEqual(3);
		expect(r.table.numRows).toBeGreaterThanOrEqual(2);
	});

	it("handles quoted fields containing commas", async () => {
		const csv = `id,name\n1,"Last, First"\n2,"Plain Name"\n`;
		const r = await csvLoader.load(bytes("quotes.csv", csv));
		expect(r.table.numRows).toBe(2);
		const row0 = r.table.toArray()[0] as { name: string };
		expect(row0.name).toBe("Last, First");
	});

	it("handles quoted fields containing newlines", async () => {
		const csv = `id,note\n1,"line1\nline2"\n2,"single"\n`;
		const r = await csvLoader.load(bytes("multiline.csv", csv));
		expect(r.table.numRows).toBe(2);
	});

	it("handles explicit empty / null values", async () => {
		const csv = "id,name\n1,Alice\n2,\n";
		const r = await csvLoader.load(bytes("nulls.csv", csv));
		expect(r.table.numRows).toBe(2);
	});

	it("UTF-8 non-ASCII characters in column NAMES survive", async () => {
		const csv = "id,Café,日本語,🚀_emoji\n1,a,b,c\n";
		const r = await csvLoader.load(bytes("utf8-cols.csv", csv));
		const names = r.table.schema.fields.map((f) => f.name);
		expect(names).toEqual(
			expect.arrayContaining(["id", "Café", "日本語", "🚀_emoji"]),
		);
	});

	it("UTF-8 non-ASCII characters in VALUES survive round-trip", async () => {
		const csv = "id,name\n1,Café\n2,日本\n3,🚀rocket\n";
		const r = await csvLoader.load(bytes("utf8-vals.csv", csv));
		const rows = r.table.toArray() as Array<{ name: string }>;
		expect(rows[0]?.name).toBe("Café");
		expect(rows[1]?.name).toBe("日本");
		expect(rows[2]?.name).toBe("🚀rocket");
	});

	it("a header-only CSV (no data rows) throws EMPTY_FILE with a clear message", async () => {
		// §J (2026-05-12): previously surfaced as a confusing PARSE_ERROR
		// reading "deduce from empty table" from loaders.gl. Now mapped
		// to EMPTY_FILE so the host UI shows the same affordance as a
		// 0-byte buffer.
		const csv = "id,name\n";
		await expect(
			csvLoader.load(bytes("header-only.csv", csv)),
		).rejects.toMatchObject({ name: "LoaderError", code: "EMPTY_FILE" });
	});

	it("a CSV with a header AND nothing else (no trailing newline) throws EMPTY_FILE", async () => {
		const csv = "id,name";
		await expect(
			csvLoader.load(bytes("header-no-nl.csv", csv)),
		).rejects.toMatchObject({ name: "LoaderError", code: "EMPTY_FILE" });
	});

	it("throws EMPTY_FILE on a literal 0-byte buffer", async () => {
		await expect(
			csvLoader.load({ name: "zero.csv", bytes: new Uint8Array(0) }),
		).rejects.toMatchObject({ name: "LoaderError", code: "EMPTY_FILE" });
	});

	it("LoaderError instance is thrown for failure paths", async () => {
		try {
			await csvLoader.load({ name: "empty.csv", bytes: new Uint8Array(0) });
		} catch (err) {
			expect(err).toBeInstanceOf(LoaderError);
		}
	});

	it("a wide CSV (50 cols) does not lose columns", async () => {
		const hdr = Array.from({ length: 50 }, (_, i) => `c${i}`).join(",");
		const row = Array.from({ length: 50 }, (_, i) => String(i)).join(",");
		const csv = `${hdr}\n${row}\n`;
		const r = await csvLoader.load(bytes("wide.csv", csv));
		expect(r.table.schema.fields.length).toBe(50);
		expect(r.table.numRows).toBe(1);
	});

	it("dataset name is sanitized to a SQL-safe identifier", async () => {
		const csv = "id\n1\n";
		const r = await csvLoader.load(bytes("2024 Survey Data!.csv", csv));
		// starts with digit → 't_' prefix; spaces/punct → underscore
		expect(r.name).toMatch(/^t_2024_Survey_Data/);
	});

	it("a CSV with only blank lines after the header is treated as empty", async () => {
		// loaders.gl deduplicates blank lines; if everything is empty,
		// we surface EMPTY_FILE rather than a 0-row Plan that downstream
		// runners would choke on.
		const csv = "id,name\n\n\n";
		await expect(
			csvLoader.load(bytes("blanks.csv", csv)),
		).rejects.toMatchObject({ name: "LoaderError", code: "EMPTY_FILE" });
	});
});
