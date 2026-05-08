/**
 * Groq forced-tool adapter.
 *
 * Groq exposes an OpenAI-compatible /chat/completions endpoint at
 * https://api.groq.com/openai/v1/chat/completions. Tool-calling works
 * identically to OpenAI; this module is a thin URL wrapper.
 *
 * Free-tier reality: Groq's API has no per-token charge but users still
 * register at console.groq.com for an API key. The key is stored in
 * localStorage like any other provider.
 *
 * Recommended models for tool-calling stability:
 *   - llama-3.3-70b-versatile  (default — best plan-shape adherence)
 *   - mixtral-8x7b-32768       (long context)
 * Smaller models (8B, gemma2-9b) tend to drop the forced tool call
 * silently; surface as NO_TOOL_USE.
 */

import { callOpenAICompat } from './openai-compat.js';
import type { ForcedToolInput } from './types.js';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

export async function callGroq(
  input: ForcedToolInput,
): Promise<Record<string, unknown>> {
  return callOpenAICompat(input, ENDPOINT, 'groq');
}
