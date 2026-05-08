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

  it('emits a `result` event with the expected shape for points.csv', async () => {
    const el = mountElement();
    await flushUpdates(el);

    const results: GeoChatBotEvents['result'][] = [];
    el.on('result', (detail) => results.push(detail));

    await el.pushData(fixtureFile('points.csv'));

    expect(results.length).toBe(1);
    const detail = results[0]!;
    expect(detail.name).toBe('points');
    expect(detail.source).toBe('csv');
    expect(typeof detail.engineRegistered).toBe('boolean');
    expect(detail.profile).toBeDefined();
    expect(detail.profile.rowCount).toBe(5);
    expect(Array.isArray(detail.profile.columns)).toBe(true);
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
    await flushUpdates(el);
    expect(el.results.length).toBe(1);
    expect(el.shadowRoot?.querySelectorAll('.table-card').length).toBe(1);

    el.clear();
    await flushUpdates(el);
    expect(el.results.length).toBe(0);
    expect(el.shadowRoot?.querySelectorAll('.table-card').length).toBe(0);
  });
});
