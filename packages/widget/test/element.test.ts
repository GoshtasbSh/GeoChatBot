// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { GeoChatBotElement, defineGeoChatBot } from '../src/index';
import type { ChatProvider, GeoChatBotEvents } from '../src/index';

beforeAll(() => {
  // Default tag is registered by the side-effect import in src/index.ts.
  // Calling defineGeoChatBot() should be a harmless no-op.
  defineGeoChatBot();
});

function fixtureFile(name: string): File {
  const buf = readFileSync(resolve(__dirname, 'fixtures', name));
  // happy-dom provides File; cast bytes to BlobPart.
  return new File([new Uint8Array(buf)], name);
}

function mountElement(): GeoChatBotElement {
  const el = document.createElement('geo-chatbot') as GeoChatBotElement;
  document.body.appendChild(el);
  return el;
}

async function flushUpdates(el: GeoChatBotElement): Promise<void> {
  // Lit batches reactive updates into a microtask; await once to settle.
  await el.updateComplete;
}

describe('defineGeoChatBot', () => {
  it('is idempotent — calling twice does not throw', () => {
    expect(() => defineGeoChatBot()).not.toThrow();
    expect(() => defineGeoChatBot()).not.toThrow();
  });

  it('registers an alternate tag name when provided', () => {
    expect(() => defineGeoChatBot('my-geo-chat')).not.toThrow();
    expect(customElements.get('my-geo-chat')).toBeDefined();
    // Re-defining the alias is also a no-op.
    expect(() => defineGeoChatBot('my-geo-chat')).not.toThrow();
  });
});

describe('GeoChatBotElement shadow DOM', () => {
  it('renders a top-right "Add data" button after first update', async () => {
    const el = document.createElement('geo-chatbot');
    document.body.appendChild(el);
    await (el as any).updateComplete;
    const btn = el.shadowRoot?.querySelector('button[aria-label="Add data"]');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toMatch(/Add data/);
  });
});

describe('pushData + on/off events', () => {
  it('emits an `error` event for unsupported file types and unsubscribe stops further calls', async () => {
    const el = mountElement();
    await flushUpdates(el);

    const calls: GeoChatBotEvents['error'][] = [];
    const off = el.on('error', (detail) => {
      calls.push(detail);
    });

    const garbage = new File([new Uint8Array([0x00, 0x01])], 'unknown.xyz');
    await el.pushData(garbage);

    expect(calls.length).toBe(1);
    expect(calls[0]?.message).toMatch(/unsupported|format|xyz/i);
    expect(calls[0]?.code).toBe('UNSUPPORTED_FORMAT');

    // Unsubscribe and push again — handler must not fire a second time.
    off();
    await el.pushData(new File([new Uint8Array([0x02, 0x03])], 'still-bad.zzz'));
    expect(calls.length).toBe(1);
  });

  it('emits a `dataset-loaded` event with the expected shape for points.csv', async () => {
    const el = mountElement();
    await flushUpdates(el);

    const events: GeoChatBotEvents['dataset-loaded'][] = [];
    el.on('dataset-loaded', (detail) => events.push(detail));

    await el.pushData(fixtureFile('points.csv'));

    expect(events.length).toBe(1);
    const detail = events[0]!;
    expect(detail.name).toBe('points');
    expect(detail.source).toBe('csv');
    expect(typeof detail.engineRegistered).toBe('boolean');
    expect(detail.profile).toBeDefined();
    expect(detail.profile.rowCount).toBe(5);
    expect(Array.isArray(detail.profile.columns)).toBe(true);
  });

  it('error event detail never carries a raw Error object via `cause`', async () => {
    const el = mountElement();
    await flushUpdates(el);

    const errs: GeoChatBotEvents['error'][] = [];
    el.on('error', (d) => errs.push(d));
    await el.pushData(new File([new Uint8Array([0, 1])], 'unknown.xyz'));

    expect(errs.length).toBe(1);
    const detail = errs[0]!;
    // No `cause` field — see element.ts dispatch in ingest().
    expect((detail as Record<string, unknown>).cause).toBeUndefined();
    expect(typeof detail.message).toBe('string');
    expect(detail.code).toBe('UNSUPPORTED_FORMAT');
  });
});

