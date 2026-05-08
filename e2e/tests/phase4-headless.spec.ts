import { expect, test } from '@playwright/test';

/**
 * Phase 4 — headless mode renders nothing inside the widget shadow root.
 *
 * Sets `mode="headless"`, drives the planner via `__setLlmCall`, asks, and
 * approves. Asserts:
 *
 *   • `plan` and `result` events fire (events-only contract)
 *   • <plan-review> is NOT mounted in the widget's shadow root
 *   • the widget's drop zone / map / header are also absent (full-mode UI
 *     is suppressed)
 */
test('Phase 4 — headless emits events; no internal UI', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('geo-chatbot');

  const seen = await page.evaluate(async () => {
    const el = document.querySelector('geo-chatbot') as HTMLElement & {
      setMode: (m: 'full' | 'headless') => void;
      setProvider: (p: { name: string; apiKey: string; model?: string }) => void;
      pushData: (d: Record<string, unknown>) => Promise<void>;
      ask: (q: string) => Promise<void>;
      approvePlan: (id?: string) => void;
      __setLlmCall: (
        fn: (input: unknown) => Promise<Record<string, unknown>>,
      ) => void;
    };
    el.setMode('headless');
    el.setProvider({ name: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-sonnet-4-6' });
    el.__setLlmCall(async () => ({
      goal: 'headless smoke',
      assumptions: [],
      dataset_refs: ['s'],
      steps: [{ id: 's1', tool: 'render.summary', args: { text: 'ok' }, why: 'final' }],
    }));

    const events: string[] = [];
    let planId = '';
    el.addEventListener('plan', (e: Event) => {
      events.push('plan');
      const detail = (e as CustomEvent<{ planId: string }>).detail;
      if (detail?.planId) planId = detail.planId;
    });
    el.addEventListener('progress', () => events.push('progress'));
    el.addEventListener('result', () => events.push('result'));
    el.addEventListener('error', () => events.push('error'));

    await el.pushData({ name: 's', kind: 'table', rows: 1, columns: [], sample: [] });
    await el.ask('q');
    // Allow plan microtask to settle.
    await new Promise((r) => setTimeout(r, 50));
    el.approvePlan(planId || undefined);
    await new Promise((r) => setTimeout(r, 100));
    return events;
  });

  expect(seen).toContain('plan');
  expect(seen).toContain('result');
  expect(seen).not.toContain('error');

  // No plan-review in headless mode — the host page owns the UI.
  const internals = await page.evaluate(() => {
    const sr = document.querySelector('geo-chatbot')?.shadowRoot;
    return {
      planReview: !!sr?.querySelector('plan-review'),
      drop: !!sr?.querySelector('.drop'),
      map: !!sr?.querySelector('gcb-map'),
      header: !!sr?.querySelector('header'),
    };
  });
  expect(internals).toEqual({
    planReview: false,
    drop: false,
    map: false,
    header: false,
  });
});
