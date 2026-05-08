/**
 * Provider-agnostic "forced tool call" types.
 *
 * Both the Planner (submit_plan) and the Critic (submit_diagnosis) use a
 * single forced-tool round-trip to obtain structured JSON output. Each
 * provider has its own native protocol — Anthropic uses tool_use blocks,
 * Groq + OpenAI use function calls, Gemini uses functionDeclarations —
 * but the inputs we need to express ("call THIS tool with THIS schema
 * and return its arguments") are identical across providers.
 *
 * This module names the shared shape; provider-specific adapters live
 * alongside this file (anthropic.ts, groq.ts, openai.ts, gemini.ts) and
 * the dispatcher in index.ts picks the right one by `provider`.
 */

/** Recognised provider ids. Only these four implement forced tool calls. */
export type ProviderId = 'anthropic' | 'groq' | 'openai' | 'gemini';

export interface ForcedToolInput {
  provider: ProviderId;
  apiKey: string;
  model: string;
  /**
   * System message that is identical across calls (e.g. the planner's
   * tool catalogue + few-shots). Anthropic caches this via
   * cache_control:ephemeral; other providers concatenate it with
   * `systemPrompt` into a single system message.
   */
  cachedSystemPrompt: string;
  /**
   * Optional dynamic system prefix (e.g. the dataset profile). Concatenated
   * after `cachedSystemPrompt`. Empty/undefined skips the slot.
   */
  systemPrompt?: string;
  /** Single user turn. */
  userMessage: string;
  toolName: string;
  toolDescription: string;
  /** OpenAPI-3 / JSON-Schema for the tool's input. */
  toolInputSchema: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * Acknowledge that calling LLM APIs from the browser exposes the API
   * key to scripts on the page. All adapters refuse direct-from-browser
   * calls unless this is explicitly true.
   */
  dangerouslyAllowBrowser?: boolean;
}

export class ForcedToolError extends Error {
  readonly code:
    | 'AUTH'
    | 'RATE_LIMIT'
    | 'NETWORK'
    | 'BAD_RESPONSE'
    | 'NO_TOOL_USE'
    | 'ABORTED';
  readonly provider: ProviderId;
  readonly status?: number;
  constructor(
    code: ForcedToolError['code'],
    provider: ProviderId,
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = 'ForcedToolError';
    this.code = code;
    this.provider = provider;
    if (status !== undefined) this.status = status;
  }
}

/** A provider-specific adapter. Returns the parsed tool input as a plain object. */
export type ForcedToolAdapter = (
  input: ForcedToolInput,
) => Promise<Record<string, unknown>>;

/** Thrown by the dispatcher when an unknown provider id is passed. */
export class UnknownProviderError extends Error {
  constructor(provider: string) {
    super(`unknown provider: ${provider}`);
    this.name = 'UnknownProviderError';
  }
}