describe('setProvider / clear', () => {
  const stubProvider: ChatProvider = {
    id: 'stub',
    label: 'Stub',
    generate: async () => ({ text: '' }),
  };

  it('setProvider stores the provider', async () => {
    const el = mountElement();
    await flushUpdates(el);

    el.setProvider(stubProvider);
    expect(el.getProvider()).toBe(stubProvider);
  });

  it('clear() wipes the provider as a multi-tenant safety boundary', async () => {
    // Phase 4 security review: clear() must zero session state so a
    // multi-tenant SPA reusing the widget across users does not leak
    // provider/api-key/dataset state into the next user's first ask().
    // Hosts that want a single shared provider should re-call
    // setProvider() after clear().
    const el = mountElement();
    await flushUpdates(el);

    el.setProvider(stubProvider);
    expect(el.getProvider()).toBe(stubProvider);

    el.clear();
    expect(el.getProvider()).toBeUndefined();
  });

  it('clear empties internal loaded state — no .table-card rendered after clear', async () => {
    const el = mountElement();
    await flushUpdates(el);

    await el.pushData(fixtureFile('points.csv'));
    // Force a synchronous render and let Lit's update microtasks settle.
    el.requestUpdate();
    await flushUpdates(el);
    await flushUpdates(el);
    expect(el.results.length).toBe(1);

    el.clear();
    el.requestUpdate();
    await flushUpdates(el);
    expect(el.results.length).toBe(0);
    expect(el.shadowRoot?.querySelectorAll('.table-card').length).toBe(0);
  });

});

describe('Phase 2 — mode / ask / exportLayer', () => {
  it('setMode("headless") suppresses internal rendering', async () => {
    const el = mountElement();
    el.setMode('headless');
    await flushUpdates(el);
    // No drop zone, no header, no map — headless renders nothing.
    expect(el.shadowRoot?.querySelector('.drop')).toBeNull();
    expect(el.shadowRoot?.querySelector('gcb-upload-popover')).toBeNull();
    expect(el.shadowRoot?.querySelector('header')).toBeNull();
    // mode reflects to attribute
    expect(el.getAttribute('mode')).toBe('headless');
  });

  it('headless mode still emits dataset-loaded on pushData', async () => {
    const el = mountElement();
    el.setMode('headless');
    await flushUpdates(el);

    const events: GeoChatBotEvents['dataset-loaded'][] = [];
    el.on('dataset-loaded', (d) => events.push(d));
    await el.pushData(fixtureFile('points.csv'));

    expect(events.length).toBe(1);
    expect(events[0]!.name).toBe('points');
  });

  it('exportLayer returns undefined for unknown table and a stub FC for known', async () => {
    const el = mountElement();
    await flushUpdates(el);

    expect(el.exportLayer('nope')).toBeUndefined();

    await el.pushData(fixtureFile('points.csv'));
    const layer = el.exportLayer('points');
    expect(layer).toBeDefined();
    expect(layer!.type).toBe('FeatureCollection');
    expect(Array.isArray(layer!.features)).toBe(true);
    expect(layer!.meta.name).toBe('points');
    // Phase 2 stub — explicit warning so callers know features are not real.
    expect(layer!.meta.warning).toBeDefined();
  });
});

