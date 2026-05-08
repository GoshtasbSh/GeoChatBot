import { z } from 'zod';

/** Step-level identifier; deterministic format `s<n>`. */
const StepIdRegex = /^s\d+$/;

/** Variable names referenced via `${name}`. snake_case ASCII. */
const OutputVarRegex = /^[a-z_][a-z0-9_]*$/;

export const StepSchema = z.object({
  id: z.string().regex(StepIdRegex),
  tool: z.string().min(1),
  args: z.record(z.unknown()),
  output_var: z.string().regex(OutputVarRegex).optional(),
  why: z.string().min(1).max(280),
});

export const PlanSchema = z.object({
  goal: z.string().min(1),
  assumptions: z.array(z.string()).default([]),
  // Each element must be a non-empty string. Dedup is enforced in
  // validate-plan.ts (the schema itself can't easily express "no
  // duplicates" without a refine, and the same plan-level error type
  // already handles duplicate step ids).
  dataset_refs: z.array(z.string().min(1)).min(1),
  steps: z.array(StepSchema).min(1).max(10),
});

export type Plan = z.infer<typeof PlanSchema>;
export type Step = z.infer<typeof StepSchema>;

export type ToolOutputKind = 'layer' | 'table' | 'scalar' | 'rendered';

/** Runtime reference to a step output. Populated by the executor. */
export interface OutputRef {
  kind: ToolOutputKind;
  /** Stable id; for `layer`/`table` this is the registered DuckDB view name. */
  ref: string;
  /** For scalar outputs only. */
  value?: unknown;
}
