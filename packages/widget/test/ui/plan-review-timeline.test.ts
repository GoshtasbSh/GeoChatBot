// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import '../../src/ui/plan-review.js';
import type { Plan } from '../../src/agent/types.js';

const plan: Plan = {
  goal: 'g',
  assumptions: [],
  dataset_refs: ['ds'],
  steps: [
    { id: 's1', tool: 'sql', args: { query: 'SELECT 1' }, why: 'p' },
    { id: 's2', tool: 'render.summary', args: { text: 'final' }, why: 'final' },
  ],
};

function mount(): HTMLElement & {
  plan?: Plan;
  stepStatus?: Map<string, string>;
  stepDurations?: Map<string, number>;
  criticPatches?: Map<string, unknown>;
  criticAttempts?: Map<string, Array<unknown>>;
  mode?: 'plan' | 'running';
  updateComplete: Promise<unknown>;
} {
  const el = document.createElement('plan-review') as never;
  document.body.appendChild(el as unknown as Node);
  return el as never;
}

describe('plan-review timeline', () => {
  it('shows the duration chip when a step succeeds', async () => {
    const el = mount();
    el.plan = plan;
    el.stepStatus = new Map([['s1', 'success']]);
    el.stepDurations = new Map([['s1', 42]]);
    await el.updateComplete;
    expect(el.shadowRoot!.textContent).toContain('42 ms');
  });

  it('renders the retry orb when a step is in retry state', async () => {
    const el = mount();
    el.plan = plan;
    el.stepStatus = new Map([['s1', 'retry']]);
    await el.updateComplete;
    const orb = el.shadowRoot!.querySelector('.orb.retry');
    expect(orb).not.toBeNull();
  });

  it('renders an attempt badge per critic attempt log entry', async () => {
    const el = mount();
    el.plan = plan;
    el.criticAttempts = new Map([
      ['s1', [
        { attempt: 1, maxAttempts: 3, decision: 'retry', errorMessage: 'col not found' },
      ]],
    ]);
    await el.updateComplete;
    expect(el.shadowRoot!.textContent).toMatch(/attempt 1 of 3/i);
  });

  it('hides Approve/Reject footer when mode = running', async () => {
    const el = mount();
    el.plan = plan;
    el.mode = 'running';
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector('.foot')).toBeNull();
  });
});