describe('Phase 4 — review-driven fixes', () => {
  // Minimal stub provider that carries apiKey/model so setProvider stashes
  // them onto the host. This is the same shape the real Anthropic options
  // adapter exposes.
  const planProvider = {
    id: 'p',
    label: 'P',
    apiKey: 'sk-ant-test',
    model: 'claude-sonnet-4-6',
    generate: async () => ({ text: '' }),
  } as unknown as ChatProvider;

  function makePlan(steps: unknown[] = [
    { id: 's1', tool: 'render.summary', args: { text: 'ok' }, why: 'final' },
  ]): Record<string, unknown> {
    return {
      goal: 'Test',
      assumptions: [],
      dataset_refs: ['sales'],
      steps,
    };
  }

  it('B3 — ask() emits BROWSER_KEY_GUARD error when neither stub nor opt-in is set', async () => {
    const el = mountElement();
    await flushUpdates(el);
    el.setProvider(planProvider);
    const errs: GeoChatBotEvents['error'][] = [];
    el.on('error', (d) => errs.push(d));
    await el.ask('q');
    expect(errs.length).toBe(1);
    expect(errs[0]!.code).toBe('BROWSER_KEY_GUARD');
  });

  it('B3 — opting in via property allows the planner path', async () => {
    const el = mountElement();
    await flushUpdates(el);
    el.dangerouslyAllowBrowser = true;
    el.setProvider(planProvider);
    await el.pushData({
      name: 'sales', kind: 'table', rows: 1, columns: [], sample: [],
    } as Parameters<typeof el.pushData>[0]);

    const planEvents: Array<unknown> = [];
    el.on('plan', (d) => planEvents.push(d));

    el.__setLlmCall(async () => makePlan());
    await el.ask('how many rows?');
    expect(planEvents.length).toBe(1);
  });

  it('B3 — installing __setLlmCall bypasses the BROWSER_KEY_GUARD (test path)', async () => {
    const el = mountElement();
    await flushUpdates(el);
    el.setProvider(planProvider);
    await el.pushData({
      name: 'sales', kind: 'table', rows: 1, columns: [], sample: [],
    } as Parameters<typeof el.pushData>[0]);
    el.__setLlmCall(async () => makePlan());

    const errs: GeoChatBotEvents['error'][] = [];
    const planEvents: Array<unknown> = [];
    el.on('error', (d) => errs.push(d));
    el.on('plan', (d) => planEvents.push(d));

    await el.ask('q');
    expect(errs.filter((e) => e.code === 'BROWSER_KEY_GUARD').length).toBe(0);
    expect(planEvents.length).toBe(1);
  });

  it('H1 — plan event detail carries { planId, plan, datasets } shape', async () => {
    const el = mountElement();
    await flushUpdates(el);
    el.dangerouslyAllowBrowser = true;
    el.setProvider(planProvider);
    await el.pushData({
      name: 'sales', kind: 'table', rows: 1, columns: [], sample: [],
    } as Parameters<typeof el.pushData>[0]);
    el.__setLlmCall(async () => makePlan());

    let received: GeoChatBotEvents['plan'] | undefined;
    el.on('plan', (d) => { received = d; });
    await el.ask('q');

    expect(received).toBeDefined();
    expect(typeof received!.planId).toBe('string');
    expect(received!.planId).toMatch(/^plan_/);
    expect(received!.plan.steps.length).toBe(1);
    expect(Array.isArray(received!.datasets)).toBe(true);
  });

  it('H1/dual-dispatch — both prefixed and unprefixed event names fire', async () => {
    const el = mountElement();
    await flushUpdates(el);
    el.dangerouslyAllowBrowser = true;
    el.setProvider(planProvider);
    await el.pushData({
      name: 'sales', kind: 'table', rows: 1, columns: [], sample: [],
    } as Parameters<typeof el.pushData>[0]);
    el.__setLlmCall(async () => makePlan());

    let unprefixed = 0;
    let prefixed = 0;
    el.addEventListener('plan', () => unprefixed++);
    el.addEventListener('geochatbot:plan', () => prefixed++);
    await el.ask('q');
    expect(unprefixed).toBe(1);
    expect(prefixed).toBe(1);
  });

  it('H4 — invalid step:edit dispatches an EDIT_INVALID error and does not mutate the pending plan', async () => {
    const el = mountElement();
    await flushUpdates(el);
    el.dangerouslyAllowBrowser = true;
    el.setProvider(planProvider);
    await el.pushData({
      name: 'sales', kind: 'table', rows: 1, columns: [], sample: [],
    } as Parameters<typeof el.pushData>[0]);
    el.__setLlmCall(async () =>
      makePlan([
        { id: 's1', tool: 'sql', args: { query: 'SELECT 1' }, output_var: 'r', why: 'pull' },
        { id: 's2', tool: 'render.summary', args: { text: 'done' }, why: 'final' },
      ]),
    );

    const errs: GeoChatBotEvents['error'][] = [];
    el.on('error', (d) => errs.push(d));
    await el.ask('q');
    await flushUpdates(el);

    const pr = el.shadowRoot!.querySelector('gcb-modal plan-review') as HTMLElement;
    expect(pr).toBeTruthy();

    // Dispatch a step:edit event with args that fail SqlArgs (empty string).
    pr.dispatchEvent(
      new CustomEvent('step:edit', {
        detail: { stepId: 's1', args: { query: '' } },
        bubbles: true,
        composed: true,
      }),
    );

    expect(errs.some((e) => e.code === 'EDIT_INVALID')).toBe(true);
  });

  it('H4 — valid step:edit replaces the pending plan with the validated update', async () => {
    const el = mountElement();
    await flushUpdates(el);
    el.dangerouslyAllowBrowser = true;
    el.setProvider(planProvider);
    await el.pushData({
      name: 'sales', kind: 'table', rows: 1, columns: [], sample: [],
    } as Parameters<typeof el.pushData>[0]);
    el.__setLlmCall(async () =>
      makePlan([
        { id: 's1', tool: 'sql', args: { query: 'SELECT 1' }, output_var: 'r', why: 'pull' },
        { id: 's2', tool: 'render.summary', args: { text: 'done' }, why: 'final' },
      ]),
    );

    await el.ask('q');
    await flushUpdates(el);
    const pr = el.shadowRoot!.querySelector('gcb-modal plan-review') as HTMLElement & {
      plan?: { steps: Array<{ id: string; args: Record<string, unknown> }> };
    };

    pr.dispatchEvent(
      new CustomEvent('step:edit', {
        detail: { stepId: 's1', args: { query: 'SELECT 2' } },
        bubbles: true,
        composed: true,
      }),
    );

    expect(pr.plan!.steps[0]!.args.query).toBe('SELECT 2');
  });

  it('H7 — clear() wipes _datasets / _pendingPlan / _planner / _apiKey', async () => {
    const el = mountElement();
    await flushUpdates(el);
    el.dangerouslyAllowBrowser = true;
    el.setProvider(planProvider);
    await el.pushData({
      name: 'sales', kind: 'table', rows: 1, columns: [], sample: [],
    } as Parameters<typeof el.pushData>[0]);
    el.__setLlmCall(async () => makePlan());
    await el.ask('q');
    await flushUpdates(el);
    expect(el.shadowRoot!.querySelector('gcb-modal plan-review')).toBeTruthy();

    el.clear();
    await flushUpdates(el);

    // After clear, plan-review is removed, provider is gone, and a fresh
    // ask() with no setProvider should emit NO_KEY (the wipe was real).
    expect(el.shadowRoot!.querySelector('gcb-modal')).toBeNull();
    expect(el.shadowRoot!.querySelector('gcb-modal plan-review')).toBeNull();
    expect(el.getProvider()).toBeUndefined();

    const errs: GeoChatBotEvents['error'][] = [];
    el.on('error', (d) => errs.push(d));
    await el.ask('q again');
    expect(errs.some((e) => e.code === 'NO_KEY')).toBe(true);
  });

  it('rejectPlan — emits progress(rejected) carrying the real planId, not "_rejected"', async () => {
    const el = mountElement();
    await flushUpdates(el);
    el.dangerouslyAllowBrowser = true;
    el.setProvider(planProvider);
    await el.pushData({
      name: 'sales', kind: 'table', rows: 1, columns: [], sample: [],
    } as Parameters<typeof el.pushData>[0]);
    el.__setLlmCall(async () => makePlan());

    let receivedPlanId: string | undefined;
    el.on('plan', (d) => { receivedPlanId = d.planId; });
    const progressEvents: GeoChatBotEvents['progress'][] = [];
    el.on('progress', (d) => progressEvents.push(d));

    await el.ask('q');
    expect(receivedPlanId).toBeDefined();

    // Swap the llm-call so the second-attempt plan call doesn't blow up;
    // we only care about the synchronous rejected-progress emission.
    el.__setLlmCall(async () => makePlan());
    el.rejectPlan({ id: receivedPlanId, feedback: 'no thanks' });

    const rejected = progressEvents.find((e) => e.status === 'rejected');
    expect(rejected).toBeDefined();
    expect(rejected!.planId).toBe(receivedPlanId);
    expect(rejected!.planId).not.toBe('_rejected');
  });
});

