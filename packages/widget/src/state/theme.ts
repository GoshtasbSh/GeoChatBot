/**
 * Theme resolution helpers for the dashboard. Pure, no DOM ownership;
 * `element.ts` chooses when to read/write attributes.
 *
 * Spec: docs/superpowers/specs/2026-05-08-phase-7-dashboard-redesign-design.md §2
 */
export type ThemeMode = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

/** Default media query for the OS preference. Test code passes a fake. */
const defaultMql = (): MediaQueryList | null =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

/**
 * Given a mode and a MediaQueryList, return the *effective* theme.
 * `light` and `dark` short-circuit; `auto` reads the media query.
 */
export function resolveTheme(
  mode: ThemeMode,
  mql: MediaQueryList | null = defaultMql(),
): ResolvedTheme {
  if (mode === 'light' || mode === 'dark') return mode;
  return mql?.matches ? 'dark' : 'light';
}

/** Set the `theme` attribute on a host element. */
export function applyTheme(host: Element, mode: ThemeMode): void {
  host.setAttribute('theme', mode);
}

/**
 * Subscribe to OS theme changes. Callback receives the new resolved
 * theme. Returns a cleanup function. Works against a fake MediaQueryList
 * for tests; defaults to `window.matchMedia` in production.
 */
export function subscribeOSTheme(
  cb: (next: ResolvedTheme) => void,
  mql: MediaQueryList | null = defaultMql(),
): () => void {
  if (!mql) return () => {};
  const listener = (e: MediaQueryListEvent): void => {
    cb(e.matches ? 'dark' : 'light');
  };
  mql.addEventListener('change', listener);
  return () => mql.removeEventListener('change', listener);
}
