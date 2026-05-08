/**
 * Module-level singleton registry for the active ChatProvider.
 *
 * The widget's element layer reads from `getProvider()` at request time,
 * so hosts can swap providers at runtime (e.g. between a free tier and a
 * paid one) without re-mounting the component.
 */

import type { ChatProvider } from './types.js';

let active: ChatProvider | undefined;

export function setProvider(p: ChatProvider): void {
  active = p;
}

export function getProvider(): ChatProvider | undefined {
  return active;
}

export function clearProvider(): void {
  active = undefined;
}
