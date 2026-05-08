// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import '../../src/ui/plan-review.js';
import type { Plan } from '../../src/agent/types.js';

const plan: Plan = {
  goal: 'demo goal',
  assumptions: ['a1'],
  dataset_refs: ['x'],
  steps: [
    { id: 's1', tool: 'sql', args: { query: 'SELECT 1' }, output_var: 'r', why: 'first' },
    { id: 's2', tool: 'render.summary', args: { text: 'done' }, why: 'last' },
  ],
};

function mount(plan?: Plan, mode: 'plan' | 'running' = 'plan') {
  const el = document.createElement('plan-review') as any;
  if (plan) el.plan = plan;
  el.mode = mode;
  document.body.appendChild(el);
  return el;
}

describe('<plan-review>', () => {
  it('renders nothing when plan is undefined', () => {
    const el = mount();
    expect(el.shadowRoot?.textContent ?? '').toBe('');
  });

  it('renders the goal and exactly two step cards', async () => {
    const el = mount(plan);
    await el.updateComplete;
    const root = el.shadowRoot!;
    expect(root.textContent).toContain('demo goal');
    expect(root.querySelectorAll('.step').length).toBe(2);
  });

  it('emits plan:approve on Run click', async () => {
    const el = mount(plan);
    await el.updateComplete;
    const spy = vi.fn();
    el.addEventListener('plan:approve', spy);
    el.shadowRoot!.querySelector('button.run')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('emits plan:reject on Reject click', async () => {
    const el = mount(plan);
    await el.updateComplete;
    const spy = vi.fn();
    el.addEventListener('plan:reject', spy);
    el.shadowRoot!.querySelector('button.reject')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('renders status orbs in running mode based on stepStatus map', async () => {
    const el = mount(plan, 'running');
    el.stepStatus = new Map([['s1', 'success'], ['s2', 'running']]);
    await el.updateComplete;
    const orbs = el.shadowRoot!.querySelectorAll('.orb');
    expect(orbs[0]!.classList.contains('success')).toBe(true);
    expect(orbs[1]!.classList.contains('running')).toBe(true);
  });
});
