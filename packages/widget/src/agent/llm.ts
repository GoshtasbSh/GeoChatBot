/**
 * Planner-specific Anthropic Messages call. Forces a single `tool_use`
 * round-trip with `tool_choice` pinned to `submit_plan`. Caches the static
 * system prefix via `cache_control: ephemeral` so subsequent calls are cheap.
 *
 * NOT routed through `src/providers/anthropic.ts` because that provider is
 * vendor-neutral and text-only by design.
 */

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';

export interface PlannerLLMInput {
  apiKey: string;
  model: string;
  cachedSystemPrompt: string;
  systemPrompt: string;
  userQuestion: string;
  toolName: string;
  toolDescription: string;
  toolInputSchema: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  dangerouslyAllowBrowser?: boolean;
}

export class PlannerLLMError extends Error {
  readonly code:
    | 'AUTH'
    | 'RATE_LIMIT'
    | 'NETWORK'
    | 'BAD_RESPONSE'
    | 'NO_TOOL_USE'
    | 'ABORTED';
  readonly status?: number;
  constructor(code: PlannerLLMError['code'], message: string, status?: number) {
    super(message);
    this.name = 'PlannerLLMError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export async function callPlannerLLM(input: PlannerLLMInput): Promise<Record<string, unknown>> {
  const inBrowser = typeof window !== 'undefined';
  if (inBrowser && input.dangerouslyAllowBrowser !== true) {
    throw new PlannerLLMError(
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

  const body = {
    model: input.model,
    max_tokens: input.maxTokens ?? 2048,
    temperature: input.temperature ?? 0,
    system: [
      { type: 'text', text: input.cachedSystemPrompt, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: input.systemPrompt },
    ],
    messages: [
      { role: 'user', content: input.userQuestion },
    ],
    tools: [
      {
        name: input.toolName,
        description: input.toolDescription,
        input_schema: input.toolInputSchema,
      },
    ],
    tool_choice: { type: 'tool', name: input.toolName },
  };

  let res: Response;
  try {
    const init: RequestInit = { method: 'POST', headers, body: JSON.stringify(body) };
    if (input.signal) init.signal = input.signal;
    res = await fetch(ENDPOINT, init);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new PlannerLLMError('ABORTED', 'aborted');
    }
    throw new PlannerLLMError('NETWORK', 'fetch failed');
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new PlannerLLMError('AUTH', `auth failed (${res.status})`, res.status);
    }
    if (res.status === 429) {
      throw new PlannerLLMError('RATE_LIMIT', `rate limited (429)`, res.status);
    }
    throw new PlannerLLMError('BAD_RESPONSE', `http ${res.status}`, res.status);
  }
  const json = await res.json().catch(() => null);
  const block = extractToolUse(json, input.toolName);
  if (!block) throw new PlannerLLMError('NO_TOOL_USE', 'no tool_use block in response');
  return block;
}

function extractToolUse(json: unknown, toolName: string): Record<string, unknown> | null {
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
