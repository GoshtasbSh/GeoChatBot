import { afterEach, describe, expect, it, vi } from 'vitest';
import { Planner } from '../../src/agent/planner.js';
import '../../src/agent/tools/index.js';

const validPlan = {
  goal: 'demo',
  assumptions: [],
  dataset_refs: ['sales'],
  steps: [{ id: 's1', tool: 'render.summary', args: { text: 'hi' }, why: 'final' }],
};

const dataset = [{
  name: 'sales', kind: 'table' as const, rows: 10, columns: [{ name: 'price', type: 'number' }], sample: [],
}];

afterEach(() => vi.restoreAllMocks());

describe('Planner.plan()', () => {
  it('returns a valid plan when LLM emits one', async () => {
    const llm = vi.fn().mockResolvedValue(validPlan);
    const p = new Planner({ apiKey: 'k', model: 'claude-sonnet-4-6', llmCall: llm });
    const got = await p.plan({ question: 'q', datasets: dataset });
    expect(got.goal).toBe('demo');
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it('retries once on validation failure with the error in the next prompt', async () => {
    const llm = vi.fn()
      .mockResolvedValueOnce({ goal: 'bad' })
      .mockResolvedValueOnce(validPlan);
    const p = new Planner({ apiKey: 'k', model: 'claude-sonnet-4-6', llmCall: llm });
    const got = await p.plan({ question: 'q', datasets: dataset });
    expect(got.goal).toBe('demo');
    expect(llm).toHaveBeenCalledTimes(2);
    const retryArgs = llm.mock.calls[1][0];
    expect(retryArgs.userQuestion).toMatch(/previous attempt/i);
  });

  it('throws PlannerError after 2 failed attempts', async () => {
    const llm = vi.fn().mockResolvedValue({ goal: 'bad' });
    const p = new Planner({ apiKey: 'k', model: 'claude-sonnet-4-6', llmCall: llm });
    await expect(p.plan({ question: 'q', datasets: dataset })).rejects.toThrow(/plan/i);
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it('rejects when LLM emits a step with unknown tool', async () => {
    const llm = vi.fn().mockResolvedValue({
      goal: 'g', assumptions: [], dataset_refs: ['sales'],
      steps: [{ id: 's1', tool: 'unknown.thing', args: {}, why: 'q' }],
    });
    const p = new Planner({ apiKey: 'k', model: 'claude-sonnet-4-6', llmCall: llm });
    await expect(p.plan({ question: 'q', datasets: dataset })).rejects.toThrow();
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it('passes cached prefix and dynamic dataset block separately', async () => {
    const llm = vi.fn().mockResolvedValue(validPlan);
    const p = new Planner({ apiKey: 'k', model: 'claude-sonnet-4-6', llmCall: llm });
    await p.plan({ question: 'q', datasets: dataset });
    const args = llm.mock.calls[0][0];
    expect(args.cachedSystemPrompt).toContain('Tool catalog');
    expect(args.systemPrompt).toContain('sales');
    expect(args.userQuestion).toBe('q');
  });

  it('builds a JSON schema from PlanSchema for the submit_plan tool', async () => {
    const llm = vi.fn().mockResolvedValue(validPlan);
    const p = new Planner({ apiKey: 'k', model: 'claude-sonnet-4-6', llmCall: llm });
    await p.plan({ question: 'q', datasets: dataset });
    const args = llm.mock.calls[0][0];
    expect(args.toolName).toBe('submit_plan');
    expect(typeof args.toolInputSchema).toBe('object');
    expect((args.toolInputSchema as any).type).toBe('object');
  });
});
