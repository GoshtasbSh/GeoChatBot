/**
 * `stats.*` tool runtimes — DuckDB SQL only.
 *
 * Implemented in Phase 5 v1:
 *   - stats.aggregate
 *   - stats.summary_stats
 *   - stats.distance_matrix
 *
 * Deferred to Phase 5 expansion (require extra deps or custom JS):
 *   - stats.hex_bin       (h3-js)
 *   - stats.density_grid  (custom CTE-based fishnet, ~80 LOC)
 *   - stats.morans_i      (custom JS, ~100 LOC)
 *   - stats.getis_ord_gi  (custom JS, ~150 LOC)
 *
 * Calling a deferred tool returns an explicit "not yet implemented"
 * error rather than silently failing.
 */

import { z } from 'zod';
import { registerRunner } from '../runtime.js';
import {
  materializeView,
  quoteIdent,
  quoteString,
  resolveTable,
} from '../sql-helpers.js';
import type { ExecCtx, RunnerResult } from '../types.js';

const AggFn = z.enum(['sum', 'mean', 'median', 'count', 'min', 'max']);

function aggFnSql(fn: z.infer<typeof AggFn>, col: string): string {
  const ident = quoteIdent(col);
  switch (fn) {
    case 'sum':
      return `SUM(${ident})`;
    case 'mean':
      return `AVG(${ident})`;
    case 'median':
      return `MEDIAN(${ident})`;
    case 'count':
      return `COUNT(${ident})`;
    case 'min':
      return `MIN(${ident})`;
    case 'max':
      return `MAX(${ident})`;
  }
}

/* -------------------------------------------------------------------------- */
/* stats.aggregate                                                            */
/* -------------------------------------------------------------------------- */

const AggregateArgs = z.object({
  layer: z.unknown(),
  group_by: z.union([z.string(), z.array(z.string()).min(1)]),
  agg_fn: AggFn,
  value_col: z.string(),
});

export async function runAggregate(
  args: Record<string, unknown>,
  ctx: ExecCtx,
): Promise<RunnerResult> {
  const { layer, group_by, agg_fn, value_col } = AggregateArgs.parse(args);
  const view = resolveTable(layer, ctx);
  const groups = Array.isArray(group_by) ? group_by : [group_by];
  const groupSql = groups.map(quoteIdent).join(', ');
  const aggExpr = aggFnSql(agg_fn, value_col);
  const sql = `SELECT ${groupSql}, ${aggExpr} AS ${quoteIdent(`${agg_fn}_${value_col}`)} FROM ${quoteIdent(view)} GROUP BY ${groupSql}`;
  const out = await materializeView(ctx, 'agg', sql);
  return { output: { kind: 'table', ref: out } };
}

registerRunner('stats.aggregate', runAggregate);

/* -------------------------------------------------------------------------- */
/* stats.summary_stats                                                        */
/* -------------------------------------------------------------------------- */

const SummaryStatsArgs = z.object({
  layer: z.unknown(),
  columns: z.array(z.string()).min(1),
});

export async function runSummaryStats(
  args: Record<string, unknown>,
  ctx: ExecCtx,
): Promise<RunnerResult> {
  const { layer, columns } = SummaryStatsArgs.parse(args);
  const view = resolveTable(layer, ctx);
  // One UNION ALL row per column, projecting count/min/max/mean/median/std.
  const parts = columns.map((c) => {
    const ident = quoteIdent(c);
    return `SELECT
        ${quoteString(c)} AS column,
        COUNT(${ident})::DOUBLE AS count,
        MIN(${ident})::DOUBLE AS min,
        MAX(${ident})::DOUBLE AS max,
        AVG(${ident})::DOUBLE AS mean,
        MEDIAN(${ident})::DOUBLE AS median,
        STDDEV_POP(${ident})::DOUBLE AS std
      FROM ${quoteIdent(view)}`;
  });
  const sql = parts.join(' UNION ALL ');
  const out = await materializeView(ctx, 'summary', sql);
  return { output: { kind: 'table', ref: out } };
}

registerRunner('stats.summary_stats', runSummaryStats);

/* -------------------------------------------------------------------------- */
/* stats.distance_matrix                                                      */
/* -------------------------------------------------------------------------- */

const DistanceMatrixArgs = z.object({
  a: z.unknown(),
  b: z.unknown(),
  k: z.number().int().positive().optional(),
});

export async function runDistanceMatrix(
  args: Record<string, unknown>,
  ctx: ExecCtx,
): Promise<RunnerResult> {
  const { a, b, k } = DistanceMatrixArgs.parse(args);
  const va = resolveTable(a, ctx);
  const vb = resolveTable(b, ctx);
  const baseSql = `SELECT a.rowid AS a_id, b.rowid AS b_id, ST_Distance(a.geom, b.geom) AS distance
    FROM ${quoteIdent(va)} a CROSS JOIN ${quoteIdent(vb)} b`;
  let sql = baseSql;
  if (k !== undefined) {
    sql = `WITH pairs AS (
        ${baseSql}
      ), ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY a_id ORDER BY distance) AS rn FROM pairs
      )
      SELECT a_id, b_id, distance FROM ranked WHERE rn <= ${k}`;
  }
  const out = await materializeView(ctx, 'distmat', sql);
  return { output: { kind: 'table', ref: out } };
}

registerRunner('stats.distance_matrix', runDistanceMatrix);

/* -------------------------------------------------------------------------- */
/* Deferred tools — explicit "not yet implemented" stubs                      */
/* -------------------------------------------------------------------------- */

function deferred(toolId: string): import('../types.js').RuntimeRunner {
  return async () => {
    throw new Error(
      `${toolId} is not implemented in Phase 5 v1 (deferred to Phase 5 expansion)`,
    );
  };
}

registerRunner('stats.hex_bin', deferred('stats.hex_bin'));
registerRunner('stats.density_grid', deferred('stats.density_grid'));
registerRunner('stats.morans_i', deferred('stats.morans_i'));
registerRunner('stats.getis_ord_gi', deferred('stats.getis_ord_gi'));
registerRunner('geometry.voronoi', deferred('geometry.voronoi'));
registerRunner('geometry.reproject', deferred('geometry.reproject'));
