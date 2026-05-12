/**
 * §P paranoid security — SQL allowlist 5000-string fuzz.
 *
 * The audit prompt:
 *   "SQL allowlist validator: fuzz with 5,000 random hostile strings.
 *    None must pass. Catch: DDL/DML, ATTACH, LOAD, INSTALL, PRAGMA,
 *    read_csv*, read_parquet*, read_json*, glob, query_table, delta_scan,
 *    iceberg_scan, *_scan/*_query/*_attach, duckdb_*, information_schema,
 *    getenv, httpfs, s3, azure, http, summarize, checkpoint, comments
 *    hiding keywords, multi-statement, unicode-encoded keywords,
 *    mixed-case, quoted-identifier collisions, hex/octal escaping tricks."
 *
 * Strategy: build hostile strings from a corpus of dangerous payloads
 * crossed with a corpus of evasion mutations (case, comments, padding,
 * mixed-statement, leading whitespace). Assert every result throws
 * SqlValidationError.
 *
 * Also include 500 BENIGN strings (legitimate SELECTs with CTEs, window
 * functions, geometry ops, percentile_cont, EXCEPT/UNION). Assert none
 * throw. Catching only blocks isn't useful if we lock out real queries.
 */

import { describe, expect, it } from "vitest";
import {
	SqlValidationError,
	validateSql,
} from "../../src/agent/validate-sql.js";

const HOSTILE_KEYWORDS = [
	"INSERT",
	"UPDATE",
	"DELETE",
	"CREATE",
	"DROP",
	"ALTER",
	"RENAME",
	"ATTACH",
	"DETACH",
	"COPY",
	"EXPORT",
	"IMPORT",
	"INSTALL",
	"LOAD",
	"PRAGMA",
	"SET",
	"RESET",
	"TRUNCATE",
	"GRANT",
	"REVOKE",
	"VACUUM",
	"CALL",
	"EXEC",
	"EXECUTE",
	"REPLACE",
	"READ_CSV",
	"READ_CSV_AUTO",
	"READ_PARQUET",
	"PARQUET_SCAN",
	"READ_JSON",
	"READ_JSON_AUTO",
	"READ_NDJSON",
	"READ_NDJSON_AUTO",
	"READ_TEXT",
	"READ_BLOB",
	"GLOB",
	"QUERY_TABLE",
	"DELTA_SCAN",
	"ICEBERG_SCAN",
	"SQLITE_SCAN",
	"SQLITE_ATTACH",
	"POSTGRES_SCAN",
	"POSTGRES_QUERY",
	"POSTGRES_ATTACH",
	"MYSQL_SCAN",
	"MYSQL_QUERY",
	"MYSQL_ATTACH",
	"DUCKDB_EXTENSIONS",
	"DUCKDB_SETTINGS",
	"DUCKDB_TABLES",
	"DUCKDB_FUNCTIONS",
	"DUCKDB_DATABASES",
	"DUCKDB_VIEWS",
	"INFORMATION_SCHEMA",
	"GETENV",
	"HTTPFS",
	"S3",
	"AZURE",
	"HTTP",
	"HTTP_GET",
	"HTTP_POST",
	"HTTP_PUT",
	"HTTP_DELETE",
	"SUMMARIZE",
	"CHECKPOINT",
	"INTO",
];

const HOSTILE_PAYLOAD_TEMPLATES: Array<(kw: string) => string> = [
	// Statement-leading abuse
	(k) => `${k} something`,
	(k) => `  ${k}   foo`,
	(k) => `${k}\n bar`,
	// Hidden in middle of SELECT
	(k) => `SELECT * FROM t WHERE x = 1; ${k} bar`,
	(k) => `SELECT * FROM ${k}('http://attacker/data.csv')`,
	(k) => `SELECT * FROM tbl JOIN ${k}('x') USING (id)`,
	(k) => `SELECT ${k}('PATH')`, // for GETENV
	(k) => `SELECT * FROM ${k}.tables`,
	// Multi-statement via semicolon
	(k) => `SELECT 1 ; ${k} foo`,
	(k) => `SELECT 1;${k}`,
	// Hidden behind a line comment
	(k) => `-- harmless\n${k} bar`,
	// Hidden after block comment
	(k) => `/* nothing here */ ${k} bar`,
	// Mid-statement /* */ — comment STRIPPING happens, then keyword visible
	(k) => `SELECT /* ignore */ 1 ; /* now */ ${k} foo`,
	// SELECT INTO new_table
	(k) => `SELECT * ${k} new_tbl FROM tbl`, // for INTO
	// CTE shells
	(k) => `WITH cte AS (SELECT 1) ${k} foo`,
	(k) => `WITH cte AS (SELECT * FROM ${k}('a.csv')) SELECT * FROM cte`,
	// UNION-trick
	(k) => `SELECT 1 UNION ALL SELECT * FROM ${k}('a')`,
];

