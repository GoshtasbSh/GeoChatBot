/**
 * `render.*` tool runtimes.
 *
 * Renderers always produce a `ResultPayload` so that the host element
 * can either dispatch it as a `result` event (headless mode) or mount
 * a Shadow DOM widget (full mode) — the payload is identical in both
 * paths. The runners themselves do NOT touch the DOM, which keeps the
 * worker-isolation contract simple and the runners testable.
 */

import { z } from 'zod';
import { registerRunner } from '../runtime.js';
import { quoteIdent, resolveAny } from '../sql-helpers.js';
import type { ExecCtx, ResultPayload, RunnerResult } from '../types.js';

/** Cap rows pulled from DuckDB into a result payload. */
const MAX_RESULT_ROWS = 5_000;
/**
 * Hard cap on summary text. The LLM is supposed to produce a short,
 * human-readable answer; an unbounded string here can DoS the host page
 * (Lit text node insertion is O(n)) and explode `result` event payloads
 * being relayed to integrators. 10 KB ≈ ~2k words.
 */
const MAX_SUMMARY_CHARS = 10_000;

/* -------------------------------------------------------------------------- */
/* render.summary                                                             */
/* -------------------------------------------------------------------------- */

const SummaryArgs = z.object({ text: z.string().min(1).max(MAX_SUMMARY_CHARS) });

export async function runRenderSummary(
  args: Record<string, unknown>,
): Promise<RunnerResult> {
  const { text } = SummaryArgs.parse(args);
  const payload: ResultPayload = { kind: 'summary', text };
  return { output: { kind: 'rendered', ref: 'summary' }, payload };
}

registerRunner('render.summary', runRenderSummary);

/* -------------------------------------------------------------------------- */
/* render.table                                                               */
/* -------------------------------------------------------------------------- */

const TableArgs = z.object({ table: z.unknown() });

export async function runRenderTable(
  args: Record<string, unknown>,
  ctx: ExecCtx,
): Promise<RunnerResult> {
  const { table } = TableArgs.parse(args);
  const view = resolveAny(table, ctx);
  const at = await ctx.engine.query(
    `SELECT * EXCLUDE (geom) FROM ${quoteIdent(view)} LIMIT ${MAX_RESULT_ROWS}`,
  ).catch(async (err: unknown) => {
    // Only retry without EXCLUDE when DuckDB specifically reports the
    // `geom` column is missing. Other errors (engine offline, missing
    // table, permission) must propagate so the caller sees the real
    // cause instead of a confusing second error from the retry path.
    if (!isMissingGeomError(err)) throw err;
    return ctx.engine.query(`SELECT * FROM ${quoteIdent(view)} LIMIT ${MAX_RESULT_ROWS}`);
  });
  const rows = arrowToJsonRows(at);
  const columns = at.schema.fields.map((f) => f.name);
  return {
    output: { kind: 'rendered', ref: 'table' },
    payload: { kind: 'table', rows, columns },
  };
}

registerRunner('render.table', runRenderTable);

/* -------------------------------------------------------------------------- */
/* render.chart                                                               */
/* -------------------------------------------------------------------------- */

const ChartArgs = z.object({
  table: z.unknown(),
  kind: z.enum(['bar', 'line', 'scatter', 'pie', 'grouped_bar']),
  x: z.string(),
  y: z.string(),
  group: z.string().optional(),
});

export async function runRenderChart(
  args: Record<string, unknown>,
  ctx: ExecCtx,
): Promise<RunnerResult> {
  const { table, kind, x, y, group } = ChartArgs.parse(args);
  const view = resolveAny(table, ctx);
  const cols = group
    ? `${quoteIdent(x)} AS x, ${quoteIdent(y)} AS y, ${quoteIdent(group)} AS "group"`
    : `${quoteIdent(x)} AS x, ${quoteIdent(y)} AS y`;
  const at = await ctx.engine.query(
    `SELECT ${cols} FROM ${quoteIdent(view)} LIMIT ${MAX_RESULT_ROWS}`,
  );
  const data = arrowToJsonRows(at);
  return {
    output: { kind: 'rendered', ref: 'chart' },
    payload: {
      kind: 'chart',
      spec: {
        kind,
        x,
        y,
        ...(group ? { group } : {}),
        data,
      },
    },
  };
}

registerRunner('render.chart', runRenderChart);

/* -------------------------------------------------------------------------- */
/* render.map                                                                 */
/* -------------------------------------------------------------------------- */

const MapArgs = z.object({
  layer: z.unknown(),
  style: z.record(z.unknown()).optional(),
});

export async function runRenderMap(
  args: Record<string, unknown>,
  ctx: ExecCtx,
): Promise<RunnerResult> {
  const { layer, style } = MapArgs.parse(args);
  const view = resolveAny(layer, ctx);
  // ST_AsGeoJSON(geom) returns a GeoJSON geometry STRING; properties are the
  // remaining columns. We materialize one row per feature and assemble a
  // FeatureCollection on the JS side.
  const at = await ctx.engine.query(
    `SELECT ST_AsGeoJSON(geom) AS __geom_json__, * EXCLUDE (geom) FROM ${quoteIdent(view)} LIMIT ${MAX_RESULT_ROWS}`,
  );
  const rows = arrowToJsonRows(at);
  const features = rows.map((r) => {
    const geomJson = r['__geom_json__'];
    const properties: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (k !== '__geom_json__') properties[k] = v;
    }
    return {
      type: 'Feature',
      geometry: typeof geomJson === 'string' ? safeParseJson(geomJson) : geomJson,
      properties,
    };
  });
  // Prefer the planner-supplied `output_var` over the internal DuckDB
  // view name. The internal name (e.g. `gcb_buffer_s2_3`) is a runtime
  // artifact and would leak through the public `result` event payload to
  // integrators. Fall back to the view name only if the step has no
  // `output_var`. If the original arg was a plain dataset string, that's
  // the most user-meaningful name we have.
  const layerName =
    ctx.step.output_var ?? (typeof layer === 'string' ? layer : view);
  const payload: ResultPayload = {
    kind: 'layer',
    geojson: { type: 'FeatureCollection', features },
    name: layerName,
    ...(style ? { style } : {}),
  };
  return { output: { kind: 'rendered', ref: 'map' }, payload };
}

registerRunner('render.map', runRenderMap);

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * True when the engine's error indicates the `geom` column is absent in
 * the queried view — the only error condition where retrying without
 * `EXCLUDE (geom)` is correct. Matches the error messages DuckDB emits
 * for missing-column lookups; falls open to `false` on unrelated errors.
 */
function isMissingGeomError(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message
      : typeof err === 'string' ? err
      : '';
  if (!message) return false;
  const m = message.toLowerCase();
  // DuckDB phrasings: "Referenced column \"geom\" not found",
  // "Binder Error: Referenced column 'geom' not found in FROM clause",
  // "no column named geom".
  return /geom/.test(m) && /(not found|does not exist|no column|unknown column|binder error)/.test(m);
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Convert an Apache Arrow Table to plain JSON rows. Handles BigInt → Number
 * coercion (BigInt isn't JSON-serializable and most chart libs choke on it).
 */
function arrowToJsonRows(
  table: import('apache-arrow').Table,
): Array<Record<string, unknown>> {
  const rows = table.toArray();
  const out: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
      obj[k] = typeof v === 'bigint' ? Number(v) : v;
    }
    out.push(obj);
  }
  return out;
}
