/**
 * Groq provider — thin wrapper over `createOpenAICompat`.
 *
 * Groq currently offers the most generous **free** hosted-LLM tier
 * available, with very low latency on llama-3.x models. Sign up at
 * https://console.groq.com to get a key.
 *
 * Auth: `Authorization: Bearer <apiKey>`.
 * Browser: hosted endpoint — running directly from the browser leaks
 * the key. In production, proxy through your own server. For local
 * evaluation/demo, callers may accept the risk.
 */

import { createOpenAICompat } from './openai-compat.js';
import type { ChatProvider } from './types.js';

export interface GroqOptions {
  apiKey: string;
  model?: string;
}

export function createGroq(opts: GroqOptions): ChatProvider {
  return createOpenAICompat({
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: opts.apiKey,
    model: opts.model ?? 'llama-3.3-70b-versatile',
    id: 'groq',
    label: 'Groq (free tier)',
    free: true,
  });
}
