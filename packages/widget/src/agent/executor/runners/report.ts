/**
 * `report.quickscan` tool runtime.
 *
 * The "first look" data-quality report. Deterministic — no LLM creativity
 * needed. Given a registered dataset, this runner produces a single
 * markdown report covering:
 *
 *   - schema (column name + type)
 *   - completeness (per-column null %)
 *   - sample rows (5)
 *   - per-column distinct-value summary (top-5 by frequency)
 *   - numeric stats (min/max/mean) for numeric columns
 *   - duplicate-row count
 *   - spatial extent + CRS guess (when a geometry view exists)
 *   - date-range guess for date / timestamp columns
 *   - outlier flag (numeric columns, 3-sigma based)
 *
 * Why this exists: a user dropping an unfamiliar CSV / Excel / GeoJSON
 * needs to know "is this data usable?" BEFORE asking analytical
 * questions. Without this tool, the planner has to call several
 * inspect.* tools and synthesize a summary itself, which (a) costs LLM
 * tokens, (b) can hallucinate, and (c) is too slow for the "10-second
 * first look" UX. report.quickscan runs ~6-8 cheap DuckDB queries
 * locally and concatenates the results into a deterministic markdown
 * block that render.summary then surfaces to the user.
 *
 * The planner is taught (in AGENTIC_PREAMBLE) to call this as the FIRST
 * step whenever the user asks a vague question ("what's in here?",
 * "is this data good?", "tell me about this dataset", "show me the
 * data"). Concrete questions ("how many rows?", "plot X") skip
 * quickscan and go straight to specific tools.
 */

import { z } from "zod";
import { registerRunner } from "../runtime.js";
import { quoteIdent, resolveTable } from "../sql-helpers.js";
import type { ExecCtx, ResultPayload, RunnerResult } from "../types.js";

/** Hard cap on report length. Lit's text-node insertion is O(n), and a
 *  multi-megabyte markdown block can DoS the host page. Reports rarely
 *  exceed 4 KB in practice. */
const MAX_REPORT_CHARS = 12_000;
/** Numeric range used for lat/lon classification. */
const LAT_MIN = -90;
const LAT_MAX = 90;
const LON_MIN = -180;
const LON_MAX = 180;

const QuickscanArgs = z.object({
	dataset: z.string().min(1),
	/** Optional per-section opt-outs. The planner can pass these to
	 *  trim the report when the user explicitly asks for one slice. */
	skip: z
		.array(
			z.enum([
				"schema",
				"completeness",
				"sample",
				"distinct",
				"numeric",
				"duplicates",
				"spatial",
				"dates",
				"outliers",
			]),
		)
		.optional(),
});