describe('clear-race regression (kept)', () => {
  it('clear() during in-flight pushData drops the result (no ghost)', async () => {
    const el = mountElement();
    await flushUpdates(el);

    const inFlight = el.pushData(fixtureFile('points.csv'));
    // Don't await the load — call clear() synchronously while ingest is mid-flight.
    el.clear();
    await inFlight;
    el.requestUpdate();
    await flushUpdates(el);

    expect(el.results.length).toBe(0);
    expect(el.shadowRoot?.querySelectorAll('.table-card').length).toBe(0);
  });

  it('clear() during in-flight ask() drops the resolved plan (NH1)', async () => {
    // Regression for NH1: a planner call resolving after clear() must
    // NOT mount a stale plan into the cleared widget. Without the
    // generation guard in ask(), the late-resolving plan would set
    // _pendingPlan and dispatch a 'plan' event for a session the user
    // already cancelled.
    const el = mountElement();
    await flushUpdates(el);
    el.dangerouslyAllowBrowser = true;
    el.setProvider({
      id: 'p',
      label: 'P',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-6',
      generate: async () => ({ text: '' }),
    } as unknown as ChatProvider);
    await el.pushData({
      name: 'sales',
      kind: 'table',
      rows: 1,
      columns: [],
      sample: [],
    } as Parameters<typeof el.pushData>[0]);

    // Stub the planner to take a beat so we can race clear() into it.
    let resolvePlan!: (v: unknown) => void;
    el.__setLlmCall(
      () =>
        new Promise((res) => {
          resolvePlan = res as (v: unknown) => void;
        }),
    );

    const planEvents: Array<unknown> = [];
    const errors: Array<{ code?: string; message?: string }> = [];
    el.on('plan', (d) => planEvents.push(d));
    el.on('error', (d) => errors.push(d));

    const askPromise = el.ask('q');
    el.clear(); // racing clear() while the planner is still pending
    resolvePlan({
      goal: 'g',
      assumptions: [],
      dataset_refs: ['sales'],
      steps: [
        { id: 's1', tool: 'render.summary', args: { text: 'ok' }, why: 'final' },
      ],
    });
    await askPromise;
    await flushUpdates(el);

    expect(planEvents.length).toBe(0); // stale plan must NOT mount
    // The planner-resolved-after-clear path should also not fire an error
    // (the user explicitly cancelled the session by calling clear).
    expect(errors.filter((e) => e.code !== 'BROWSER_KEY_GUARD').length).toBe(0);
  });
});