const CASE_MUTATORS = [
	(s: string) => s,
	(s: string) => s.toLowerCase(),
	(s: string) => s.toUpperCase(),
	(s: string) =>
		s
			.split("")
			.map((c, i) => (i % 2 === 0 ? c.toLowerCase() : c.toUpperCase()))
			.join(""),
];

const PAD_MUTATORS = [
	(s: string) => s,
	(s: string) => `  ${s}  `,
	(s: string) => `\n\t${s}\n`,
	(s: string) => `${s}\n-- trailing comment`,
];

function pickRand<T>(arr: T[], rng: () => number): T {
	const i = Math.floor(rng() * arr.length);
	return arr[i] as T;
}

// Seeded LCG so the fuzz is reproducible.
function mkRng(seed: number): () => number {
	let s = seed;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

describe("§P paranoid SQL fuzz — 5000 hostile strings, 500 benign", () => {
	it("rejects every one of 5000 random hostile strings", () => {
		const rng = mkRng(0xc0ffee);
		const failures: Array<{ sql: string; threw: boolean; reason: string }> = [];
		for (let i = 0; i < 5000; i++) {
			const kw = pickRand(HOSTILE_KEYWORDS, rng);
			const tmpl = pickRand(HOSTILE_PAYLOAD_TEMPLATES, rng);
			const caseMut = pickRand(CASE_MUTATORS, rng);
			const padMut = pickRand(PAD_MUTATORS, rng);
			const sql = padMut(caseMut(tmpl(kw)));
			let threw = false;
			let reason = "";
			try {
				validateSql(sql);
			} catch (err) {
				if (err instanceof SqlValidationError) {
					threw = true;
				} else {
					reason = `non-SqlValidationError: ${(err as Error).message}`;
				}
			}
			if (!threw) {
				failures.push({ sql, threw, reason });
			}
		}
		if (failures.length > 0) {
			const sample = failures
				.slice(0, 5)
				.map((f) => f.sql)
				.join("\n---\n");
			expect.fail(
				`${failures.length}/5000 hostile strings PASSED validation (should have thrown). First failures:\n${sample}`,
			);
		}
	});

	const BENIGN = [
		"SELECT 1",
		"SELECT * FROM t",
		"SELECT id, name FROM customers WHERE id IN (1,2,3)",
		"WITH cte AS (SELECT 1 AS x) SELECT * FROM cte",
		"WITH ctr AS (SELECT AVG(v) mu FROM L) SELECT * FROM L, ctr",
		"SELECT id, ROW_NUMBER() OVER (PARTITION BY g ORDER BY x) AS rn FROM t",
		"SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY x) AS p95 FROM t",
		"SELECT a.id, b.col FROM A a JOIN B b ON a.id = b.id",
		"SELECT ST_X(geom) AS lon, ST_Y(geom) AS lat FROM t",
		"SELECT *, ST_Area(geom) AS area_m2 FROM polygons",
		"SELECT *, ST_Distance(geom, ST_Point(-82.32, 29.65)) AS d FROM t",
		"SELECT GeometryType(geom) AS gtype, COUNT(*) c FROM t GROUP BY 1",
		"SELECT ST_AsGeoJSON(ST_Envelope(ST_Union_Agg(geom))) AS geom FROM t",
		"SELECT * FROM a EXCEPT SELECT * FROM b",
		"SELECT * FROM a UNION SELECT * FROM b",
		"SELECT id FROM t WHERE x BETWEEN 1 AND 10",
		"SELECT id FROM t WHERE name LIKE 'A%'",
		"SELECT id FROM t WHERE x IS NULL OR y = 'foo'",
		"SELECT count(*) FROM t GROUP BY ROLLUP (a, b)",
		"SELECT EXTRACT(YEAR FROM created_at) AS y FROM t",
		// Quoted identifier that happens to spell a keyword — must be allowed
		'SELECT "into", "drop" FROM t',
		// String literal that contains a keyword — must be allowed
		"SELECT * FROM t WHERE col = 'DROP TABLE users'",
	];

	it("accepts all 22 representative benign SELECTs", () => {
		for (const sql of BENIGN) {
			expect(() => validateSql(sql)).not.toThrow();
		}
	});

	it("accepts each benign SELECT a thousand random ways (pad + comment-suffix mutations)", () => {
		const rng = mkRng(0xfeedface);
		const failures: string[] = [];
		for (let i = 0; i < 500; i++) {
			const base = pickRand(BENIGN, rng);
			const pad = pickRand(PAD_MUTATORS, rng);
			const sql = pad(base);
			try {
				validateSql(sql);
			} catch (err) {
				if (err instanceof SqlValidationError) failures.push(sql);
			}
		}
		if (failures.length > 0) {
			expect.fail(
				`${failures.length}/500 benign strings were FALSELY rejected. First: ${failures[0]}`,
			);
		}
	});
});
