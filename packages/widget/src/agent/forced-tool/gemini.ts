/**
 * Google Gemini forced-tool adapter.
 *
 * Gemini's tool-call protocol is its own thing:
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *   Body: {
 *     contents: [{ role: 'user', parts: [{ text }] }],
 *     systemInstruction: { parts: [{ text }] },
 *     tools: [{ functionDeclarations: [{ name, description, parameters }] }],
 *     toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [name] } }
 *   }
 *   Response: candidates[0].content.parts[].functionCall.{name, args}
 *
 * `args` is already an object — no JSON.parse needed (unlike OpenAI).
 *
 * Free tier: yes (generous; 15 RPM on Flash, 1500 req/day). Users sign
 * up at https://aistudio.google.com/app/apikey for a free key.
 */

import { ForcedToolError, type ForcedToolInput } from './types.js';

const PROVIDER = 'gemini' as const;
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export async function callGemini(
  input: ForcedToolInput,
): Promise<Record<string, unknown>> {
  const inBrowser = typeof window !== 'undefined';
  if (inBrowser && input.dangerouslyAllowBrowser !== true) {
    throw new ForcedToolError(
      'NETWORK',
      PROVIDER,
      'Direct-from-browser Gemini calls leak the API key. Pass dangerouslyAllowBrowser:true to acknowledge, or proxy through your own server.',
    );
  }

  // Gemini requires the API key as a query parameter (it doesn't accept
  // Authorization headers on this endpoint). The key never reaches the
  // request body — same exposure surface as the other providers.
  const url = `${BASE}/${encodeURIComponent(input.model)}:generateContent?key=${encodeURIComponent(input.apiKey)}`;

  const systemContent = input.systemPrompt
    ? `${input.cachedSystemPrompt}\n\n${input.systemPrompt}`
    : input.cachedSystemPrompt;

  const body = {
    systemInstruction: { parts: [{ text: systemContent }] },
    contents: [{ role: 'user', parts: [{ text: input.userMessage }] }],
    generationConfig: {
      temperature: input.temperature ?? 0,
      maxOutputTokens: input.maxTokens ?? 2048,
    },
    tools: [
      {
        functionDeclarations: [
          {
            name: input.toolName,
            description: input.toolDescription,
            parameters: input.toolInputSchema,
          },
        ],
      },
    ],
    toolConfig: {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: [input.toolName],
      },
    },
  };

  let res: Response;
  try {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
    if (input.signal) init.signal = input.signal;
    res = await fetch(url, init);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new ForcedToolError('NETWORK', PROVIDER, 'fetch failed');
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new ForcedToolError('AUTH', PROVIDER, `auth failed (${res.status})`, res.status);
    }
    if (res.status === 429) {
      throw new ForcedToolError('RATE_LIMIT', PROVIDER, `rate limited (429)`, res.status);
    }
    throw new ForcedToolError('BAD_RESPONSE', PROVIDER, `http ${res.status}`, res.status);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ForcedToolError('BAD_RESPONSE', PROVIDER, 'response body is not JSON', res.status);
  }
  const args = extractFunctionCall(json, input.toolName);
  if (args === null) {
    throw new ForcedToolError(
      'NO_TOOL_USE',
      PROVIDER,
      'no functionCall part in response',
    );
  }
  return args;
}

function extractFunctionCall(
  json: unknown,
  toolName: string,
): Record<string, unknown> | null {
  if (!json || typeof json !== 'object') return null;
  const candidates = (json as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const content = (candidates[0] as { content?: unknown }).content;
  if (!content || typeof content !== 'object') return null;
  const parts = (content as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return null;
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    const fc = (p as { functionCall?: unknown }).functionCall;
    if (!fc || typeof fc !== 'object') continue;
    const fname = (fc as { name?: unknown }).name;
    const fargs = (fc as { args?: unknown }).args;
    if (fname !== toolName) continue;
    if (fargs && typeof fargs === 'object' && !Array.isArray(fargs)) {
      return fargs as Record<string, unknown>;
    }
  }
  return null;
}
