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

import { z } from 'zod';
import { validateSql } from '../../validate-sql.js';
import { registerRunner } from '../runtime.js';
import { materializeView, quoteIdent } from '../sql-helpers.js';
import type { ExecCtx, RunnerResult } from '../types.js';

const SqlArgs = z.object({ query: z.string().min(1) });

export async function runSql(
  args: Record<string, unknown>,
  ctx: ExecCtx,
): Promise<RunnerResult> {
  const { query } = SqlArgs.parse(args);
  validateSql(query);
  const view = await materializeView(ctx, 'sql', query);
  // Detect whether the resulting view exposes a `geom` column. SQL
  // operating on a `_geom` view via SELECT * preserves the column, so
  // the output is layer-shaped and can flow into spatial runners.
  // Without this, every `sql` output is `kind:'table'` and the new
  // `resolveLayer` kind check (NH3) would falsely reject the chain
  // `sql → geometry.buffer` even when the SQL SELECTed the geometry.
  const hasGeom = await viewHasGeomColumn(ctx, view);
  return { output: { kind: hasGeom ? 'layer' : 'table', ref: view } };
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

registerRunner('sql', runSql);
