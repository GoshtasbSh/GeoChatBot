/**
 * Runtime implementations for the inspection tools.
 *
 * Each function:
 *   1. Validates args via the tool's zod schema.
 *   2. Runs a small DuckDB query against a dataset that already lives
 *      in the engine (no fresh ingest, no network).
 *   3. Returns a SHORT, model-readable string. The agent loop appends
 *      this string to the LLM message history as the tool's "result"
 *      block.
 *
 * Why text output instead of structured JSON: the agent loop multiplexes
 * over four LLM providers (Anthropic / OpenAI / Gemini / Groq) and each
 * has slightly different rules for tool-result types. A uniform string
 * is the lowest common denominator and keeps the loop driver provider-
 * agnostic.
 */

import type { Table as ArrowTable } from 'apache-arrow';
import type { ExecutorEngine, DatasetEntry } from '../executor/types.js';
import { quoteIdent } from '../executor/sql-helpers.js';
import { validateSql } from '../validate-sql.js';
import { INSPECT_TOOLS } from './inspect-tools.js';

interface RunCtx {
  engine: ExecutorEngine;
  datasets: Map<string, DatasetEntry>;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const MAX_OUTPUT_CHARS = 1500;

function clip(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return `${s.slice(0, MAX_OUTPUT_CHARS - 20)}\n…(truncated)`;
}

function resolveDataset(name: string, ctx: RunCtx): DatasetEntry {
  const d = ctx.datasets.get(name);
  if (!d) {
    const known = [...ctx.datasets.keys()].map((k) => `"${k}"`).join(', ');
    throw new Error(`unknown dataset "${name}"; known: ${known || '(none loaded)'}`);
  }
  return d;
}

function arrowToObjs(t: ArrowTable): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const row of t.toArray()) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      o[k] = typeof v === 'bigint' ? Number(v) : v;
    }
    out.push(o);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* inspect.list_columns                                                       */
/* -------------------------------------------------------------------------- */

export async function runListColumns(
  args: unknown,
  ctx: RunCtx,
): Promise<string> {
  const { dataset } = INSPECT_TOOLS.list_columns.args.parse(args);
  const d = resolveDataset(dataset, ctx);
  const view = d.geomView ?? d.tableName;
  const t = await ctx.engine.query(
    `SELECT name, type, "null" AS nullable FROM pragma_table_info(${quoteIdent(view)})`,
  );
  const rows = arrowToObjs(t);
  const lines = rows.map(
    (r) => `${String(r['name'])}: ${String(r['type'])}${r['nullable'] ? ' (nullable)' : ''}`,
  );
  return clip(`columns of "${dataset}":\n${lines.join('\n')}`);
}

/* -------------------------------------------------------------------------- */
/* inspect.sample_rows                                                        */
/* -------------------------------------------------------------------------- */

export async function runSampleRows(
  args: unknown,
  ctx: RunCtx,
): Promise<string> {
  const { dataset, n } = INSPECT_TOOLS.sample_rows.args.parse(args);
  const d = resolveDataset(dataset, ctx);
  const view = d.tableName; // sample the raw table; geomView would dump WKB bytes
  const t = await ctx.engine.query(
    `SELECT * FROM ${quoteIdent(view)} LIMIT ${n}`,
  );
  const rows = arrowToObjs(t);
  const truncated = rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'string' && v.length > 80) o[k] = `${v.slice(0, 77)}...`;
      else o[k] = v;
    }
    return o;
  });
  return clip(
    `sample rows of "${dataset}" (showing ${rows.length}):\n${truncated
      .map((r) => JSON.stringify(r))
      .join('\n')}`,
  );
}

/* -------------------------------------------------------------------------- */
/* inspect.distinct_values                                                    */
/* -------------------------------------------------------------------------- */

export async function runDistinctValues(
  args: unknown,
  ctx: RunCtx,
): Promise<string> {
  const { dataset, column, k } = INSPECT_TOOLS.distinct_values.args.parse(args);
  const d = resolveDataset(dataset, ctx);
  const view = d.tableName;
  const t = await ctx.engine.query(
    `SELECT ${quoteIdent(column)} AS value, COUNT(*) AS cnt
     FROM ${quoteIdent(view)}
     WHERE ${quoteIdent(column)} IS NOT NULL
     GROUP BY 1
     ORDER BY cnt DESC
     LIMIT ${k}`,
  );
  const rows = arrowToObjs(t);
  if (rows.length === 0) {
    return `column "${column}" of "${dataset}" has no non-null values.`;
  }
  const lines = rows.map((r) => {
    let val = String(r['value']);
    if (val.length > 80) val = `${val.slice(0, 77)}...`;
    return `  ${JSON.stringify(val)}: ${r['cnt']}`;
  });
  return clip(
    `top ${rows.length} distinct values of "${column}" in "${dataset}":\n${lines.join('\n')}`,
  );
}

/* -------------------------------------------------------------------------- */
/* inspect.column_pattern                                                     */
/* -------------------------------------------------------------------------- */

interface PatternProbe {
  label: string;
  test: (s: string) => boolean;
}

