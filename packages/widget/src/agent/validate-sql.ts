/**
 * SELECT/WITH-only SQL validator (Layer 5 of the validation pipeline).
 * Tokenizes the input, strips comments, enforces a single statement,
 * and rejects any presence of forbidden top-level keywords.
 *
 * Designed to be paranoid, not parse-perfect. False-positives (rejecting
 * a benign query) are acceptable; false-negatives (admitting a dangerous
 * query) are not.
 */
export class SqlValidationError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "SqlValidationError";
	}
}

const BLOCKED = new Set([
	// DDL / DML / session statements
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
	// SELECT ... INTO new_table is a DuckDB CTAS-style side effect that
	// creates a persistent table. Block the INTO keyword outright; pure
	// SELECT/WITH queries never need it. (INSERT INTO is already blocked
	// by INSERT.)
	"INTO",
	// DuckDB table-valued read functions — usable inside SELECT FROM and would
	// allow an LLM to fetch arbitrary URLs (with httpfs) or virtual-FS paths,
	// bypassing dataset-only access. Block the function names regardless of
	// statement position.
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
	// Newer DuckDB lakehouse table functions with the same network-read
	// capability as parquet_scan.
	"DELTA_SCAN",
	"ICEBERG_SCAN",
	// Foreign-database scanners and query-pushdown functions shipped by
	// DuckDB's sqlite/postgres/mysql extensions.
	"SQLITE_SCAN",
	"SQLITE_ATTACH",
	"POSTGRES_SCAN",
	"POSTGRES_QUERY",
	"POSTGRES_ATTACH",
	"MYSQL_SCAN",
	"MYSQL_QUERY",
	"MYSQL_ATTACH",
	// DuckDB metadata catalog tables — their function-form names. Reveal
	// attached databases, loaded extensions, and engine settings; a hostile
	// plan could exfiltrate state via these. The information_schema
	// namespace is also blocked at the token level.
	"DUCKDB_EXTENSIONS",
	"DUCKDB_SETTINGS",
	"DUCKDB_TABLES",
	"DUCKDB_FUNCTIONS",
	"DUCKDB_DATABASES",
	"DUCKDB_VIEWS",
	"INFORMATION_SCHEMA",
	// Process-environment access.
	"GETENV",
	// External catalog / extension surface that could pull side effects
	"HTTPFS",
	"S3",
	"AZURE",
	// httpfs scalar / network functions — defense-in-depth. Today httpfs is
	// not LOAD'd in the WASM build (and LOAD is blocked above) so these are
	// inert; if a future DuckDB build pre-bundles httpfs they would become
	// SSRF/exfiltration vectors otherwise.
	"HTTP",
	"HTTP_GET",
	"HTTP_POST",
	"HTTP_PUT",
	"HTTP_DELETE",
	// DuckDB top-level statements that are not SELECT/WITH but could appear
	// inside a CTE-like construct. ALLOWED_LEADING already rejects them at
	// the start; blocklisting is belt-and-suspenders.
	"SUMMARIZE",
	"CHECKPOINT",
]);

const ALLOWED_LEADING = new Set(["SELECT", "WITH"]);

function stripComments(sql: string): string {
	let out = "";
	let i = 0;
	while (i < sql.length) {
		const c = sql.charAt(i);
		const c2 = sql.charAt(i + 1);
		if (c === "'") {
			const end = findStringEnd(sql, i, "'");
			out += sql.slice(i, end + 1);
			i = end + 1;
			continue;
		}
		if (c === '"') {
			const end = findStringEnd(sql, i, '"');
			out += sql.slice(i, end + 1);
			i = end + 1;
			continue;
		}
		if (c === "-" && c2 === "-") {
			const nl = sql.indexOf("\n", i);
			i = nl === -1 ? sql.length : nl + 1;
			out += " ";
			continue;
		}
		if (c === "/" && c2 === "*") {
			const close = sql.indexOf("*/", i + 2);
			if (close === -1)
				throw new SqlValidationError("unterminated block comment");
			i = close + 2;
			out += " ";
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

function findStringEnd(s: string, start: number, q: string): number {
	let i = start + 1;
	while (i < s.length) {
		if (s.charAt(i) === q && s.charAt(i + 1) === q) {
			i += 2;
			continue;
		}
		if (s.charAt(i) === q) return i;
		i++;
	}
	throw new SqlValidationError("unterminated string literal");
}

function splitStatements(sql: string): string[] {
	const out: string[] = [];
	let buf = "";
	let i = 0;
	while (i < sql.length) {
		const c = sql.charAt(i);
		if (c === "'" || c === '"') {
			const end = findStringEnd(sql, i, c);
			buf += sql.slice(i, end + 1);
			i = end + 1;
			continue;
		}
		if (c === ";") {
			const trimmed = buf.trim();
			if (trimmed.length) out.push(trimmed);
			buf = "";
			i++;
			continue;
		}
		buf += c;
		i++;
	}
	const tail = buf.trim();
	if (tail.length) out.push(tail);
	return out;
}

function tokenize(sql: string): string[] {
	// Strip double-quoted identifier spans before regex-scanning so a
	// quoted column name like "into" or "select" is not tokenized as the
	// SQL keyword. Single-quoted string literals are also stripped — they
	// are user data, not keywords. Embedded `""`/`''` (the SQL-standard
	// escape) is handled by `findStringEnd`.
	let cleaned = "";
	let i = 0;
	while (i < sql.length) {
		const c = sql.charAt(i);
		if (c === '"' || c === "'") {
			// Skip over the entire quoted span. findStringEnd handles the
			// escape-by-doubling rule. Replace the span with a single space
			// so token boundaries on either side are preserved.
			const end = findStringEnd(sql, i, c);
			cleaned += " ";
			i = end + 1;
			continue;
		}
		cleaned += c;
		i++;
	}
	return Array.from(cleaned.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)).map((m) =>
		m[0].toUpperCase(),
	);
}

export function validateSql(sql: string): void {
	if (typeof sql !== "string" || !sql.trim()) {
		throw new SqlValidationError("empty SQL");
	}
	const stripped = stripComments(sql);
	const statements = splitStatements(stripped);
	if (statements.length === 0) {
		throw new SqlValidationError("empty SQL after comment stripping");
	}
	if (statements.length > 1) {
		throw new SqlValidationError("only a single statement is allowed");
	}
	const stmt = statements[0];
	if (stmt === undefined) {
		throw new SqlValidationError("no statement found");
	}
	const tokens = tokenize(stmt);
	if (tokens.length === 0) {
		throw new SqlValidationError("no tokens found");
	}
	const head = tokens[0];
	if (head === undefined) {
		throw new SqlValidationError("no tokens found");
	}
	if (!ALLOWED_LEADING.has(head)) {
		throw new SqlValidationError(
			`statement must start with SELECT or WITH (got ${head})`,
		);
	}
	for (const t of tokens) {
		if (BLOCKED.has(t)) {
			throw new SqlValidationError(`forbidden keyword: ${t}`);
		}
	}
}
