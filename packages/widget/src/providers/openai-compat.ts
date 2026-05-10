/**
 * OpenAI-compatible Chat Completions adapter.
 *
 * Many vendors expose the OpenAI Chat Completions REST surface and can
 * be plugged in by setting `baseUrl`:
 *   - Groq:      https://api.groq.com/openai/v1
 *   - Together:  https://api.together.xyz/v1
 *   - OpenRouter:https://openrouter.ai/api/v1
 *   - Fireworks: https://api.fireworks.ai/inference/v1
 *   - Ollama:    http://localhost:11434/v1
 *   - llama.cpp / vLLM:  local server endpoints
 *
 * Auth: `Authorization: Bearer <apiKey>`. No retries — surfaces a
 * `ProviderError` so the caller decides what to do.
 *
 * Browser safety: most hosted vendors require a server-side proxy in
 * production because direct-from-browser calls leak the API key. Local
 * endpoints (Ollama, llama.cpp) are safe.
 */

import {
	type ChatProvider,
	type GenerateInput,
	type GenerateOutput,
	ProviderError,
} from "./types.js";

export interface OpenAICompatOptions {
	baseUrl: string;
	apiKey: string;
	model: string;
	label?: string;
	id?: string;
	headers?: Record<string, string>;
	free?: boolean;
}

export function createOpenAICompat(opts: OpenAICompatOptions): ChatProvider {
	const id = opts.id ?? "openai-compat";
	const label = opts.label ?? "OpenAI-Compatible";
	// Reject baseUrls that aren't http/https. Without this, a caller that
	// surfaces baseUrl in a settings UI could let a user paste e.g.
	// `javascript:` or `data:` URLs and ship the bearer token there.
	let parsed: URL;
	try {
		parsed = new URL(opts.baseUrl);
	} catch {
		throw new ProviderError("UNSUPPORTED", "baseUrl is not a valid URL", id);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new ProviderError(
			"UNSUPPORTED",
			`baseUrl protocol must be http: or https:, got ${parsed.protocol}`,
			id,
		);
	}
	const provider: ChatProvider = {
		id,
		label,
		...(opts.free !== undefined ? { free: opts.free } : {}),
		async generate(input: GenerateInput): Promise<GenerateOutput> {
			const url = `${opts.baseUrl.replace(/\/$/, "")}/chat/completions`;
			const body: Record<string, unknown> = {
				model: opts.model,
				messages: input.messages.map((m) => ({
					role: m.role,
					content: m.content,
				})),
				stream: false,
			};
			if (input.temperature !== undefined) body.temperature = input.temperature;
			if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens;

			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				Authorization: `Bearer ${opts.apiKey}`,
				...(opts.headers ?? {}),
			};

			let res: Response;
			try {
				const init: RequestInit = {
					method: "POST",
					headers,
					body: JSON.stringify(body),
				};
				if (input.signal) init.signal = input.signal;
				res = await fetch(url, init);
			} catch (err) {
				if (isAbortError(err)) {
					throw new ProviderError("ABORTED", "Request aborted", id);
				}
				// Do NOT include err.message — fetch failure messages on some
				// runtimes echo the request URL or headers (which would leak the
				// bearer token carried in `Authorization`).
				throw new ProviderError("NETWORK", "Network error (fetch failed)", id);
			}

			if (!res.ok) {
				if (res.status === 401 || res.status === 403) {
					throw new ProviderError(
						"AUTH",
						`Auth failed (${res.status})`,
						id,
						res.status,
					);
				}
				if (res.status === 429) {
					throw new ProviderError(
						"RATE_LIMIT",
						"Rate limited (429)",
						id,
						res.status,
					);
				}
				if (res.status >= 500) {
					throw new ProviderError(
						"NETWORK",
						`Server error (${res.status})`,
						id,
						res.status,
					);
				}
				throw new ProviderError(
					"BAD_RESPONSE",
					`HTTP ${res.status}`,
					id,
					res.status,
				);
			}

			let json: unknown;
			try {
				json = await res.json();
			} catch {
				throw new ProviderError("BAD_RESPONSE", "Malformed JSON response", id);
			}
			const text = extractContent(json);
			if (text === undefined) {
				throw new ProviderError(
					"BAD_RESPONSE",
					"Missing choices[0].message.content",
					id,
				);
			}
			const out: GenerateOutput = { text, model: opts.model };
			const usage = extractUsage(json);
			if (usage) out.usage = usage;
			return out;
		},
	};
	return provider;
}

function extractContent(json: unknown): string | undefined {
	if (!json || typeof json !== "object") return undefined;
	const choices = (json as { choices?: unknown }).choices;
	if (!Array.isArray(choices) || choices.length === 0) return undefined;
	const first = choices[0];
	if (!first || typeof first !== "object") return undefined;
	const msg = (first as { message?: unknown }).message;
	if (!msg || typeof msg !== "object") return undefined;
	const content = (msg as { content?: unknown }).content;
	return typeof content === "string" ? content : undefined;
}

function extractUsage(
	json: unknown,
): { inputTokens?: number; outputTokens?: number } | undefined {
	if (!json || typeof json !== "object") return undefined;
	const usage = (json as { usage?: unknown }).usage;
	if (!usage || typeof usage !== "object") return undefined;
	const u = usage as { prompt_tokens?: unknown; completion_tokens?: unknown };
	const out: { inputTokens?: number; outputTokens?: number } = {};
	if (typeof u.prompt_tokens === "number") out.inputTokens = u.prompt_tokens;
	if (typeof u.completion_tokens === "number")
		out.outputTokens = u.completion_tokens;
	return out.inputTokens === undefined && out.outputTokens === undefined
		? undefined
		: out;
}

function isAbortError(err: unknown): boolean {
	return (
		err instanceof Error &&
		(err.name === "AbortError" ||
			(err as { code?: string }).code === "ABORT_ERR")
	);
}