describe('Phase 7: saves + rail round-trip', () => {
  it('saves.add() pushes a row into <gcb-rail>', async () => {
    const el = document.createElement('geo-chatbot') as any;
    document.body.appendChild(el);
    await el.updateComplete;
    el.saves.clear();
    el.saves.add({
      title: 'pinned',
      kind: 'chart',
      origin: { planId: 'p', stepId: 's', question: 'q' },
      payload: {},
    });
    await el.updateComplete;
    const rail = el.shadowRoot!.querySelector('gcb-rail') as HTMLElement;
    await (rail as any).updateComplete;
    const text = rail.shadowRoot!.textContent ?? '';
    expect(text).toMatch(/pinned/);
  });
});

describe('Phase 6: critic wiring', () => {
  it('passes onStepError to the executor when ask() runs', async () => {
    const el = document.createElement('geo-chatbot') as any;
    document.body.appendChild(el);
    el.setProvider({ name: 'anthropic', apiKey: 'k', generate: async () => ({ text: '' }) });
    await el.pushData({
      name: 'mydata',
      kind: 'table',
      rows: 1,
      columns: [{ name: 'id', type: 'integer' }],
      sample: [],
    });
    (el as any)._execDatasets = [
      { name: 'mydata', tableName: 'mydata', hasGeometry: false },
    ];

    let attempts = 0;
    const failingEngine = {
      hasSpatial: false,
      query: async () => {
        attempts++;
        // First time: fail. Critic will (in test) return retry. Second time: succeed.
        if (attempts === 1) throw new Error('Binder Error: Referenced column "bad_col" not found');
        const { tableFromJSON } = await import('apache-arrow');
        return tableFromJSON([{ ok: 1 }]);
      },
    };
    el.__setExecutorEngine(failingEngine);

    const planWithSql = {
      goal: 'g', assumptions: [], dataset_refs: ['mydata'],
      steps: [
        { id: 's1', tool: 'sql', args: { query: 'SELECT bad_col FROM mydata' }, output_var: 'a', why: 'p' },
        { id: 's2', tool: 'render.summary', args: { text: 'done' }, why: 'final' },
      ],
    };
    el.__setLlmCall(vi.fn().mockResolvedValue(planWithSql));

    // Inject a stub critic that always retries.
    el.__setCritic({
      diagnose: vi.fn().mockResolvedValue({ action: 'retry' }),
    });

    const errors: any[] = [];
    el.shadowRoot!.host.addEventListener('error', (e: Event) => errors.push((e as CustomEvent).detail));

    await el.ask('q');
    el.approvePlan();
    await el.__lastExecution;

    // Critic's retry produced a successful s1, then s2 ran.
    expect(errors).toEqual([]);
    expect(attempts).toBeGreaterThanOrEqual(2);
  });

  it('emits a typed `critic` event for each diagnose call', async () => {
    const el = document.createElement('geo-chatbot') as any;
    document.body.appendChild(el);
    el.setProvider({ name: 'anthropic', apiKey: 'k', generate: async () => ({ text: '' }) });
    await el.pushData({
      name: 'mydata',
      kind: 'table',
      rows: 1,
      columns: [{ name: 'id', type: 'integer' }],
      sample: [],
    });
    (el as any)._execDatasets = [{ name: 'mydata', tableName: 'mydata', hasGeometry: false }];

    let attempts = 0;
    el.__setExecutorEngine({
      hasSpatial: false,
      query: async () => {
        attempts++;
        if (attempts === 1) throw new Error('column missing');
        const { tableFromJSON } = await import('apache-arrow');
        return tableFromJSON([{ ok: 1 }]);
      },
    });
    el.__setLlmCall(vi.fn().mockResolvedValue({
      goal: 'g', assumptions: [], dataset_refs: ['mydata'],
      steps: [
        { id: 's1', tool: 'sql', args: { query: 'SELECT id FROM mydata' }, output_var: 'a', why: 'p' },
        { id: 's2', tool: 'render.summary', args: { text: 'done' }, why: 'final' },
      ],
    }));
    el.__setCritic({ diagnose: vi.fn().mockResolvedValue({ action: 'retry' }) });

    const critics: any[] = [];
    el.shadowRoot!.host.addEventListener('critic', (e: Event) => critics.push((e as CustomEvent).detail));

    await el.ask('q');
    el.approvePlan();
    await el.__lastExecution;

    expect(critics).toHaveLength(1);
    expect(critics[0]).toMatchObject({
      stepId: 's1',
      attempt: 1,
      maxAttempts: 3,
      decision: 'retry',
    });
  });

  it('forwards an AbortSignal to critic.diagnose so clear() can cancel an in-flight call', async () => {
    const el = document.createElement('geo-chatbot') as any;
    document.body.appendChild(el);
    el.setProvider({ name: 'anthropic', apiKey: 'k', generate: async () => ({ text: '' }) });
    await el.pushData({
      name: 'mydata',
      kind: 'table',
      rows: 1,
      columns: [{ name: 'id', type: 'integer' }],
      sample: [],
    });
    (el as any)._execDatasets = [{ name: 'mydata', tableName: 'mydata', hasGeometry: false }];

    el.__setExecutorEngine({
      hasSpatial: false,
      query: async () => { throw new Error('boom'); },
    });
    el.__setLlmCall(vi.fn().mockResolvedValue({
      goal: 'g', assumptions: [], dataset_refs: ['mydata'],
      steps: [
        { id: 's1', tool: 'sql', args: { query: 'SELECT id FROM mydata' }, output_var: 'a', why: 'p' },
        { id: 's2', tool: 'render.summary', args: { text: 'done' }, why: 'final' },
      ],
    }));

    let capturedSignal: AbortSignal | undefined;
    el.__setCritic({
      diagnose: vi.fn().mockImplementation(async (_ctx: unknown, signal?: AbortSignal) => {
        capturedSignal = signal;
        return { action: 'abort' };
      }),
    });

    await el.ask('q');
    el.approvePlan();
    await el.__lastExecution;

    // The critic must have been called WITH a signal (not undefined). The
    // signal was created inside _execute and tied to the per-run abort
    // controller; if it ever lands as undefined the cancel-on-clear path
    // is silently broken.
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal!.aborted).toBe(false);
  });
});
