// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from 'vitest';
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
  it('renders a .drop zone in its shadow root after first update', async () => {
    const el = mountElement();
    await flushUpdates(el);
    const drop = el.shadowRoot?.querySelector('.drop');
    expect(drop).toBeTruthy();
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

  it('setProvider stores the provider and clear does not remove it', async () => {
    const el = mountElement();
    await flushUpdates(el);

    el.setProvider(stubProvider);
    expect(el.getProvider()).toBe(stubProvider);

    el.clear();
    expect(el.getProvider()).toBe(stubProvider);
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
});
