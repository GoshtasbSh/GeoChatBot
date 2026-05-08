import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { _resetRegistry, registerTool } from '../../src/agent/tools/registry.js';
import { validatePlan, PlanValidationError } from '../../src/agent/validate-plan.js';

const baseStep = (overrides = {}) => ({
  id: 's1', tool: 'render.summary', args: { text: 'hi' },
  why: 'final', ...overrides,
});

beforeEach(() => {
  registerTool({
    id: 'render.summary', description: 'd',
    args: z.object({ text: z.string() }), output_kind: 'rendered',
  });
  registerTool({
    id: 'sql', description: 'd',
    args: z.object({ query: z.string() }), output_kind: 'table',
  });
});

afterEach(() => _resetRegistry());

describe('validatePlan', () => {
  it('accepts a minimal valid plan', () => {
    expect(() => validatePlan({
      goal: 'g', assumptions: [], dataset_refs: ['x'], steps: [baseStep()],
    }, ['x'])).not.toThrow();
  });

  it('rejects unknown tool id', () => {
    expect(() => validatePlan({
      goal: 'g', dataset_refs: ['x'],
      steps: [baseStep({ tool: 'unknown.thing' })],
    } as any, ['x'])).toThrow(/unknown tool/i);
  });

  it('rejects last step that is not render.* or render.summary', () => {
    expect(() => validatePlan({
      goal: 'g', dataset_refs: ['x'],
      steps: [{ id: 's1', tool: 'sql', args: { query: 'SELECT 1' }, why: 'q', output_var: 't' }],
    } as any, ['x'])).toThrow(/last step/i);
  });

  it('rejects forward reference', () => {
    expect(() => validatePlan({
      goal: 'g', dataset_refs: ['x'],
      steps: [
        { id: 's1', tool: 'sql', args: { query: '${later}' }, why: 'a', output_var: 'first' },
        baseStep({ id: 's2' }),
      ],
    } as any, ['x'])).toThrow(/unknown.*var|forward/i);
  });

  it('rejects self-reference', () => {
    expect(() => validatePlan({
      goal: 'g', dataset_refs: ['x'],
      steps: [
        { id: 's1', tool: 'sql', args: { query: '${self}' }, why: 'q', output_var: 'self' },
        baseStep({ id: 's2' }),
      ],
    } as any, ['x'])).toThrow(/self/i);
  });

  it('rejects dataset_ref not loaded', () => {
    expect(() => validatePlan({
      goal: 'g', dataset_refs: ['missing'], steps: [baseStep()],
    } as any, ['x'])).toThrow(/missing/);
  });

  it('rejects step.args that fail per-tool zod parse', () => {
    expect(() => validatePlan({
      goal: 'g', dataset_refs: ['x'],
      steps: [{ id: 's1', tool: 'render.summary', args: { text: 42 }, why: 'q' }],
    } as any, ['x'])).toThrow(/render\.summary/);
  });

  it('accepts backward-only ${var} references', () => {
    expect(() => validatePlan({
      goal: 'g', dataset_refs: ['x'],
      steps: [
        { id: 's1', tool: 'sql', args: { query: 'SELECT 1' }, why: 'q', output_var: 'first' },
        { id: 's2', tool: 'render.summary', args: { text: 'see ${first}' }, why: 'show' },
      ],
    } as any, ['x'])).not.toThrow();
  });

  it('rejects malformed plan shape (uses PlanSchema)', () => {
    expect(() => validatePlan({} as any, ['x'])).toThrow(PlanValidationError);
  });

  it('rejects duplicate step ids', () => {
    expect(() => validatePlan({
      goal: 'g', dataset_refs: ['x'],
      steps: [baseStep({ id: 's1' }), baseStep({ id: 's1' })],
    } as any, ['x'])).toThrow(/duplicate/i);
  });
});
