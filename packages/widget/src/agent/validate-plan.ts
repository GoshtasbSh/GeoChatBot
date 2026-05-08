import { PlanSchema, type Plan } from './types.js';
import { getTool } from './tools/registry.js';

export class PlanValidationError extends Error {
  /** Optional pointer to the offending step id, for inline UI highlighting. */
  readonly stepId?: string;
  constructor(message: string, stepId?: string) {
    super(message);
    this.name = 'PlanValidationError';
    if (stepId !== undefined) this.stepId = stepId;
  }
}

const VAR_REF = /\$\{(\w+)\}/g;

export function validatePlan(input: unknown, loadedDatasets: string[]): Plan {
  // Layer 1: shape
  const parsed = PlanSchema.safeParse(input);
  if (!parsed.success) {
    throw new PlanValidationError(`malformed plan: ${parsed.error.message}`);
  }
  const plan = parsed.data;

  // Duplicate step ids
  const seenIds = new Set<string>();
  for (const s of plan.steps) {
    if (seenIds.has(s.id)) throw new PlanValidationError(`duplicate step id: ${s.id}`, s.id);
    seenIds.add(s.id);
  }

  // dataset_refs must be loaded
  const loaded = new Set(loadedDatasets);
  for (const d of plan.dataset_refs) {
    if (!loaded.has(d)) throw new PlanValidationError(`dataset_refs contains missing dataset: ${d}`);
  }

  // Layer 2: tool existence + args parse
  for (const step of plan.steps) {
    const tool = getTool(step.tool);
    if (!tool) {
      throw new PlanValidationError(`unknown tool: ${step.tool}`, step.id);
    }
    const argRes = tool.args.safeParse(step.args);
    if (!argRes.success) {
      throw new PlanValidationError(
        `step ${step.id} (${step.tool}) bad args: ${argRes.error.message}`,
        step.id,
      );
    }
  }

  // Layer 3: reference integrity (forward-only)
  const definedSoFar = new Set<string>();
  for (const step of plan.steps) {
    const refs = collectVarRefs(step.args);
    for (const r of refs) {
      if (r === step.output_var) {
        throw new PlanValidationError(`step ${step.id} self-references \${${r}}`, step.id);
      }
      if (!definedSoFar.has(r)) {
        throw new PlanValidationError(
          `step ${step.id} references unknown var \${${r}} (forward or undefined)`,
          step.id,
        );
      }
    }
    if (step.output_var !== undefined) definedSoFar.add(step.output_var);
  }

  // Last step must be render.* or render.summary
  const last = plan.steps[plan.steps.length - 1]!;
  if (!last.tool.startsWith('render.') && last.tool !== 'render.summary') {
    throw new PlanValidationError(
      `last step must be a render.* tool (got ${last.tool})`,
      last.id,
    );
  }

  return plan;
}

function collectVarRefs(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    for (const m of value.matchAll(VAR_REF)) out.push(m[1]!);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectVarRefs(v, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectVarRefs(v, out);
  }
  return out;
}
