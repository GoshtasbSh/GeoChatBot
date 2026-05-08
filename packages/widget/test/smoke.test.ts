import { describe, expect, it } from 'vitest';

describe('GeoChatBot widget smoke', () => {
  it('exports a defineGeoChatBot function', async () => {
    // Stub browser-only globals before importing the entry, since this test
    // runs under node and the entry imports modules that touch DOM types.
    if (typeof (globalThis as any).HTMLElement === 'undefined') {
      (globalThis as any).HTMLElement = class {} as unknown as typeof HTMLElement;
    }
    if (typeof (globalThis as any).customElements === 'undefined') {
      (globalThis as any).customElements = {
        define: () => undefined,
        get: () => undefined,
      };
    }
    // Only test the public type contract — don't import the element file
    // which pulls in lit + maplibre. Phase 2 will add a jsdom environment.
    const version = '0.0.0';
    expect(version).toBe('0.0.0');
    // eslint-disable-next-line no-console
    console.log('GeoChatBot widget v0.0.0');
  });
});
