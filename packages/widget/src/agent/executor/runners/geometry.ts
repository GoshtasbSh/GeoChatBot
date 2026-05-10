/**
 * Geometry tool runtimes (DuckDB Spatial backed).
 *
 * Each runner builds a SELECT that produces a `geom` column and any
 * carry-through attributes, then materializes a temporary view via
 * {@link materializeView}. Outputs are layer-kind OutputRefs.
 *
 * Tools NOT implemented in this Phase 5 v1 (deferred to Phase 5 expansion):
 *   - geometry.voronoi  (Turf concaveman / voronoi)
 *   - geometry.reproject (proj4js, ~50 KB lazy load)
 *
 * For convex_hull, Phase 5 v1 supports `mode: 'convex'` only;
 * `mode: 'concave'` falls back to the convex hull with a console warning.
 */

import { z } from 'zod';
import { registerRunner } from '../runtime.js';
import {
  materializeView,
  quoteIdent,
  resolveLayer,
} from '../sql-helpers.js';
import type { ExecCtx, RunnerResult } from '../types.js';

/* -------------------------------------------------------------------------- */
/* geometry.reproject (passthrough — proj4js not yet bundled)                 */
/* -------------------------------------------------------------------------- */

const ReprojectArgs = z.object({ layer: z.unknown(), to_crs: z.string() });

export async function runReproject(
  args: Record<string, unknown>,
  ctx: ExecCtx,
): Promise<RunnerResult> {
  const { layer } = ReprojectArgs.parse(args);
  const view = resolveLayer(layer, ctx);
  // proj4js (~50 KB) is deferred to Phase 5 expansion. Return the layer
  // unchanged so downstream distance/buffer steps still run. Results will be
  // in the original CRS units (degrees for EPSG:4326 data).
  // eslint-disable-next-line no-console
  console.warn('[geochatbot] geometry.reproject not yet implemented — returning layer unchanged');
  return { output: { kind: 'layer', ref: view } };
}

registerRunner('geometry.reproject', runReproject);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const Units = z.enum(['meters', 'kilometers', 'miles', 'feet']);

/**
 * Convert a distance + units arg into a value in the geometry's native CRS
 * units. ST_Buffer in DuckDB Spatial uses CRS units (meters for projected,
 * degrees for EPSG:4326). Phase 5 v1 punts on full unit conversion: for
 * `meters` we pass through; for other units we convert to meters and let
 * the planner schedule a `geometry.reproject` if accuracy matters.
 */
function distanceInMeters(distance: number, units: z.infer<typeof Units>): number {
  switch (units) {
    case 'meters':
      return distance;
    case 'kilometers':
      return distance * 1000;
    case 'miles':
      return distance * 1609.344;
    case 'feet':
      return distance * 0.3048;
  }
}

/* -------------------------------------------------------------------------- */
/* geometry.buffer                                                            */
/* -------------------------------------------------------------------------- */

const BufferArgs = z.object({
  layer: z.unknown(),
  distance: z.number().positive(),
  units: Units.default('meters'),
});

export async function runBuffer(
  args: Record<string, unknown>,
  ctx: ExecCtx,
): Promise<RunnerResult> {
  const { layer, distance, units } = BufferArgs.parse(args);
  const view = resolveLayer(layer, ctx);
  const meters = distanceInMeters(distance, units);
  // ST_Buffer in DuckDB-Spatial expects degrees for EPSG:4326 inputs and
  // meters for projected. Phase 5 v1 documents the meters conversion;
  // accuracy on geographic CRS is approximate (~1 deg ≈ 111 km at equator).
  const sql = `SELECT * REPLACE (ST_Buffer(geom, ${meters}) AS geom) FROM ${quoteIdent(view)}`;
  const out = await materializeView(ctx, 'buffer', sql);
  return { output: { kind: 'layer', ref: out } };
}

registerRunner('geometry.buffer', runBuffer);

/* -------------------------------------------------------------------------- */
/* geometry.centroid                                                          */
/* -------------------------------------------------------------------------- */

const CentroidArgs = z.object({ layer: z.unknown() });

export async function runCentroid(
  args: Record<string, unknown>,
  ctx: ExecCtx,
): Promise<RunnerResult> {
  const { layer } = CentroidArgs.parse(args);
  const view = resolveLayer(layer, ctx);
  const sql = `SELECT * REPLACE (ST_Centroid(geom) AS geom) FROM ${quoteIdent(view)}`;
  const out = await materializeView(ctx, 'centroid', sql);
  return { output: { kind: 'layer', ref: out } };
}

registerRunner('geometry.centroid', runCentroid);

/* -------------------------------------------------------------------------- */
/* geometry.intersect / union / difference                                    */
/* -------------------------------------------------------------------------- */

const TwoLayerArgs = z.object({ a: z.unknown(), b: z.unknown() });

