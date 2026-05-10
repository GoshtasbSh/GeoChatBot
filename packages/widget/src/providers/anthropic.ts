/**
 * Anthropic provider — talks directly to the Messages API via `fetch`.
 *
 * Auth: `x-api-key: <apiKey>` plus `anthropic-version: 2023-06-01`.
 * Free tier: NO. Anthropic does not offer an ongoing free tier.
 *
 * BROWSER WARNING: calling Anthropic directly from a browser context
 * exposes your API key to every site visitor. The SDK requires
 * `anthropic-dangerous-direct-browser-access: true` to even attempt it,
 * and we mirror that gate here. In production, proxy through your own
 * server. The `dangerouslyAllowBrowser` flag exists only so prototypes
 * and local-only demos can work without a backend.
 */

import {
	type ChatMessage,
	type ChatProvider,
	type GenerateInput,
	type GenerateOutput,
	ProviderError,
} from "./types.js";

export interface AnthropicOptions {
	apiKey: string;
	model?: string;
	dangerouslyAllowBrowser?: boolean;
}

const ID = "anthropic";
const ENDPOINT = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";

export function createAnthropic(opts: AnthropicOptions): ChatProvider {
	const model = opts.model ?? "claude-haiku-4-5-20251001";

	return {
		id: ID,
		label: "Anthropic",
		free: false,
		async generate(input: GenerateInput): Promise<GenerateOutput> {
			// Evaluate browser presence at call time (covers SSR → hydration).
			const inBrowser = typeof window !== "undefined";
			if (inBrowser && opts.dangerouslyAllowBrowser !== true) {
				throw new ProviderError(
					"UNSUPPORTED",
					"Direct-from-browser Anthropic calls leak the API key. Pass dangerouslyAllowBrowser:true to acknowledge, or proxy through your own server.",
					ID,
				);
			}
			const { system, messages } = splitSystem(input.messages);
			const body: Record<string, unknown> = {
				model,
				messages: messages.map((m) => ({ role: m.role, content: m.content })),
				max_tokens: input.maxTokens ?? 1024,
			};
			if (system) body.system = system;
			if (input.temperature !== undefined) body.temperature = input.temperature;

			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				"x-api-key": opts.apiKey,
				"anthropic-version": VERSION,
			};
			if (inBrowser)
				headers["anthropic-dangerous-direct-browser-access"] = "true";

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
				if (err instanceof Error && err.name === "AbortError") {
					throw new ProviderError("ABORTED", "Request aborted", ID);
				}
				// Do NOT include err.message — fetch failure messages on some
				// runtimes echo the request URL or headers (which would leak the
				// API key carried in `x-api-key`).
				throw new ProviderError("NETWORK", "Network error (fetch failed)", ID);
			}

			if (!res.ok) {
				if (res.status === 401 || res.status === 403) {
					throw new ProviderError(
						"AUTH",
						`Auth failed (${res.status})`,
						ID,
						res.status,
					);
				}
				if (res.status === 429) {
					throw new ProviderError(
						"RATE_LIMIT",
						"Rate limited (429)",
						ID,
						res.status,
					);
				}
				if (res.status >= 500) {
					throw new ProviderError(
						"NETWORK",
						`Server error (${res.status})`,
						ID,
						res.status,
					);
				}
				throw new ProviderError(
					"BAD_RESPONSE",
					`HTTP ${res.status}`,
					ID,
					res.status,
				);
			}

			let json: unknown;
			try {
				json = await res.json();
			} catch {
				throw new ProviderError("BAD_RESPONSE", "Malformed JSON response", ID);
			}
			const text = extractText(json);
			if (text === undefined) {
				throw new ProviderError(
					"BAD_RESPONSE",
					"Response had no text blocks",
					ID,
				);
			}
			const out: GenerateOutput = { text, model };
			const usage = extractUsage(json);
			if (usage) out.usage = usage;
			return out;
		},
	};
}

function splitSystem(messages: ChatMessage[]): {
	system: string | undefined;
	messages: ChatMessage[];
} {
	const sys: string[] = [];
	const rest: ChatMessage[] = [];
	for (const m of messages) {
		if (m.role === "system") sys.push(m.content);
		else rest.push(m);
	}
	return { system: sys.length ? sys.join("\n\n") : undefined, messages: rest };
}

function extractText(json: unknown): string | undefined {
	if (!json || typeof json !== "object") return undefined;
	const content = (json as { content?: unknown }).content;
	if (!Array.isArray(content) || content.length === 0) return undefined;
	// Concatenate all text blocks; tool_use / other blocks are ignored.
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const cast = block as { type?: unknown; text?: unknown };
		if (cast.type === "text" && typeof cast.text === "string")
			parts.push(cast.text);
	}
	return parts.length ? parts.join("") : undefined;
}

function extractUsage(
	json: unknown,
): { inputTokens?: number; outputTokens?: number } | undefined {
	if (!json || typeof json !== "object") return undefined;
	const u = (json as { usage?: unknown }).usage;
	if (!u || typeof u !== "object") return undefined;
	const cast = u as { input_tokens?: unknown; output_tokens?: unknown };
	const out: { inputTokens?: number; outputTokens?: number } = {};
	if (typeof cast.input_tokens === "number")
		out.inputTokens = cast.input_tokens;
	if (typeof cast.output_tokens === "number")
		out.outputTokens = cast.output_tokens;
	return out.inputTokens === undefined && out.outputTokens === undefined
		? undefined
		: out;
}