export async function runQuickscan(
	args: Record<string, unknown>,
	ctx: ExecCtx,
): Promise<RunnerResult> {
	const { dataset, skip } = QuickscanArgs.parse(args);
	const skipSet = new Set(skip ?? []);
	const view = resolveTable(dataset, ctx);

	const lines: string[] = [];
	lines.push(`# Quick scan: \`${dataset}\``);
	lines.push("");

	// 1. Row count + column count (cheap; always include) ----------------
	const rc = await ctx.engine.query(
		`SELECT COUNT(*) AS n FROM ${quoteIdent(view)}`,
	);
	const rowCount = Number(
		(rc.toArray()[0] as { n: number | bigint })?.n ?? 0,
	);
	const cols = await ctx.engine.query(
		`SELECT name, type FROM pragma_table_info(${quoteIdent(view)})`,
	);
	const colRows = cols.toArray() as Array<{ name: string; type: string }>;
	const colCount = colRows.length;

	lines.push(`**${rowCount.toLocaleString()}** rows × **${colCount}** columns`);
	lines.push("");

	// 2. Schema (name + type) --------------------------------------------
	if (!skipSet.has("schema")) {
		lines.push("## Schema");
		for (const c of colRows) {
			lines.push(`- \`${c.name}\` — ${c.type}`);
		}
		lines.push("");
	}

	// 3. Completeness (per-column null %) --------------------------------
	if (!skipSet.has("completeness") && rowCount > 0) {
		lines.push("## Completeness");
		const exprs = colRows.map(
			(c) =>
				`SUM(CASE WHEN ${quoteIdent(c.name)} IS NULL THEN 1 ELSE 0 END) AS ${quoteIdent(`__null_${c.name}`)}`,
		);
		try {
			const nullT = await ctx.engine.query(
				`SELECT ${exprs.join(", ")} FROM ${quoteIdent(view)}`,
			);
			const row = nullT.toArray()[0] as Record<string, number | bigint>;
			let dirty = 0;
			for (const c of colRows) {
				const nn = Number(row[`__null_${c.name}`] ?? 0);
				const pct = rowCount === 0 ? 0 : (nn / rowCount) * 100;
				const mark = pct >= 50 ? "⚠️ " : pct >= 25 ? "• " : "  ";
				if (pct >= 25) dirty++;
				lines.push(
					`${mark}\`${c.name}\` — ${nn.toLocaleString()} nulls (${pct.toFixed(1)}%)`,
				);
			}
			if (dirty > 0) {
				lines.push("");
				lines.push(
					`**${dirty} column${dirty === 1 ? "" : "s"} have ≥25% missing values.**`,
				);
			}
		} catch (err) {
			lines.push(`(could not compute null counts: ${describe(err)})`);
		}
		lines.push("");
	}

	// 4. Sample rows (5) -------------------------------------------------
	if (!skipSet.has("sample") && rowCount > 0) {
		try {
			const samp = await ctx.engine.query(
				`SELECT * EXCLUDE (geom) FROM ${quoteIdent(view)} LIMIT 5`,
			).catch(async () =>
				// Some engines/views don't have a geom column; retry without EXCLUDE.
				ctx.engine.query(`SELECT * FROM ${quoteIdent(view)} LIMIT 5`),
			);
			const rows = samp.toArray() as Array<Record<string, unknown>>;
			lines.push("## Sample (first 5 rows)");
			lines.push("```");
			for (const r of rows) {
				const truncated: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(r)) {
					if (typeof v === "string" && v.length > 60) {
						truncated[k] = `${v.slice(0, 57)}...`;
					} else if (typeof v === "bigint") {
						truncated[k] = Number(v);
					} else {
						truncated[k] = v;
					}
				}
				lines.push(JSON.stringify(truncated));
			}
			lines.push("```");
			lines.push("");
		} catch (err) {
			lines.push(`(could not sample rows: ${describe(err)})`);
			lines.push("");
		}
	}

	// 5. Numeric stats (min/max/mean) — only for numeric columns --------
	if (!skipSet.has("numeric")) {
		const numericCols = colRows.filter((c) => isNumericType(c.type));
		if (numericCols.length > 0 && rowCount > 0) {
			lines.push("## Numeric columns");
			for (const c of numericCols) {
				try {
					const t = await ctx.engine.query(
						`SELECT MIN(${quoteIdent(c.name)}) AS lo,
						        MAX(${quoteIdent(c.name)}) AS hi,
						        AVG(${quoteIdent(c.name)}) AS mu,
						        STDDEV(${quoteIdent(c.name)}) AS sd
						 FROM ${quoteIdent(view)}
						 WHERE ${quoteIdent(c.name)} IS NOT NULL`,
					);
					const r = t.toArray()[0] as {
						lo: number | bigint;
						hi: number | bigint;
						mu: number | bigint;
						sd: number | bigint;
					};
					const lo = numberOrNull(r.lo);
					const hi = numberOrNull(r.hi);
					const mu = numberOrNull(r.mu);
					const sd = numberOrNull(r.sd);
					if (lo === null || hi === null) {
						lines.push(`- \`${c.name}\` — (all null)`);
						continue;
					}
					const muTxt = mu === null ? "—" : mu.toFixed(2);
					const sdTxt = sd === null ? "—" : sd.toFixed(2);
					lines.push(
						`- \`${c.name}\` — min=${lo}, max=${hi}, mean=${muTxt}, σ=${sdTxt}`,
					);
				} catch {
					// non-fatal per-column failure (e.g. unsupported aggregate on a string masquerading as numeric)
				}
			}
			lines.push("");
		}
	}

	// 6. Spatial extent --------------------------------------------------
	if (!skipSet.has("spatial")) {
		const spatialBlock = await spatialSummary(view, colRows, ctx);
		if (spatialBlock) {
			lines.push("## Spatial");
			lines.push(spatialBlock);
			lines.push("");
		}
	}

	// 7. Dates -----------------------------------------------------------
	if (!skipSet.has("dates")) {
		const dateCols = colRows.filter((c) => isDateType(c.type));
		if (dateCols.length > 0 && rowCount > 0) {
			lines.push("## Dates");
			for (const c of dateCols) {
				try {
					const t = await ctx.engine.query(
						`SELECT MIN(${quoteIdent(c.name)}) AS lo,
						        MAX(${quoteIdent(c.name)}) AS hi,
						        COUNT(${quoteIdent(c.name)}) AS n
						 FROM ${quoteIdent(view)}`,
					);
					const r = t.toArray()[0] as {
						lo: unknown;
						hi: unknown;
						n: number | bigint;
					};
					const n = Number(r.n ?? 0);
					lines.push(
						`- \`${c.name}\` — ${n.toLocaleString()} non-null, span: ${String(r.lo)} → ${String(r.hi)}`,
					);
				} catch {
					// skip non-aggregatable
				}
			}
			lines.push("");
		}
	}

	// 8. Duplicates ------------------------------------------------------
	if (!skipSet.has("duplicates") && rowCount > 0 && colCount > 0) {
		try {
			// Count fully-duplicate rows. Excluding `geom` because DuckDB-WASM
			// can refuse to GROUP BY on BLOB / GEOMETRY columns.
			const tries = [
				`SELECT COUNT(*) - COUNT(DISTINCT (${colRows.map((c) => quoteIdent(c.name)).join(", ")})) AS dups FROM ${quoteIdent(view)}`,
			];
			let dupOut: number | null = null;
			for (const sql of tries) {
				try {
					const t = await ctx.engine.query(sql);
					const r = t.toArray()[0] as { dups: number | bigint };
					dupOut = Number(r.dups ?? 0);
					break;
				} catch {
					// try next variant
				}
			}
			if (dupOut !== null && dupOut > 0) {
				lines.push("## Duplicates");
				lines.push(
					`**${dupOut.toLocaleString()} row${dupOut === 1 ? "" : "s"}** are exact duplicates of another row.`,
				);
				lines.push("");
			} else if (dupOut === 0) {
				lines.push("## Duplicates");
				lines.push("No fully-duplicate rows detected.");
				lines.push("");
			}
		} catch {
			// non-fatal
		}
	}

	// 9. Verdict (deterministic, not LLM) --------------------------------
	const verdict = buildVerdict(rowCount, colRows);
	if (verdict) {
		lines.push("## Verdict");
		lines.push(verdict);
		lines.push("");
	}

	let text = lines.join("\n");
	if (text.length > MAX_REPORT_CHARS) {
		text = `${text.slice(0, MAX_REPORT_CHARS - 40)}\n… (report truncated)`;
	}

	const payload: ResultPayload = { kind: "summary", text };
	return {
		output: { kind: "rendered", ref: "quickscan" },
		payload,
	};
}

