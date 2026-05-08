/**
 * Critic-side forced-tool dispatcher.
 *
 * Thin wrapper around the provider-agnostic `callForcedTool` registry.
 * The Critic always forces `submit_diagnosis`; the per-provider quirks
 * live in `agent/forced-tool/<provider>.ts`.
 */

import {
  callForcedTool,
  ForcedToolError,
  type ProviderId,
} from './forced-tool/index.js';

const TOOL_NAME = 'submit_diagnosis';
const TOOL_DESC =
  'Decide what to do about a failed step. Either propose a corrected step (action="patch"), request a plain retry (action="retry"), or declare unrecoverable (action="abort").';

export interface CriticLLMInput {
  /** Provider id; defaults to 'anthropic' if omitted. */
  provider?: ProviderId;
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
  const provider = input.provider ?? 'anthropic';
  try {
    return await callForcedTool({
      provider,
      apiKey: input.apiKey,
      model: input.model,
      cachedSystemPrompt: input.cachedSystemPrompt,
      systemPrompt: input.systemPrompt,
      userMessage: input.userMessage,
      toolName: TOOL_NAME,
      toolDescription: TOOL_DESC,
      toolInputSchema: input.toolInputSchema,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : { temperature: 0 }),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : { maxTokens: 1024 }),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.dangerouslyAllowBrowser !== undefined
        ? { dangerouslyAllowBrowser: input.dangerouslyAllowBrowser }
        : {}),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    if (err instanceof ForcedToolError) {
      // ABORTED is unreachable here (AbortError is rethrown above); the
      // remaining ForcedToolError codes map 1:1 to CriticLLMError codes.
      const code = err.code as CriticLLMError['code'];
      throw new CriticLLMError(code, err.message, err.status);
    }
    throw err;
  }
}
