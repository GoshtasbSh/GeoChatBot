/**
 * OpenAI-compatible forced-tool adapter.
 *
 * Both Groq and OpenAI itself speak the same /chat/completions schema:
 *   - request: { model, messages, tools, tool_choice }
 *   - response: choices[0].message.tool_calls[].function.{name,arguments}
 *     where `arguments` is a JSON-encoded STRING (not an object).
 *
 * This module is parameterised by endpoint; the per-provider adapters
 * (groq.ts, openai.ts) wrap it with their own URL + provider id.
 */

import {
	ForcedToolError,
	type ForcedToolInput,
	type ProviderId,
} from "./types.js";

export async function callOpenAICompat(
	input: ForcedToolInput,
	endpoint: string,
	provider: ProviderId,
): Promise<Record<string, unknown>> {
	const inBrowser = typeof window !== "undefined";
	if (inBrowser && input.dangerouslyAllowBrowser !== true) {
		throw new ForcedToolError(
			"NETWORK",
			provider,
			`Direct-from-browser ${provider} calls leak the API key. Pass dangerouslyAllowBrowser:true to acknowledge, or proxy through your own server.`,
		);
	}

	// OpenAI-style APIs expect a single system message at the start.
	// Concatenate the cached + dynamic prefixes; OpenAI/Groq don't have
	// a per-block prompt cache, so this is the most we can do.
	const systemContent = input.systemPrompt
		? `${input.cachedSystemPrompt}\n\n${input.systemPrompt}`
		: input.cachedSystemPrompt;

	const body = {
		model: input.model,
		temperature: input.temperature ?? 0,
		max_tokens: input.maxTokens ?? 2048,
		messages: [
			{ role: "system", content: systemContent },
			{ role: "user", content: input.userMessage },
		],
		tools: [
			{
				type: "function",
				function: {
					name: input.toolName,
					description: input.toolDescription,
					parameters: input.toolInputSchema,
				},
			},
		],
		tool_choice: { type: "function", function: { name: input.toolName } },
	};

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${input.apiKey}`,
	};

	let res: Response;
	try {
		const init: RequestInit = {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		};
		if (input.signal) init.signal = input.signal;
		res = await fetch(endpoint, init);
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") throw err;
		throw new ForcedToolError("NETWORK", provider, "fetch failed");
	}
	if (!res.ok) {
		if (res.status === 401 || res.status === 403) {
			throw new ForcedToolError(
				"AUTH",
				provider,
				`auth failed (${res.status})`,
				res.status,
			);
		}
		if (res.status === 429) {
			throw new ForcedToolError(
				"RATE_LIMIT",
				provider,
				"rate limited (429)",
				res.status,
			);
		}
		throw new ForcedToolError(
			"BAD_RESPONSE",
			provider,
			`http ${res.status}`,
			res.status,
		);
	}
	let json: unknown;
	try {
		json = await res.json();
	} catch {
		throw new ForcedToolError(
			"BAD_RESPONSE",
			provider,
			"response body is not JSON",
			res.status,
		);
	}
	const args = extractToolCallArguments(json, input.toolName);
	if (args === null) {
		throw new ForcedToolError(
			"NO_TOOL_USE",
			provider,
			"no tool_calls block in response",
		);
	}
	return args;
}

/**
 * Find the first tool_calls entry that matches `toolName` and parse its
 * arguments string into an object. OpenAI/Groq return arguments as a
 * JSON-encoded STRING; small-and-cheap models occasionally hand back
 * malformed JSON, which we surface as BAD_RESPONSE rather than silently
 * coercing.
 */
function extractToolCallArguments(
	json: unknown,
	toolName: string,
): Record<string, unknown> | null {
	if (!json || typeof json !== "object") return null;
	const choices = (json as { choices?: unknown }).choices;
	if (!Array.isArray(choices) || choices.length === 0) return null;
	const message = (choices[0] as { message?: unknown }).message;
	if (!message || typeof message !== "object") return null;
	const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
	if (!Array.isArray(toolCalls)) return null;
	for (const tc of toolCalls) {
		if (!tc || typeof tc !== "object") continue;
		const fn = (tc as { function?: unknown }).function;
		if (!fn || typeof fn !== "object") continue;
		const fname = (fn as { name?: unknown }).name;
		const fargs = (fn as { arguments?: unknown }).arguments;
		if (fname !== toolName) continue;
		if (typeof fargs !== "string") continue;
		try {
			const parsed = JSON.parse(fargs);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// Some models return tool_calls with empty / partial JSON. Treat
			// as missing rather than mis-coding to BAD_RESPONSE — caller can
			// distinguish via the NO_TOOL_USE code.
			return null;
		}
	}
	return null;
}
