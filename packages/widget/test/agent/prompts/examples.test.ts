import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXAMPLES, renderExamplesBlock } from '../../../src/agent/prompts/examples.js';
import { PlanSchema } from '../../../src/agent/types.js';
import '../../../src/agent/tools/index.js'; // register all tools
import { validatePlan } from '../../../src/agent/validate-plan.js';

describe('few-shot examples', () => {
  it('contains exactly 22 examples', () => {
    expect(EXAMPLES.length).toBe(22);
  });

  it('every example has a question and a plan that parses against PlanSchema', () => {
    for (const e of EXAMPLES) {
      expect(typeof e.question).toBe('string');
      const r = PlanSchema.safeParse(e.plan);
      if (!r.success) console.error(e.question, r.error.message);
      expect(r.success).toBe(true);
    }
  });

  it('every example plan validates against the registered tool catalog', () => {
    for (const e of EXAMPLES) {
      const datasets = e.plan.dataset_refs;
      expect(() => validatePlan(e.plan as any, datasets)).not.toThrow();
    }
  });

  it('renderExamplesBlock fits within ~6500 token budget', () => {
    const block = renderExamplesBlock();
    expect(block.length).toBeLessThan(26000);
  });
});
