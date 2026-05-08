import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '../fixtures/points.csv');

test.describe('GeoChatBot widget', () => {
  test('light theme: element is registered & shadow root has .drop', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('geo-chatbot');

    const isDefined = await page.evaluate(() => !!customElements.get('geo-chatbot'));
    expect(isDefined).toBe(true);

    const hasDrop = await page.evaluate(() => {
      const el = document.querySelector('geo-chatbot');
      const sr = el?.shadowRoot;
      return !!sr && !!sr.querySelector('.drop');
    });
    expect(hasDrop).toBe(true);
  });

  test('dark theme changes computed background of host', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('geo-chatbot');

    const lightBg = await page.evaluate(() => {
      const el = document.querySelector('geo-chatbot') as HTMLElement | null;
      if (!el) return '';
      el.setAttribute('theme', 'light');
      return getComputedStyle(el).backgroundColor;
    });

    // Switch to dark and poll until the computed background actually changes,
    // rather than relying on a fixed sleep. expect.poll re-runs the body
    // until the matcher passes or the timeout elapses.
    await page.evaluate(() => {
      const el = document.querySelector('geo-chatbot') as HTMLElement | null;
      el?.setAttribute('theme', 'dark');
    });

    await expect
      .poll(
        async () =>
          await page.evaluate(() => {
            const el = document.querySelector('geo-chatbot') as HTMLElement | null;
            return el ? getComputedStyle(el).backgroundColor : '';
          }),
        { timeout: 5_000, intervals: [50, 100, 250] },
      )
      .not.toBe(lightBg);
  });

  test('dropping a CSV renders a map canvas inside the shadow root', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('geo-chatbot');

    // Read fixture in Node, send bytes to the browser.
    const bytes = readFileSync(FIXTURE);
    const u8 = Array.from(new Uint8Array(bytes));

    // Push the file into the widget; await the 'result' event for completion.
    await page.evaluate(async (data) => {
      const el = document.querySelector('geo-chatbot') as HTMLElement & {
        pushData?: (f: File) => Promise<unknown> | void;
        on?: (ev: string, cb: (p: unknown) => void) => () => void;
      };
      if (!el || typeof el.pushData !== 'function') {
        throw new Error('pushData not available on <geo-chatbot>');
      }
      const file = new File([new Uint8Array(data)], 'points.csv', { type: 'text/csv' });
      const settled = new Promise<void>((resolveDone, rejectDone) => {
        const tid = setTimeout(() => rejectDone(new Error('timeout waiting for dataset-loaded')), 20_000);
        if (typeof el.on === 'function') {
          const offLoaded = el.on('dataset-loaded', () => { clearTimeout(tid); offLoaded(); resolveDone(); });
          const offError = el.on('error', (err) => {
            clearTimeout(tid);
            offError();
            rejectDone(err instanceof Error ? err : new Error(String(err)));
          });
        } else {
          rejectDone(new Error('on() not available on <geo-chatbot>'));
        }
      });
      await el.pushData(file);
      await settled;
    }, u8);

    // Poll for gcb-map and its inner canvas.
    await expect
      .poll(
        async () =>
          await page.evaluate(() => {
            const host = document.querySelector('geo-chatbot');
            const sr = host?.shadowRoot;
            if (!sr) return false;
            const map = sr.querySelector('gcb-map') as HTMLElement | null;
            if (!map) return false;
            const inner = map.shadowRoot;
            return !!inner && !!inner.querySelector('canvas');
          }),
        { timeout: 15_000, intervals: [250, 500, 1000] },
      )
      .toBe(true);

    await page.screenshot({ path: 'test-results/map-rendered.png', fullPage: true });
  });

  test('headless mode: setMode + ask emits plan; suppresses internal map', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('geo-chatbot');

    // Read fixture once for pushData below.
    const bytes = readFileSync(FIXTURE);
    const u8 = Array.from(new Uint8Array(bytes));

    type Trace = Array<{ kind: string; payload: Record<string, unknown> }>;

    const trace: Trace = await page.evaluate(async (data) => {
      const el = document.querySelector('geo-chatbot') as HTMLElement & {
        pushData?: (f: File) => Promise<unknown>;
        ask?: (q: string) => Promise<string>;
        setMode?: (m: 'full' | 'headless') => void;
        setProvider?: (p: { name: string; apiKey: string; model?: string }) => void;
        __setLlmCall?: (fn: (input: unknown) => Promise<Record<string, unknown>>) => void;
        on?: (ev: string, cb: (p: unknown) => void) => () => void;
      };
      if (!el || typeof el.setMode !== 'function' || typeof el.ask !== 'function') {
        throw new Error('Phase 4 API missing on <geo-chatbot>');
      }

      el.setMode('headless');
      // Phase 4: real ask() requires an API key + LLM. We stub the call so
      // the headless plan event flow is tested deterministically.
      el.setProvider!({ name: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-sonnet-4-6' });
      el.__setLlmCall!(async () => ({
        goal: 'Headless smoke',
        assumptions: [],
        dataset_refs: ['points'],
        steps: [
          { id: 's1', tool: 'render.summary', args: { text: 'ok' }, why: 'final' },
        ],
      }));

      const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
      const cap = (kind: string) => (p: unknown) => {
        events.push({ kind, payload: (p ?? {}) as Record<string, unknown> });
      };
      el.on!('dataset-loaded', cap('dataset-loaded'));
      el.on!('plan', cap('plan'));
      el.on!('progress', cap('progress'));
      el.on!('result', cap('result'));
      el.on!('error', cap('error'));

      const file = new File([new Uint8Array(data)], 'points.csv', { type: 'text/csv' });
      await el.pushData!(file);
      await el.ask!('how many points?');

      return events;
    }, u8);

    const kinds = trace.map((e) => e.kind);
    expect(kinds).toContain('dataset-loaded');
    expect(kinds).toContain('plan');
    // Phase 4 stops at plan emission; the user must approve before the
    // executor (Phase 5) runs progress/result. We just verify ordering.
    const planIdx = kinds.indexOf('plan');
    const dsIdx = kinds.indexOf('dataset-loaded');
    expect(planIdx).toBeGreaterThanOrEqual(0);
    expect(planIdx).toBeGreaterThan(dsIdx);
    // BROWSER_KEY_GUARD must NOT fire — __setLlmCall bypasses the guard.
    const errorPayloads = trace
      .filter((e) => e.kind === 'error')
      .map((e) => e.payload);
    expect(errorPayloads.find((p) => p.code === 'BROWSER_KEY_GUARD')).toBeUndefined();

    // Headless mode must suppress the internal drop zone / map render.
    const internals = await page.evaluate(() => {
      const el = document.querySelector('geo-chatbot');
      const sr = el?.shadowRoot;
      return {
        hasDrop: !!sr?.querySelector('.drop'),
        hasMap: !!sr?.querySelector('gcb-map'),
        hasHeader: !!sr?.querySelector('header'),
      };
    });
    expect(internals.hasDrop).toBe(false);
    expect(internals.hasMap).toBe(false);
    expect(internals.hasHeader).toBe(false);

    // exportLayer returns a stub FeatureCollection for known table.
    const layer = await page.evaluate(() => {
      const el = document.querySelector('geo-chatbot') as HTMLElement & {
        exportLayer?: (n: string) => unknown;
      };
      return el.exportLayer?.('points');
    });
    expect(layer).toBeTruthy();
    expect((layer as { type: string }).type).toBe('FeatureCollection');
  });
});