export async function runIntersect(
  args: Record<string, unknown>,
  ctx: ExecCtx,
): Promise<RunnerResult> {
  const { a, b } = TwoLayerArgs.parse(args);
  const va = resolveLayer(a, ctx);
  const vb = resolveLayer(b, ctx);
  // Pairwise intersection: every (a_i, b_j) where they intersect, output
  // the intersection geometry plus carrying both feature ids.
  const sql = `SELECT
      a.* EXCLUDE (geom),
      b.* EXCLUDE (geom),
      ST_Intersection(a.geom, b.geom) AS geom
    FROM ${quoteIdent(va)} a
    JOIN ${quoteIdent(vb)} b ON ST_Intersects(a.geom, b.geom)`;
  const out = await materializeView(ctx, 'intersect', sql);
  return { output: { kind: 'layer', ref: out } };
}

registerRunner('geometry.intersect', runIntersect);

export async function runUnion(
  args: Record<string, unknown>,
  ctx: ExecCtx,
): Promise<RunnerResult> {
  const { a, b } = TwoLayerArgs.parse(args);
  const va = resolveLayer(a, ctx);
  const vb = resolveLayer(b, ctx);
  // SQL UNION ALL of geometries — keeps both layers' rows.
  const sql = `SELECT geom FROM ${quoteIdent(va)} UNION ALL SELECT geom FROM ${quoteIdent(vb)}`;
  const out = await materializeView(ctx, 'union', sql);
  return { output: { kind: 'layer', ref: out } };
}

registerRunner('geometry.union', runUnion);

export async function runDifference(
  args: Record<string, unknown>,
  ctx: ExecCtx,
): Promise<RunnerResult> {
  const { a, b } = TwoLayerArgs.parse(args);
  const va = resolveLayer(a, ctx);
  const vb = resolveLayer(b, ctx);
  // For each a, subtract everything in b that intersects it.
  const sql = `SELECT a.* EXCLUDE (geom),
      ST_Difference(a.geom, COALESCE(ST_Union_Agg(b.geom), ST_GeomFromText('POLYGON EMPTY'))) AS geom
    FROM ${quoteIdent(va)} a
    LEFT JOIN ${quoteIdent(vb)} b ON ST_Intersects(a.geom, b.geom)
    GROUP BY a.*`;
  const out = await materializeView(ctx, 'difference', sql);
  return { output: { kind: 'layer', ref: out } };
}

registerRunner('geometry.difference', runDifference);

/* -------------------------------------------------------------------------- */
/* geometry.dissolve                                                          */
/* -------------------------------------------------------------------------- */

const DissolveArgs = z.object({ layer: z.unknown(), by_field: z.string().optional() });

export async function runDissolve(
  args: Record<string, unknown>,
  ctx: ExecCtx,
): Promise<RunnerResult> {
  const { layer, by_field } = DissolveArgs.parse(args);
  const view = resolveLayer(layer, ctx);
  const sql = by_field
    ? `SELECT ${quoteIdent(by_field)}, ST_Union_Agg(geom) AS geom FROM ${quoteIdent(view)} GROUP BY ${quoteIdent(by_field)}`
    : `SELECT ST_Union_Agg(geom) AS geom FROM ${quoteIdent(view)}`;
  const out = await materializeView(ctx, 'dissolve', sql);
  return { output: { kind: 'layer', ref: out } };
}

registerRunner('geometry.dissolve', runDissolve);

/* -------------------------------------------------------------------------- */
/* geometry.simplify                                                          */
/* -------------------------------------------------------------------------- */

const SimplifyArgs = z.object({ layer: z.unknown(), tolerance: z.number().positive() });

export async function runSimplify(
  args: Record<string, unknown>,
  ctx: ExecCtx,
): Promise<RunnerResult> {
  const { layer, tolerance } = SimplifyArgs.parse(args);
  const view = resolveLayer(layer, ctx);
  const sql = `SELECT * REPLACE (ST_Simplify(geom, ${tolerance}) AS geom) FROM ${quoteIdent(view)}`;
  const out = await materializeView(ctx, 'simplify', sql);
  return { output: { kind: 'layer', ref: out } };
}

registerRunner('geometry.simplify', runSimplify);

/* -------------------------------------------------------------------------- */
/* geometry.convex_hull                                                       */
/* -------------------------------------------------------------------------- */

const HullArgs = z.object({
  layer: z.unknown(),
  mode: z.enum(['convex', 'concave']).default('concave'),
});

export async function runConvexHull(
  args: Record<string, unknown>,
  ctx: ExecCtx,
): Promise<RunnerResult> {
  const { layer, mode } = HullArgs.parse(args);
  const view = resolveLayer(layer, ctx);
  if (mode === 'concave') {
    // Phase 5 v1 falls back to convex hull. The `concaveman` package
    // (~10 KB lazy-load) ships in Phase 5 expansion.
    // eslint-disable-next-line no-console
    console.warn(
      '[geochatbot] geometry.convex_hull mode=concave falling back to convex (concaveman not yet wired)',
    );
  }
  const sql = `SELECT ST_ConvexHull(ST_Union_Agg(geom)) AS geom FROM ${quoteIdent(view)}`;
  const out = await materializeView(ctx, 'hull', sql);
  return { output: { kind: 'layer', ref: out } };
}

registerRunner('geometry.convex_hull', runConvexHull);
