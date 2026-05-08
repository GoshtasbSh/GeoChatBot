import { describe, expect, it } from 'vitest';
import { PlanSchema, StepSchema } from '../../src/agent/types.js';

describe('StepSchema', () => {
  const valid = {
    id: 's1',
    tool: 'geometry.buffer',
    args: { layer: 'h', distance: 500, units: 'meters' },
    output_var: 'buf',
    why: 'Expand hospitals 500 m.',
  };

  it('accepts a valid step', () => {
    expect(StepSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects bad id format', () => {
    expect(StepSchema.safeParse({ ...valid, id: 'step-1' }).success).toBe(false);
  });

  it('rejects why over 280 chars', () => {
    expect(StepSchema.safeParse({ ...valid, why: 'x'.repeat(281) }).success).toBe(false);
  });

  it('makes output_var optional', () => {
    const { output_var, ...noVar } = valid;
    expect(StepSchema.safeParse(noVar).success).toBe(true);
  });
});

describe('PlanSchema', () => {
  const baseStep = {
    id: 's1', tool: 'sql', args: { query: 'SELECT 1' },
    output_var: 'r', why: 'pick one'
  };
  const valid = {
    goal: 'demo',
    assumptions: [],
    dataset_refs: ['sales'],
    steps: [baseStep],
  };

  it('accepts a minimal valid plan', () => {
    expect(PlanSchema.safeParse(valid).success).toBe(true);
  });

  it('defaults assumptions to []', () => {
    const { assumptions, ...noA } = valid;
    const r = PlanSchema.safeParse(noA);
    expect(r.success && r.data.assumptions).toEqual([]);
  });

  it('rejects empty steps', () => {
    expect(PlanSchema.safeParse({ ...valid, steps: [] }).success).toBe(false);
  });

  it('rejects 11+ steps', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({ ...baseStep, id: `s${i + 1}` }));
    expect(PlanSchema.safeParse({ ...valid, steps: eleven }).success).toBe(false);
  });

  it('rejects empty dataset_refs', () => {
    expect(PlanSchema.safeParse({ ...valid, dataset_refs: [] }).success).toBe(false);
  });
});
