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

const PARTIAL_VAR = /\$\{([a-z_][a-z0-9_]*)\}/g;

export async function runRenderSummary(
  args: Record<string, unknown>,
  ctx: ExecCtx,
): Promise<RunnerResult> {
  const { text: rawText } = SummaryArgs.parse(args);
  // Resolve inline ${var} references in summary text. The main substitute()
  // pass only handles whole-string ${var} (to block SQL injection), so an
  // LLM that writes "There are ${count} rows." would produce a literal
  // placeholder. Here we safely expand partial matches: we look up the output
  // ref, query the first value from the resulting view, and substitute.
  let text = rawText;
  for (const m of [...rawText.matchAll(PARTIAL_VAR)]) {
    const [placeholder, varName] = m;
    const ref = ctx.outputs.get(varName!);
    if (!ref || (ref.kind !== 'table' && ref.kind !== 'layer')) continue;
    try {
      const at = await ctx.engine.query(
        `SELECT * FROM ${quoteIdent(ref.ref as string)} LIMIT 1`,
      );
      if (at.numRows === 0) continue;
      const row = at.toArray()[0] as Record<string, unknown>;
      const firstField = at.schema.fields[0]?.name;
      if (!firstField) continue;
      const val = row[firstField];
      if (val === null || val === undefined) continue;
      text = text.replace(placeholder!, String(typeof val === 'bigint' ? Number(val) : val));
    } catch {
      // Leave the placeholder intact — the summary still renders with the raw token.
    }
  }
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
  // FeatureCollection on the JS side. If the view has no `geom` column we
  // fall back to synthesising one from common lat/lon column pairs — a CSV
  // upload with `latitude`/`longitude` columns then "just works" without the
  // user needing to ask for an explicit ST_Point step first.
  const layerLabel = typeof layer === 'string' ? layer : view;
  let at: import('apache-arrow').Table | null = null;
  let fallbackSummary: string | null = null;
  try {
    at = await ctx.engine.query(
      `SELECT ST_AsGeoJSON(geom) AS __geom_json__, * EXCLUDE (geom) FROM ${quoteIdent(view)} LIMIT ${MAX_RESULT_ROWS}`,
    );
  } catch (err: unknown) {
    if (!isMissingGeomError(err)) throw err;
    const latlon = await detectLatLonColumns(ctx, view);
    if (latlon) {
      const lonCol = quoteIdent(latlon.lon);
      const latCol = quoteIdent(latlon.lat);
      at = await ctx.engine.query(
        `SELECT ST_AsGeoJSON(ST_Point(${lonCol}, ${latCol})) AS __geom_json__, * FROM ${quoteIdent(view)} LIMIT ${MAX_RESULT_ROWS}`,
      );
    } else {
      // No geometry, no detectable lat/lon. Suggest geocoding if there
      // are any address-like columns; otherwise tell the user the
      // dataset can't be mapped. Fall back to a summary payload so the
      // user sees a clear next step instead of an opaque thrown error.
      fallbackSummary = await buildNoGeometryHint(ctx, view, layerLabel);
    }
  }
  if (fallbackSummary !== null) {
    const payload: ResultPayload = { kind: 'summary', text: fallbackSummary };
    return { output: { kind: 'rendered', ref: 'map' }, payload };
  }
  if (at === null) {
    // Defensive — neither path produced a table; treat as a summary.
    const payload: ResultPayload = {
      kind: 'summary',
      text: `Could not render "${layerLabel}" as a map: query returned no rows.`,
    };
    return { output: { kind: 'rendered', ref: 'map' }, payload };
  }
  const rows = arrowToJsonRows(at);
  // Build features — skip rows with null/unparseable geometry. A row
  // with `geom IS NULL` would otherwise count toward the "N features"
  // badge while contributing nothing to the map view; the badge would
  // overstate coverage and the user would see "5 features" but no
  // points. Honest count beats marketing.
  let nullGeomCount = 0;
  const features: Array<{ type: 'Feature'; geometry: unknown; properties: Record<string, unknown> }> = [];
  for (const r of rows) {
    const geomJson = r['__geom_json__'];
    const geometry = typeof geomJson === 'string' ? safeParseJson(geomJson) : geomJson;
    if (geometry == null || typeof (geometry as { type?: unknown }).type !== 'string') {
      nullGeomCount++;
      continue;
    }
    const properties: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (k !== '__geom_json__') properties[k] = v;
    }
    features.push({ type: 'Feature', geometry, properties });
  }
  if (features.length === 0) {
    // Every row had null geometry. Don't render an empty map silently —
    // surface a summary so the user sees actionable feedback.
    const text = nullGeomCount > 0
      ? `Could not render "${layerLabel}" as a map: all ${nullGeomCount} rows had no geometry. ` +
        `If this layer came from geocoding, no addresses resolved; check the planner's geocode step error.`
      : `Could not render "${layerLabel}" as a map: no rows returned.`;
    const payload: ResultPayload = { kind: 'summary', text };
    return { output: { kind: 'rendered', ref: 'map' }, payload };
  }
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
 * Heuristic helper for the "no geometry, no lat/lon" branch of render.map.
 * Looks at the view's columns and produces a one-paragraph hint pointing
 * the user toward the right next step (geocoding for address columns,
 * otherwise an explanation that the dataset cannot be mapped).
 */
