/**
 * `joins.*` tool runtimes (DuckDB Spatial backed).
 *
 *   joins.spatial_join      — predicate JOIN over two layers
 *   joins.point_in_polygon  — alias to spatial_join with predicate='within'
 *   joins.nearest_neighbor  — k nearest features in b for each row in a
 */

import { z } from 'zod';
import { registerRunner } from '../runtime.js';
import {
  materializeView,
  quoteIdent,
  resolveLayer,
} from '../sql-helpers.js';
import type { ExecCtx, RunnerResult } from '../types.js';

const Predicate = z.enum(['within', 'intersects', 'contains', 'touches']);

function predicateSql(p: z.infer<typeof Predicate>): string {
  switch (p) {
    case 'within':
      return 'ST_Within(a.geom, b.geom)';
    case 'intersects':
      return 'ST_Intersects(a.geom, b.geom)';
    case 'contains':
      return 'ST_Contains(a.geom, b.geom)';
    case 'touches':
      return 'ST_Touches(a.geom, b.geom)';
  }
}

/* -------------------------------------------------------------------------- */
/* joins.spatial_join                                                         */
/* -------------------------------------------------------------------------- */

const SpatialJoinArgs = z.object({
  a: z.unknown(),
  b: z.unknown(),
  predicate: Predicate,
});

export async function runSpatialJoin(
  args: Record<string, unknown>,
  ctx: ExecCtx,
): Promise<RunnerResult> {
  const { a, b, predicate } = SpatialJoinArgs.parse(args);
  const va = resolveLayer(a, ctx);
  const vb = resolveLayer(b, ctx);
  const sql = `SELECT a.* EXCLUDE (geom), b.* EXCLUDE (geom), a.geom AS geom
    FROM ${quoteIdent(va)} a
    JOIN ${quoteIdent(vb)} b ON ${predicateSql(predicate)}`;
  const out = await materializeView(ctx, 'sjoin', sql);
  return { output: { kind: 'layer', ref: out } };
}

registerRunner('joins.spatial_join', runSpatialJoin);

/* -------------------------------------------------------------------------- */
/* joins.point_in_polygon                                                     */
/* -------------------------------------------------------------------------- */

const PipArgs = z.object({ points: z.unknown(), polygons: z.unknown() });

export async function runPointInPolygon(
  args: Record<string, unknown>,
  ctx: ExecCtx,
): Promise<RunnerResult> {
  const { points, polygons } = PipArgs.parse(args);
  return runSpatialJoin({ a: points, b: polygons, predicate: 'within' }, ctx);
}

registerRunner('joins.point_in_polygon', runPointInPolygon);

/* -------------------------------------------------------------------------- */
/* joins.nearest_neighbor                                                     */
/* -------------------------------------------------------------------------- */

const NearestArgs = z.object({
  a: z.unknown(),
  b: z.unknown(),
  k: z.number().int().positive(),
});

export async function runNearestNeighbor(
  args: Record<string, unknown>,
  ctx: ExecCtx,
): Promise<RunnerResult> {
  const { a, b, k } = NearestArgs.parse(args);
  const va = resolveLayer(a, ctx);
  const vb = resolveLayer(b, ctx);
  // rowid is unavailable on DuckDB views; materialise surrogate ids first.
  const sql = `WITH
      _a AS (SELECT ROW_NUMBER() OVER () AS _gcb_rid, * FROM ${quoteIdent(va)}),
      _b AS (SELECT ROW_NUMBER() OVER () AS _gcb_rid, * FROM ${quoteIdent(vb)}),
      pairs AS (
        SELECT
          a._gcb_rid AS a_id,
          b._gcb_rid AS b_id,
          ST_Distance(a.geom, b.geom) AS distance,
          ROW_NUMBER() OVER (
            PARTITION BY a._gcb_rid ORDER BY ST_Distance(a.geom, b.geom)
          ) AS rn
        FROM _a a CROSS JOIN _b b
      )
    SELECT a_id, b_id, distance FROM pairs WHERE rn <= ${k}`;
  const out = await materializeView(ctx, 'nearest', sql);
  return { output: { kind: 'table', ref: out } };
}

registerRunner('joins.nearest_neighbor', runNearestNeighbor);
