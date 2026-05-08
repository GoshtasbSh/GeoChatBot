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
import { materializeView } from '../sql-helpers.js';
import type { ExecCtx, RunnerResult } from '../types.js';

const SqlArgs = z.object({ query: z.string().min(1) });

export async function runSql(
  args: Record<string, unknown>,
  ctx: ExecCtx,
): Promise<RunnerResult> {
  const { query } = SqlArgs.parse(args);
  validateSql(query);
  const view = await materializeView(ctx, 'sql', query);
  return { output: { kind: 'table', ref: view } };
}

registerRunner('sql', runSql);
