// @vitest-environment happy-dom
/**
 * §S i18n — UTF-8, non-English dataset names, accented column names.
 *
 * Audit invariants:
 *   S1 UTF-8 column NAMES survive load → quote → SQL identifier.
 *   S1b UTF-8 column VALUES round-trip cleanly.
 *   S1c filename sanitizer for non-ASCII filenames produces a valid
 *       SQL identifier (no spaces, doesn't start with a digit, no
 *       Unicode that would break duckdb's quoteIdent).
 */

import { describe, expect, it } from "vitest";
import { quoteIdent } from "../src/agent/executor/sql-helpers";
import { sanitizeIdent } from "../src/data/loaders/_util";
import { csvLoader } from "../src/data/loaders/csv";

function bytes(name: string, content: string) {
	return { name, bytes: new TextEncoder().encode(content) };
}

describe("§S i18n column names survive the loader pipeline", () => {
	it("accented column names round-trip", async () => {
		const csv = "Café,résumé,naïve\nA,B,C\n";
		const r = await csvLoader.load(bytes("accents.csv", csv));
		const cols = r.table.schema.fields.map((f) => f.name);
		expect(cols).toEqual(["Café", "résumé", "naïve"]);
	});

	it("CJK column names round-trip", async () => {
		const csv = "都市,人口,緯度\n東京,13929286,35.6762\n";
		const r = await csvLoader.load(bytes("cjk.csv", csv));
		const cols = r.table.schema.fields.map((f) => f.name);
		expect(cols).toEqual(["都市", "人口", "緯度"]);
	});

	it("emoji column names round-trip", async () => {
		const csv = "🚀_id,📍_loc\n1,Tokyo\n";
		const r = await csvLoader.load(bytes("emoji.csv", csv));
		const cols = r.table.schema.fields.map((f) => f.name);
		expect(cols).toContain("🚀_id");
	});

	it("UTF-8 VALUES round-trip", async () => {
		const csv = "city\nCafé\n日本\n🚀rocket\n";
		const r = await csvLoader.load(bytes("vals.csv", csv));
		const rows = r.table.toArray() as Array<{ city: string }>;
		expect(rows[0]?.city).toBe("Café");
		expect(rows[1]?.city).toBe("日本");
		expect(rows[2]?.city).toBe("🚀rocket");
	});
});

describe("§S filename sanitizer for non-ASCII filenames", () => {
	it("strips non-ASCII chars and punctuation to a valid SQL identifier", () => {
		const out = sanitizeIdent("Café-Survey 2024!");
		// Non-ASCII (é) is stripped; punctuation collapsed to underscores.
		// Result must be a valid SQL identifier shape.
		expect(out).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
		expect(out).toContain("Survey");
		expect(out).toContain("2024");
	});

	it("non-Latin filenames produce a SQL-safe identifier (may collapse to t_<hash>)", () => {
		const out = sanitizeIdent("東京_調査.csv");
		// Either round-trips Latin chars or falls back to a t_ identifier.
		expect(out).toBeTruthy();
		expect(out).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
	});

	it("an empty / all-punctuation filename produces a t_<hash> fallback", () => {
		const out = sanitizeIdent("!@#$%");
		expect(out).toMatch(/^t_[a-z0-9]+/);
	});

	it("a filename starting with a digit is prefixed with t_", () => {
		expect(sanitizeIdent("2024_Q1_data")).toMatch(/^t_2024_Q1_data/);
	});
});

describe("§S quoteIdent handles UTF-8 identifiers safely", () => {
	it("wraps a non-ASCII column name in double quotes WITHOUT raising", () => {
		const q = quoteIdent("Café");
		expect(q).toBe('"Café"');
	});

	it("escapes embedded double-quotes by doubling them", () => {
		const q = quoteIdent('weird"name');
		expect(q).toBe('"weird""name"');
	});

	it("rejects newline characters in identifiers (DuckDB would reject anyway)", () => {
		expect(() => quoteIdent("bad\nname")).toThrow();
	});
});
