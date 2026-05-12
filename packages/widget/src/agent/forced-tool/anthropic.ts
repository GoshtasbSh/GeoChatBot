/**
 * Anthropic forced-tool adapter.
 *
 * Uses native Anthropic Messages API + `tool_use` blocks with
 * `tool_choice: { type: 'tool', name: ... }` to force exactly one
 * tool call. The static system prefix gets `cache_control: ephemeral`
 * so subsequent calls pay the prompt-cache rate.
 */

import {
	ForcedToolError,
	type ForcedToolInput,
	parseRetryAfter,
} from "./types.js";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";
const PROVIDER = "anthropic" as const;

export async function callAnthropic(
	input: ForcedToolInput,
): Promise<Record<string, unknown>> {
	const inBrowser = typeof window !== "undefined";
	if (inBrowser && input.dangerouslyAllowBrowser !== true) {
		// AUDIT-017: use UNSUPPORTED (not NETWORK) so the UI surfaces a
		// config-must-change message rather than prompting a retry.
		throw new ForcedToolError(
			"UNSUPPORTED",
			PROVIDER,
			"Direct-from-browser Anthropic calls leak the API key. Pass dangerouslyAllowBrowser:true to acknowledge, or proxy through your own server.",
		);
	}

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"x-api-key": input.apiKey,
		"anthropic-version": VERSION,
	};
	if (inBrowser) headers["anthropic-dangerous-direct-browser-access"] = "true";

	// Build system blocks: the cached prefix always goes first with
	// cache_control. Skip the dynamic block when empty so we don't
	// emit a wasted text:'' entry (matches critic-llm.ts MED-4 fix).
	const systemBlocks: Array<Record<string, unknown>> = [
		{
			type: "text",
			text: input.cachedSystemPrompt,
			cache_control: { type: "ephemeral" },
		},
	];
	if (input.systemPrompt) {
		systemBlocks.push({ type: "text", text: input.systemPrompt });
	}

	const body = {
		model: input.model,
		max_tokens: input.maxTokens ?? 2048,
		temperature: input.temperature ?? 0,
		system: systemBlocks,
		messages: [{ role: "user", content: input.userMessage }],
		tools: [
			{
				name: input.toolName,
				description: input.toolDescription,
				input_schema: input.toolInputSchema,
			},
		],
		tool_choice: { type: "tool", name: input.toolName },
	};

	let res: Response;
	try {
		const init: RequestInit = {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		};
		if (input.signal) init.signal = input.signal;
		res = await fetch(ENDPOINT, init);
	} catch (err) {
		// Cancellations propagate as native AbortError so the host can
		// distinguish user-initiated abort from a real network failure.
		if (err instanceof Error && err.name === "AbortError") throw err;
		throw new ForcedToolError("NETWORK", PROVIDER, "fetch failed");
	}
	if (!res.ok) {
		if (res.status === 401 || res.status === 403) {
			throw new ForcedToolError(
				"AUTH",
				PROVIDER,
				`auth failed (${res.status})`,
				res.status,
			);
		}
		if (res.status === 429) {
			const retryAfterMs = parseRetryAfter(res.headers.get("Retry-After"));
			throw new ForcedToolError(
				"RATE_LIMIT",
				PROVIDER,
				retryAfterMs !== undefined
					? `rate limited (429), retry after ${Math.ceil(retryAfterMs / 1000)}s`
					: "rate limited (429)",
				res.status,
				retryAfterMs,
			);
		}
		if (res.status >= 500) {
			// AUDIT-018: 5xx is transient; map to NETWORK so the UI
			// surfaces a "retry later" affordance instead of the
			// "the LLM returned garbage" implication of BAD_RESPONSE.
			throw new ForcedToolError(
				"NETWORK",
				PROVIDER,
				`upstream ${res.status}`,
				res.status,
			);
		}
		throw new ForcedToolError(
			"BAD_RESPONSE",
			PROVIDER,
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
			PROVIDER,
			"response body is not JSON",
			res.status,
		);
	}
	const block = extractToolUse(json, input.toolName);
	if (!block) {
		throw new ForcedToolError(
			"NO_TOOL_USE",
			PROVIDER,
			"no tool_use block in response",
		);
	}
	return block;
}

function extractToolUse(
	json: unknown,
	toolName: string,
): Record<string, unknown> | null {
	if (!json || typeof json !== "object") return null;
	const content = (json as { content?: unknown }).content;
	if (!Array.isArray(content)) return null;
	for (const b of content) {
		if (!b || typeof b !== "object") continue;
		const c = b as { type?: unknown; name?: unknown; input?: unknown };
		if (
			c.type === "tool_use" &&
			c.name === toolName &&
			c.input &&
			typeof c.input === "object"
		) {
			return c.input as Record<string, unknown>;
		}
	}
	return null;
}
