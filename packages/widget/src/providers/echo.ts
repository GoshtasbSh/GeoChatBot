/**
 * Echo provider — offline, dependency-free, used for tests and the
 * "no network" path. Returns the most recent user message prefixed
 * with `echo: `. Free, since it never leaves the browser.
 */

import type { ChatProvider, GenerateInput, GenerateOutput } from './types.js';

export function createEcho(): ChatProvider {
  return {
    id: 'echo',
    label: 'Echo (offline)',
    free: true,
    async generate(input: GenerateInput): Promise<GenerateOutput> {
      const lastUser = [...input.messages].reverse().find((m) => m.role === 'user');
      const text = lastUser ? `echo: ${lastUser.content}` : 'echo:';
      return { text };
    },
  };
}
