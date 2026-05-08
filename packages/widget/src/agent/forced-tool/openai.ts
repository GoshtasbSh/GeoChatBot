/**
 * OpenAI forced-tool adapter.
 *
 * Same /chat/completions schema as Groq, just a different host.
 * OpenAI does not have a free tier; users get $5 free credit on
 * sign-up and pay per token thereafter.
 */

import { callOpenAICompat } from './openai-compat.js';
import type { ForcedToolInput } from './types.js';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

export async function callOpenAI(
  input: ForcedToolInput,
): Promise<Record<string, unknown>> {
  return callOpenAICompat(input, ENDPOINT, 'openai');
}
