/**
 * Critic-specific Anthropic Messages call. Forces a single `tool_use`
 * round-trip with `tool_choice` pinned to `submit_diagnosis`. Caches the
 * static system prefix via `cache_control: ephemeral` so subsequent calls
 * are cheap.
 *
 * Mirrors agent/llm.ts (the planner caller) but with a different forced
 * tool and a different response schema. Kept as a separate function
 * deliberately — see plan task §2 for the rationale.
 */

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';

const TOOL_NAME = 'submit_diagnosis';
const TOOL_DESC =
  'Decide what to do about a failed step. Either propose a corrected step (action="patch"), request a plain retry (action="retry"), or declare unrecoverable (action="abort").';

export interface CriticLLMInput {
  apiKey: string;
  model: string;
  cachedSystemPrompt: string;
  systemPrompt: string;
  userMessage: string;
  toolInputSchema: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  dangerouslyAllowBrowser?: boolean;
}

export class CriticLLMError extends Error {
  readonly code: 'AUTH' | 'RATE_LIMIT' | 'NETWORK' | 'BAD_RESPONSE' | 'NO_TOOL_USE';
  readonly status?: number;
  constructor(code: CriticLLMError['code'], message: string, status?: number) {
    super(message);
    this.name = 'CriticLLMError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export async function callCriticLLM(
  input: CriticLLMInput,
): Promise<Record<string, unknown>> {
  const inBrowser = typeof window !== 'undefined';
  if (inBrowser && input.dangerouslyAllowBrowser !== true) {
    throw new CriticLLMError(
      'NETWORK',
      'Direct-from-browser Anthropic calls leak the API key. Pass dangerouslyAllowBrowser:true to acknowledge, or proxy through your own server.',
    );
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': input.apiKey,
    'anthropic-version': VERSION,
  };
  if (inBrowser) headers['anthropic-dangerous-direct-browser-access'] = 'true';

  // Build the system blocks. Skip the second block when systemPrompt is
  // empty — Anthropic accepts a single-block array, and emitting an empty
  // text block both wastes a structured slot and confuses the cache layout.
  const systemBlocks: Array<Record<string, unknown>> = [
    { type: 'text', text: input.cachedSystemPrompt, cache_control: { type: 'ephemeral' } },
  ];
  if (input.systemPrompt) {
    systemBlocks.push({ type: 'text', text: input.systemPrompt });
  }

  const body = {
    model: input.model,
    max_tokens: input.maxTokens ?? 1024,
    temperature: input.temperature ?? 0,
    system: systemBlocks,
    messages: [{ role: 'user', content: input.userMessage }],
    tools: [
      {
        name: TOOL_NAME,
        description: TOOL_DESC,
        input_schema: input.toolInputSchema,
      },
    ],
    tool_choice: { type: 'tool', name: TOOL_NAME },
  };

  let res: Response;
  try {
    const init: RequestInit = { method: 'POST', headers, body: JSON.stringify(body) };
    if (input.signal) init.signal = input.signal;
    res = await fetch(ENDPOINT, init);
  } catch (err) {
    // Cancellations propagate as native AbortError so callers (Critic
    // class, ask() flow) can distinguish "user navigated away" from "the
    // network is broken." Wrapping AbortError into a NETWORK error would
    // collapse both cases to the same code and silently turn a
    // cancellation into a critic-says-abort decision.
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new CriticLLMError('NETWORK', 'fetch failed');
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new CriticLLMError('AUTH', `auth failed (${res.status})`, res.status);
    }
    if (res.status === 429) {
      throw new CriticLLMError('RATE_LIMIT', `rate limited (429)`, res.status);
    }
    throw new CriticLLMError('BAD_RESPONSE', `http ${res.status}`, res.status);
  }
  // Distinguish "body is not JSON" (BAD_RESPONSE — wrong content-type or
  // an HTML error page) from "JSON parsed fine but had no tool_use block"
  // (NO_TOOL_USE — model declined to call the tool). Collapsing both into
  // NO_TOOL_USE would mis-code the failure for any retry/monitor logic
  // that branches on `code`.
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new CriticLLMError('BAD_RESPONSE', 'response body is not JSON', res.status);
  }
  const block = extractToolUse(json, TOOL_NAME);
  if (!block) {
    throw new CriticLLMError('NO_TOOL_USE', 'no tool_use block in response');
  }
  return block;
}

function extractToolUse(
  json: unknown,
  toolName: string,
): Record<string, unknown> | null {
  if (!json || typeof json !== 'object') return null;
  const content = (json as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const c = b as { type?: unknown; name?: unknown; input?: unknown };
    if (c.type === 'tool_use' && c.name === toolName && c.input && typeof c.input === 'object') {
      return c.input as Record<string, unknown>;
    }
  }
  return null;
}