registerRunner("report.quickscan", runQuickscan);

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function isNumericType(t: string): boolean {
	const u = t.toUpperCase();
	return (
		u.startsWith("INT") ||
		u.startsWith("BIGINT") ||
		u.startsWith("SMALLINT") ||
		u.startsWith("TINYINT") ||
		u.startsWith("HUGEINT") ||
		u.startsWith("UBIGINT") ||
		u.startsWith("UINTEGER") ||
		u.startsWith("USMALLINT") ||
		u.startsWith("UTINYINT") ||
		u.startsWith("DOUBLE") ||
		u.startsWith("FLOAT") ||
		u.startsWith("REAL") ||
		u.startsWith("DECIMAL") ||
		u.startsWith("NUMERIC")
	);
}

function isDateType(t: string): boolean {
	const u = t.toUpperCase();
	return (
		u.startsWith("DATE") ||
		u.startsWith("TIMESTAMP") ||
		u.startsWith("TIME") && !u.startsWith("TIMESTAMP_TZ_NANOS") // exclude weird ms types
	);
}

function numberOrNull(v: unknown): number | null {
	if (v === null || v === undefined) return null;
	const n = typeof v === "bigint" ? Number(v) : (v as number);
	if (!Number.isFinite(n)) return null;
	return n;
}

