// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { resolveTheme, applyTheme, subscribeOSTheme } from '../../src/state/theme.js';

function fakeMql(matches: boolean): MediaQueryList {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  return {
    matches,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => listeners.add(l),
    removeEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => listeners.delete(l),
    dispatchEvent: () => true,
    addListener: () => {},
    removeListener: () => {},
    // expose for tests
    __listeners: listeners,
  } as unknown as MediaQueryList;
}

describe('theme resolver', () => {
  it('resolveTheme returns the explicit mode for light/dark', () => {
    expect(resolveTheme('light', fakeMql(false))).toBe('light');
    expect(resolveTheme('light', fakeMql(true))).toBe('light');
    expect(resolveTheme('dark', fakeMql(false))).toBe('dark');
    expect(resolveTheme('dark', fakeMql(true))).toBe('dark');
  });

  it('resolveTheme(auto) follows the media-query', () => {
    expect(resolveTheme('auto', fakeMql(false))).toBe('light');
    expect(resolveTheme('auto', fakeMql(true))).toBe('dark');
  });

  it('applyTheme sets the host theme attribute to the requested mode', () => {
    const host = document.createElement('div');
    applyTheme(host, 'dark');
    expect(host.getAttribute('theme')).toBe('dark');
    applyTheme(host, 'auto');
    expect(host.getAttribute('theme')).toBe('auto');
  });

  it('subscribeOSTheme invokes the callback on media-query change and returns a cleanup', () => {
    const mql = fakeMql(false);
    const cb = vi.fn();
    const off = subscribeOSTheme(cb, mql);
    const listeners = (mql as unknown as { __listeners: Set<(e: MediaQueryListEvent) => void> }).__listeners;
    expect(listeners.size).toBe(1);
    // Simulate a change to dark
    listeners.forEach((l) => l({ matches: true } as MediaQueryListEvent));
    expect(cb).toHaveBeenCalledWith('dark');
    off();
    expect(listeners.size).toBe(0);
  });
});
