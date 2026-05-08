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

    // Allow a tick for attribute change to flow through.
    await page.waitForTimeout(100);

    const darkBg = await page.evaluate(() => {
      const el = document.querySelector('geo-chatbot') as HTMLElement | null;
      if (!el) return '';
      el.setAttribute('theme', 'dark');
      return getComputedStyle(el).backgroundColor;
    });

    await page.waitForTimeout(100);

    const darkBg2 = await page.evaluate(() => {
      const el = document.querySelector('geo-chatbot') as HTMLElement | null;
      return el ? getComputedStyle(el).backgroundColor : '';
    });

    // Either the host bg itself differs, OR a CSS variable on the host differs.
    // We assert the recomputed dark value differs from the initial light value.
    expect(darkBg2).not.toBe(lightBg);
    expect(darkBg).toBeTruthy();
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
        const tid = setTimeout(() => rejectDone(new Error('timeout waiting for result')), 20_000);
        if (typeof el.on === 'function') {
          const offResult = el.on('result', () => { clearTimeout(tid); offResult(); resolveDone(); });
          const offError = el.on('error', (err) => {
            clearTimeout(tid);
            offError();
            rejectDone(err instanceof Error ? err : new Error(String(err)));
          });
        } else {
          // Fallback: legacy event.
          const handler = () => { clearTimeout(tid); el.removeEventListener('geochatbot:layer-loaded', handler); resolveDone(); };
          el.addEventListener('geochatbot:layer-loaded', handler);
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
});