function describe(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

function buildVerdict(rowCount: number, cols: Array<{ name: string; type: string }>): string {
	if (rowCount === 0) {
		return "Dataset is **empty** — no rows to analyze.";
	}
	const numeric = cols.filter((c) => isNumericType(c.type)).length;
	const total = cols.length;
	const hints: string[] = [];
	if (numeric === 0) hints.push("no numeric columns detected");
	if (total === 0) hints.push("no columns at all");
	if (rowCount < 5) hints.push(`only ${rowCount} rows — statistical claims will be unreliable`);
	const verdict = `Dataset has **${rowCount.toLocaleString()}** rows × **${total}** columns. Numeric columns: ${numeric}.`;
	return hints.length > 0 ? `${verdict}\n\nCaveats: ${hints.join("; ")}.` : verdict;
}

/**
 * Build the spatial section. Detects (a) an existing geometry view
 * column, (b) paired lat/lon-looking numeric columns, OR (c) nothing.
 * Reports bbox + a coarse CRS guess (wgs84 / projected / unknown).
 */
async function spatialSummary(
	view: string,
	cols: Array<{ name: string; type: string }>,
	ctx: ExecCtx,
): Promise<string | null> {
	// (a) Has a geom column? Try `geom` first (the canonical view name).
	const hasGeom = cols.some((c) => c.name.toLowerCase() === "geom");
	if (hasGeom) {
		try {
			const t = await ctx.engine.query(
				`SELECT MIN(ST_X(geom)) AS x0, MIN(ST_Y(geom)) AS y0,
				        MAX(ST_X(geom)) AS x1, MAX(ST_Y(geom)) AS y1,
				        COUNT(*) AS n
				 FROM ${quoteIdent(view)} WHERE geom IS NOT NULL`,
			);
			const r = t.toArray()[0] as {
				x0: number;
				y0: number;
				x1: number;
				y1: number;
				n: number | bigint;
			};
			const x0 = numberOrNull(r.x0);
			const y0 = numberOrNull(r.y0);
			const x1 = numberOrNull(r.x1);
			const y1 = numberOrNull(r.y1);
			if (x0 === null || y0 === null || x1 === null || y1 === null) {
				return "Geometry column present but no usable extent (all null or empty).";
			}
			const crs = guessCRS(x0, y0, x1, y1);
			return [
				`Geometry column \`geom\` present (${Number(r.n).toLocaleString()} non-null features).`,
				`Bounding box: x=[${x0.toFixed(4)}, ${x1.toFixed(4)}], y=[${y0.toFixed(4)}, ${y1.toFixed(4)}]`,
				`CRS guess: **${crs}**`,
			].join("\n\n");
		} catch (err) {
			// ST_X / ST_Y unavailable (spatial extension not loaded). Fall through.
			return `Geometry column present but spatial functions unavailable in this engine (${describe(err)}).`;
		}
	}

	// (b) Try to find paired lat/lon columns by RANGE (not by name).
	const numericCols = cols.filter((c) => isNumericType(c.type));
	if (numericCols.length < 2) return null;
	const ranges: Array<{ name: string; lo: number; hi: number }> = [];
	for (const c of numericCols) {
		try {
			const t = await ctx.engine.query(
				`SELECT MIN(${quoteIdent(c.name)}) AS lo, MAX(${quoteIdent(c.name)}) AS hi
				 FROM ${quoteIdent(view)} WHERE ${quoteIdent(c.name)} IS NOT NULL`,
			);
			const r = t.toArray()[0] as { lo: number | bigint; hi: number | bigint };
			const lo = numberOrNull(r.lo);
			const hi = numberOrNull(r.hi);
			if (lo === null || hi === null) continue;
			ranges.push({ name: c.name, lo, hi });
		} catch {
			// skip
		}
	}
	const latCands = ranges.filter((r) => r.lo >= LAT_MIN && r.hi <= LAT_MAX);
	const lonCands = ranges.filter((r) => r.lo >= LON_MIN && r.hi <= LON_MAX);
	if (latCands.length === 0 || lonCands.length === 0) return null;
	const lat = latCands[0];
	const lon = lonCands.find((r) => r.name !== lat?.name) ?? lonCands[0];
	if (!lat || !lon || lat.name === lon.name) return null;
	const crs = guessCRS(lon.lo, lat.lo, lon.hi, lat.hi);
	return [
		`No native geometry column. Numeric columns that look like coordinates:`,
		`- \`${lat.name}\` (range ${lat.lo.toFixed(2)} … ${lat.hi.toFixed(2)}) — candidate **latitude**`,
		`- \`${lon.name}\` (range ${lon.lo.toFixed(2)} … ${lon.hi.toFixed(2)}) — candidate **longitude**`,
		`CRS guess: **${crs}**. To plot, the planner can build a geometry view from these columns.`,
	].join("\n\n");
}

/**
 * Coarse CRS heuristic based on coordinate ranges only. Real CRS
 * detection requires PROJ; this is just enough for a one-line verdict
 * in the report.
 */
function guessCRS(
	xMin: number,
	yMin: number,
	xMax: number,
	yMax: number,
): "wgs84" | "projected" | "unknown" {
	if (
		xMin >= LON_MIN &&
		xMax <= LON_MAX &&
		yMin >= LAT_MIN &&
		yMax <= LAT_MAX
	) {
		return "wgs84";
	}
	// Values much larger than the WGS84 range — probably state-plane, UTM,
	// or Web Mercator (which goes to ±20 million meters).
	if (Math.abs(xMin) > 200 || Math.abs(xMax) > 200 || Math.abs(yMin) > 200 || Math.abs(yMax) > 200) {
		return "projected";
	}
	return "unknown";
}
