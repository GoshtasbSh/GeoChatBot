/**
 * Shared SQL helpers for Phase 5 runners.
 *
 * Runners build SQL strings from arg objects whose values may be:
 *   - a plain string (logical dataset name as the planner sees it)
 *   - an {@link OutputRef} substituted in by the executor
 *   - an inline literal (number, enum, etc.)
 *
 * These helpers normalize the shape so each runner stays terse and so
 * we have one place to enforce identifier hygiene.
 */

import type { OutputRef } from "../types.js";
import type { DatasetEntry, ExecCtx } from "./types.js";

/**
 * Defensive bound on SQL identifier length. PostgreSQL caps at 63;
 * DuckDB allows larger but there's no legitimate reason for a column or
 * table name to exceed this, and a hostile plan that passes a 10MB
 * identifier into a SQL string is a memory-pressure / log-flood vector.
 * Applies at the choke point so every runner gets the bound for free.
 */
const MAX_IDENT_LEN = 256;
const MAX_STRING_LITERAL_LEN = 4096;

/** SQL identifier quoting (double-quoted, embedded `"` doubled). */
export function quoteIdent(name: string): string {
	if (typeof name !== "string" || name.length === 0) {
		throw new Error("quoteIdent: identifier must be a non-empty string");
	}
	if (name.length > MAX_IDENT_LEN) {
		throw new Error(
			`quoteIdent: identifier exceeds ${MAX_IDENT_LEN} chars (got ${name.length})`,
		);
	}
	// NUL bytes terminate strings in some C-string layers; reject outright.
	if (name.includes("\0")) {
		throw new Error("quoteIdent: identifier contains NUL byte");
	}
	// §S (2026-05-12): reject ASCII control characters in identifiers.
	// DuckDB itself accepts most control chars inside double-quoted
	// identifiers, but they break log parsers, plan-review UI rendering,
	// and audit grep. A legitimate column name never contains a
	// newline/tab/vertical-tab/etc; rejecting here surfaces them to the
	// loader's normalizeRows pass rather than letting them propagate
	// silently into SQL. The control-char range is INTENTIONAL here, so
	// the lint rule is suppressed.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-char rejection
	if (/[\x01-\x1f\x7f]/.test(name)) {
		throw new Error("quoteIdent: identifier contains ASCII control character");
	}
	return `"${name.replace(/"/g, '""')}"`;
}

/** SQL string literal quoting (single-quoted, embedded `'` doubled). */
export function quoteString(s: string): string {
	if (typeof s !== "string") {
		throw new Error("quoteString: argument must be a string");
	}
	if (s.length > MAX_STRING_LITERAL_LEN) {
		throw new Error(
			`quoteString: literal exceeds ${MAX_STRING_LITERAL_LEN} chars`,
		);
	}
	if (s.includes("\0")) {
		throw new Error("quoteString: literal contains NUL byte");
	}
	return `'${s.replace(/'/g, "''")}'`;
}

/** Type guard: an arg value already resolved to an OutputRef. */
export function isOutputRef(v: unknown): v is OutputRef {
	return (
		typeof v === "object" &&
		v !== null &&
		"kind" in (v as object) &&
		"ref" in (v as object) &&
		typeof (v as { ref: unknown }).ref === "string"
	);
}

/** Resolve a layer-kind arg (must produce a view exposing `geom`). */
export function resolveLayer(arg: unknown, ctx: ExecCtx): string {
	if (isOutputRef(arg)) {
		// Reject prior-step outputs that aren't layer-kind. Without this
		// check, a `kind:'table'` ref (e.g. `stats.aggregate` output) would
		// flow into a spatial runner; DuckDB then throws an opaque binder
		// error on `<view>.geom` instead of a clean tool-level message,
		// and the Phase 6 critic gets garbage to diagnose.
		if (arg.kind !== "layer") {
			throw new Error(
				`expected layer OutputRef but got kind '${arg.kind}' (ref=${arg.ref})`,
			);
		}
		return arg.ref;
	}
	if (typeof arg === "string") {
		const ds = ctx.datasets.get(arg);
		if (!ds) throw new Error(`unknown dataset: ${arg}`);
		if (!ds.hasGeometry || !ds.geomView) {
			throw new Error(`dataset ${arg} has no geometry; cannot use as layer`);
		}
		return ds.geomView;
	}
	throw new Error(`cannot resolve layer from value of type ${typeof arg}`);
}

/** Resolve a table-kind arg (no geometry assumption — may or may not have geom). */
export function resolveTable(arg: unknown, ctx: ExecCtx): string {
	if (isOutputRef(arg)) {
		return arg.ref;
	}
	if (typeof arg === "string") {
		const ds = ctx.datasets.get(arg);
		if (!ds) throw new Error(`unknown dataset: ${arg}`);
		return ds.geomView ?? ds.tableName;
	}
	throw new Error(`cannot resolve table from value of type ${typeof arg}`);
}

/** Resolve a layer arg, but accept tables-without-geom too. Used by render.map. */
export function resolveAny(arg: unknown, ctx: ExecCtx): string {
	if (isOutputRef(arg)) return arg.ref;
	if (typeof arg === "string") {
		const ds = ctx.datasets.get(arg);
		if (!ds) throw new Error(`unknown dataset: ${arg}`);
		return ds.geomView ?? ds.tableName;
	}
	throw new Error(`cannot resolve view from value of type ${typeof arg}`);
}

/**
 * Create a view of a SELECT query under {@link ExecCtx.newView}'s naming.
 * Returns the view name. Caller is responsible for the SELECT body being
 * already validated (e.g. SqlValidationError gated for the `sql` tool).
 */
export async function materializeView(
	ctx: ExecCtx,
	prefix: string,
	selectSql: string,
): Promise<string> {
	const viewName = ctx.newView(prefix);
	// CREATE VIEW is allowed here because the SQL body comes from a runner,
	// not from the LLM — runner-emitted SQL is trusted by construction.
	await ctx.engine.query(
		`CREATE OR REPLACE TEMPORARY VIEW ${quoteIdent(viewName)} AS ${selectSql}`,
	);
	return viewName;
}

/** Build a Map of {@link DatasetEntry} by logical name from a registration list. */
export function datasetIndex(
	entries: DatasetEntry[],
): Map<string, DatasetEntry> {
	const out = new Map<string, DatasetEntry>();
	for (const e of entries) out.set(e.name, e);
	return out;
}
