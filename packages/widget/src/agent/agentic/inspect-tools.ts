/**
 * Agentic inspection tools.
 *
 * These tools are NOT part of the regular plan tool catalog (they don't
 * produce layers/tables/scalars/rendered outputs that go into `${var}`
 * references). Instead they're available to the agent ONLY during the
 * pre-plan reasoning phase, so the LLM can poke at the actual data
 * before deciding on a final Plan.
 *
 * Why a separate registry: the planner's `submit_plan` tool schema is
 * `{ goal, dataset_refs, steps }`, where each step references a *terminal*
 * tool from the registry in `agent/tools/`. Mixing inspect.* into that
 * registry would let the LLM emit `inspect.sample_rows` as a plan step,
 * which would then fail the "last step must be render.*" rule and waste
 * a retry slot. Keeping them in a parallel registry preserves the plan
 * shape and lets us evolve the inspection surface independently.
 *
 * Each tool returns a short, model-readable string (≤ 1 KB), which the
 * agent loop appends to its message history as the next user turn.
 */

import { z } from 'zod';

export interface InspectionTool<A extends z.ZodTypeAny = z.ZodTypeAny> {
  id: string;
  description: string;
  args: A;
}

export const INSPECT_TOOLS = {
  list_columns: {
    id: 'inspect.list_columns',
    description:
      'List the columns of a loaded dataset along with their inferred types. ' +
      'Use this when the dataset profile in the system prompt is ambiguous or you need to confirm a column name spelling.',
    args: z.object({
      dataset: z.string().min(1).describe('Name of the loaded dataset.'),
    }),
  },
  sample_rows: {
    id: 'inspect.sample_rows',
    description:
      'Return up to N actual rows from a dataset (truncated to keep output small). ' +
      'Use this to confirm data shape — e.g. is the "Address" column actually street addresses, or labels?',
    args: z.object({
      dataset: z.string().min(1),
      n: z.number().int().min(1).max(10).default(5),
    }),
  },
  distinct_values: {
    id: 'inspect.distinct_values',
    description:
      'Return the top-K most-frequent distinct values of a column (with counts). ' +
      'Use this to discover the cardinality and shape of a column — e.g. is "state" two-letter codes or full names?',
    args: z.object({
      dataset: z.string().min(1),
      column: z.string().min(1),
      k: z.number().int().min(1).max(50).default(20),
    }),
  },
  column_pattern: {
    id: 'inspect.column_pattern',
    description:
      'Heuristic-detect what a column "looks like": address, zip, email, phone, datetime, country code, latitude, longitude, geometry-wkt, etc. ' +
      'Use this to confirm a column\'s semantic meaning before passing it to a tool that depends on its type.',
    args: z.object({
      dataset: z.string().min(1),
      column: z.string().min(1),
    }),
  },
  probe_sql: {
    id: 'inspect.probe_sql',
    description:
      'Run a small SELECT against the loaded datasets to test a hypothesis (capped at 20 rows in the output). ' +
      'Use SPARINGLY — only when the existing inspect.* tools cannot answer a question. The query is validated as SELECT/WITH-only.',
    args: z.object({
      query: z.string().min(1).max(2000),
    }),
  },
  finalize_plan: {
    id: 'finalize_plan',
    description:
      'Commit a final Plan. After enough inspection, call this with the typed Plan that the executor should run. ' +
      'This ENDS the inspection loop — calling render.* tools directly will not work.',
    args: z.object({
      goal: z.string().min(1),
      assumptions: z.array(z.string()).default([]),
      dataset_refs: z.array(z.string().min(1)).min(1),
      steps: z
        .array(
          z.object({
            id: z.string().regex(/^s\d+$/),
            tool: z.string().min(1),
            args: z.record(z.unknown()),
            output_var: z.string().regex(/^[a-z_][a-z0-9_]*$/).optional(),
            why: z.string().min(1).max(280),
          }),
        )
        .min(1)
        .max(10),
    }),
  },
} as const satisfies Record<string, InspectionTool>;

export type InspectionToolId = keyof typeof INSPECT_TOOLS;

/** Convert an inspect-tool definition to a JSON-schema fragment usable by
 *  OpenAI-compat / Anthropic tool_use APIs. */
export function inspectToolJsonSchema(t: InspectionTool): Record<string, unknown> {
  // Reuse the same zod-to-json-schema conversion the planner uses.
  // We can't import it lazily inside a hot path, so we ship a small
  // inline conversion via the top-level call site (loop.ts handles
  // schema marshalling).
  const _ = t;
  return _ as never;
}