const PATTERNS: PatternProbe[] = [
  { label: 'us_zip', test: (s) => /^\d{5}(-\d{4})?$/.test(s) },
  { label: 'email', test: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) },
  { label: 'phone_us', test: (s) => /^\+?1?[\s-]?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}$/.test(s) },
  { label: 'iso_country_code', test: (s) => /^[A-Z]{2,3}$/.test(s) },
  { label: 'us_state_abbr', test: (s) => /^(?:A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])$/i.test(s) },
  { label: 'datetime_iso', test: (s) => /^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2})?/.test(s) },
  { label: 'wkt_geometry', test: (s) => /^(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\s*\(/i.test(s) },
  // The street-suffix list matches both abbreviations ("ave", "rd") and
  // their full forms ("avenue", "road") because Nominatim/OSM data uses
  // both. The longer alternations are listed first so the regex engine
  // prefers them over their prefixes.
  { label: 'address_like', test: (s) => /^\d+\s+[A-Za-z]/.test(s) && /\b(avenue|street|road|boulevard|drive|lane|court|circle|highway|parkway|terrace|place|trail|ave|blvd|hwy|pkwy|ter|pl|st|rd|dr|ln|ct|cir|tr|way)\b/i.test(s) },
  { label: 'url', test: (s) => /^https?:\/\//i.test(s) },
];

export async function runColumnPattern(
  args: unknown,
  ctx: RunCtx,
): Promise<string> {
  const { dataset, column } = INSPECT_TOOLS.column_pattern.args.parse(args);
  const d = resolveDataset(dataset, ctx);
  const view = d.tableName;
  // Sample 50 non-null values; classify each; report the dominant pattern.
  const t = await ctx.engine.query(
    `SELECT CAST(${quoteIdent(column)} AS VARCHAR) AS v
     FROM ${quoteIdent(view)}
     WHERE ${quoteIdent(column)} IS NOT NULL
     LIMIT 50`,
  );
  const samples = arrowToObjs(t).map((r) => String(r['v']));
  if (samples.length === 0) {
    return `column "${column}" of "${dataset}" is entirely null.`;
  }
  const counts = new Map<string, number>();
  for (const s of samples) {
    const trimmed = s.trim();
    let matched = false;
    for (const p of PATTERNS) {
      if (p.test(trimmed)) {
        counts.set(p.label, (counts.get(p.label) ?? 0) + 1);
        matched = true;
        break;
      }
    }
    if (!matched) counts.set('free_text', (counts.get('free_text') ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0]!;
  const summary = ranked
    .map(([label, n]) => `${label}=${Math.round((n / samples.length) * 100)}%`)
    .join(', ');
  return clip(
    `column "${column}" of "${dataset}" pattern: dominant=${top[0]} (${summary}); ` +
      `examples=${JSON.stringify(samples.slice(0, 3))}`,
  );
}

/* -------------------------------------------------------------------------- */
/* inspect.probe_sql                                                          */
/* -------------------------------------------------------------------------- */

export async function runProbeSql(
  args: unknown,
  ctx: RunCtx,
): Promise<string> {
  const { query } = INSPECT_TOOLS.probe_sql.args.parse(args);
  // Same gate the planner's `sql` runner uses — SELECT/WITH only, no DDL,
  // no read_csv, no httpfs. Keeps an LLM probe from accidentally creating
  // a side-effect view that lives past the inspection phase.
  validateSql(query);
  const wrapped = `SELECT * FROM (${query}) _probe LIMIT 20`;
  const t = await ctx.engine.query(wrapped);
  const rows = arrowToObjs(t);
  const cols = t.schema.fields.map((f) => f.name);
  const head = `probe_sql returned ${rows.length} rows, columns=[${cols
    .map((c) => `"${c}"`)
    .join(', ')}]`;
  if (rows.length === 0) return head;
  const lines = rows
    .slice(0, 10)
    .map((r) => JSON.stringify(r))
    .map((s) => (s.length > 240 ? `${s.slice(0, 237)}...` : s));
  return clip(`${head}\n${lines.join('\n')}`);
}

/* -------------------------------------------------------------------------- */
/* dispatcher                                                                 */
/* -------------------------------------------------------------------------- */

export type InspectionRunner = (args: unknown, ctx: RunCtx) => Promise<string>;

export const INSPECT_RUNNERS: Record<string, InspectionRunner> = {
  [INSPECT_TOOLS.list_columns.id]: runListColumns,
  [INSPECT_TOOLS.sample_rows.id]: runSampleRows,
  [INSPECT_TOOLS.distinct_values.id]: runDistinctValues,
  [INSPECT_TOOLS.column_pattern.id]: runColumnPattern,
  [INSPECT_TOOLS.probe_sql.id]: runProbeSql,
};

export async function runInspection(
  toolId: string,
  args: unknown,
  ctx: RunCtx,
): Promise<string> {
  const runner = INSPECT_RUNNERS[toolId];
  if (!runner) {
    return `error: unknown inspection tool "${toolId}". valid: ${Object.keys(INSPECT_RUNNERS).join(', ')}`;
  }
  try {
    return await runner(args, ctx);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return `error running ${toolId}: ${m}`;
  }
}

export type { RunCtx as InspectionRunCtx };
