// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import '../../src/element.js';
import '../../src/agent/tools/index.js';

describe('headless mode', () => {
  it('renders nothing in shadow DOM but still emits events', async () => {
    const el = document.createElement('geo-chatbot') as any;
    el.setAttribute('mode', 'headless');
    document.body.appendChild(el);
    el.__setLlmCall(vi.fn().mockResolvedValue({
      goal: 'h', assumptions: [], dataset_refs: ['s'],
      steps: [{ id: 's1', tool: 'render.summary', args: { text: 'ok' }, why: 'final' }],
    }));
    el.setProvider({ name: 'anthropic', apiKey: 'k', generate: async () => ({ text: '' }) });
    el.pushData({ name: 's', kind: 'table', rows: 1, columns: [], sample: [] });

    const planSeen = vi.fn();
    const resultSeen = vi.fn();
    el.addEventListener('plan', planSeen);
    el.addEventListener('result', resultSeen);

    await el.ask('q');
    expect(el.shadowRoot!.querySelector('plan-review')).toBeNull();
    expect(planSeen).toHaveBeenCalled();
    el.approvePlan();
    await new Promise((r) => setTimeout(r, 10));
    expect(resultSeen).toHaveBeenCalled();
  });

  it('rejectPlan(feedback) re-runs planner with feedback included', async () => {
    const el = document.createElement('geo-chatbot') as any;
    el.setAttribute('mode', 'headless');
    document.body.appendChild(el);
    const llm = vi.fn().mockResolvedValue({
      goal: 'h', assumptions: [], dataset_refs: ['s'],
      steps: [{ id: 's1', tool: 'render.summary', args: { text: 'ok' }, why: 'final' }],
    });
    el.__setLlmCall(llm);
    el.setProvider({ name: 'anthropic', apiKey: 'k', generate: async () => ({ text: '' }) });
    el.pushData({ name: 's', kind: 'table', rows: 1, columns: [], sample: [] });
    await el.ask('q');
    el.rejectPlan({ feedback: 'do it differently' });
    // The planner's RAG retrieval pass adds an extra await tick before
    // the second LLM call lands. Drain microtasks until the spy fires.
    for (let i = 0; i < 100 && llm.mock.calls.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(llm).toHaveBeenCalledTimes(2);
    expect(llm.mock.calls[1][0].userQuestion).toMatch(/do it differently/);
  });

  it('approvePlan(planId) on the wrong id is a no-op', async () => {
    const el = document.createElement('geo-chatbot') as any;
    el.setAttribute('mode', 'headless');
    document.body.appendChild(el);
    el.__setLlmCall(vi.fn().mockResolvedValue({
      goal: 'h', assumptions: [], dataset_refs: ['s'],
      steps: [{ id: 's1', tool: 'render.summary', args: { text: 'ok' }, why: 'final' }],
    }));
    el.setProvider({ name: 'anthropic', apiKey: 'k', generate: async () => ({ text: '' }) });
    el.pushData({ name: 's', kind: 'table', rows: 1, columns: [], sample: [] });
    const progress = vi.fn();
    el.addEventListener('progress', progress);
    await el.ask('q');
    el.approvePlan('wrong-id');
    await new Promise((r) => setTimeout(r, 0));
    expect(progress).not.toHaveBeenCalled();
  });
});