async function buildNoGeometryHint(
  ctx: ExecCtx,
  view: string,
  layerLabel: string,
): Promise<string> {
  let cols: string[] = [];
  try {
    const tbl = await ctx.engine.query(
      `SELECT name FROM pragma_table_info(${quoteIdent(view)})`,
    );
    cols = (tbl.toArray() as Array<{ name: unknown }>).map((r) => String(r.name));
  } catch {
    // Falls through with empty col list.
  }
  const lower = cols.map((c) => c.toLowerCase());
  const ADDRESS_HINTS = [
    'address', 'addr', 'street', 'street1', 'street_address',
    'city', 'town', 'state', 'region', 'province',
    'zip', 'postal', 'postcode', 'country',
  ];
  const matches = cols.filter((_, i) => ADDRESS_HINTS.some((h) => lower[i]?.includes(h)));
  if (matches.length > 0) {
    return (
      `Cannot map "${layerLabel}" yet: the dataset has no geometry and no lat/lon columns, ` +
      `but it does have address-like columns (${matches.slice(0, 4).map((c) => `"${c}"`).join(', ')}). ` +
      `Ask "geocode the addresses and show on a map" — and include the city or state in your question if the ` +
      `address column is just a street name (e.g. "geocode this Cedar Key, FL survey on a map") so the ` +
      `geocoder can disambiguate.`
    );
  }
  return (
    `Cannot map "${layerLabel}": no geometry column, no lat/lon columns, and no address-like columns ` +
    `were found. Available columns: ${cols.slice(0, 8).map((c) => `"${c}"`).join(', ')}` +
    (cols.length > 8 ? `, …` : '') + '. ' +
    `Use a chart or table query, or upload a dataset with coordinates / addresses.`
  );
}

/**
 * Inspect a view's columns and return a likely (lon, lat) pair if one exists.
 * Used by render.map's fallback path so a CSV upload with `latitude` /
 * `longitude` columns renders as points without the user having to compose an
 * explicit ST_Point step.
 */
async function detectLatLonColumns(
  ctx: ExecCtx,
  view: string,
): Promise<{ lon: string; lat: string } | null> {
  let cols: string[];
  try {
    const tbl = await ctx.engine.query(
      `SELECT name FROM pragma_table_info(${quoteIdent(view)})`,
    );
    cols = (tbl.toArray() as Array<{ name: unknown }>).map((r) => String(r.name));
  } catch {
    return null;
  }
  const lower = new Map(cols.map((c) => [c.toLowerCase(), c]));
  // Prefer the most explicit names first; ties are broken by the first match.
  const lonAliases = ['longitude', 'long', 'lon', 'lng', 'x'];
  const latAliases = ['latitude', 'lat', 'y'];
  let lon: string | undefined;
  let lat: string | undefined;
  for (const a of lonAliases) {
    const m = lower.get(a);
    if (m) { lon = m; break; }
  }
  for (const a of latAliases) {
    const m = lower.get(a);
    if (m) { lat = m; break; }
  }
  return lon && lat ? { lon, lat } : null;
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
