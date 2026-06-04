/**
 * `sql` tool runtime.
 *
 * Wraps the user's SELECT/WITH query in a temporary view so downstream
 * steps can reference it via `${var}`.
 *
 * SECURITY INVARIANT: every SQL body is validated HERE, on every call,
 * regardless of where the step came from. This is the canonical §4 gate.
 * The pre-approval validator in `element.ts._execute` is an early-rejection
 * convenience for fast UI feedback only — Phase 6 critic-patched steps
 * skip that pre-validator (they re-enter the executor mid-flight) but
 * still hit this runner-side check, which means critic-injected DDL/DML
 * cannot bypass §4.
 */

import { z } from "zod";
import { validateSql } from "../../validate-sql.js";
import { registerRunner } from "../runtime.js";
import { materializeView, quoteIdent } from "../sql-helpers.js";
import type { ExecCtx, RunnerResult } from "../types.js";

const SqlArgs = z.object({ query: z.string().min(1) });

/**
 * Matches a `${var}` reference where `var` is a plan output_var
 * (zod-validated to `^[a-z_][a-z0-9_]*$`, optionally upper-case as the LLM
 * emitted it). Used to rewrite inter-step references inside a SQL body.
 */
const SQL_VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Rewrite `${var}` tokens inside a SQL body to the bare-name temp view the
 * executor registers for each step's `output_var` (see executor.ts — it
 * does `CREATE … VIEW "<output_var>" AS SELECT * FROM <result.ref>`).
 *
 * Whole-string `${var}` substitution is deliberately disabled for SQL
 * bodies (substitute.ts WHOLE_STRING_VAR) as an injection guard, so the
 * documented convention is that a SQL step references a prior output by its
 * BARE name (`FROM filtered`). In practice planners — especially weaker
 * models — emit the wrapped `FROM ${filtered}` form, which DuckDB rejects
 * with "syntax error at or near $". Rewriting `${name}` → quoteIdent(name)
 * maps it onto exactly that bare-name view. This is injection-safe:
 * quoteIdent only ever emits a double-quoted identifier (length-capped,
 * NUL/control-rejected) and the captured name is restricted to the
 * identifier charset, so it cannot break out of the surrounding SQL. If the
 * referenced view doesn't exist, DuckDB throws a clean "table not found"
 * that the Phase 6 critic can diagnose — far better than a `$` parse error.
 */
function expandSqlVarRefs(query: string): string {
	return query.replace(SQL_VAR_REF, (_m, name: string) => quoteIdent(name));
}

export async function runSql(
	args: Record<string, unknown>,
	ctx: ExecCtx,
): Promise<RunnerResult> {
	const { query: rawQuery } = SqlArgs.parse(args);
	const query = expandSqlVarRefs(rawQuery);
	validateSql(query);
	const view = await materializeView(ctx, "sql", query);
	// Detect whether the resulting view exposes a `geom` column. SQL
	// operating on a `_geom` view via SELECT * preserves the column, so
	// the output is layer-shaped and can flow into spatial runners.
	// Without this, every `sql` output is `kind:'table'` and the new
	// `resolveLayer` kind check (NH3) would falsely reject the chain
	// `sql → geometry.buffer` even when the SQL SELECTed the geometry.
	const hasGeom = await viewHasGeomColumn(ctx, view);
	return { output: { kind: hasGeom ? "layer" : "table", ref: view } };
}

async function viewHasGeomColumn(ctx: ExecCtx, view: string): Promise<boolean> {
	// pragma_table_info works for views and base tables in DuckDB and
	// doesn't trip the SQL validator (which gates user-input SQL only —
	// runner-emitted SQL is trusted). A failure (e.g. spatial extension
	// unavailable) falls back to 'table'; downstream resolveLayer will
	// throw a clear error if a layer was actually expected.
	try {
		const tbl = await ctx.engine.query(
			`SELECT name FROM pragma_table_info(${quoteIdent(view)}) WHERE lower(name) = 'geom'`,
		);
		return tbl.numRows > 0;
	} catch {
		return false;
	}
}

registerRunner("sql", runSql);
