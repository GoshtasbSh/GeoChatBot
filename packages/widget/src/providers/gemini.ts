/**
 * Google Gemini provider — Generative Language API via `fetch`.
 *
 * Free tier: YES. Google's AI Studio offers a generous free tier on
 * `gemini-2.5-flash` and similar models. Sign up at
 * https://aistudio.google.com to get a key.
 *
 * Auth: API key passed in the `x-goog-api-key` request header. The
 * Generative Language API also accepts the legacy `?key=` query
 * parameter, but headers keep the key out of browser DevTools URL
 * displays, HAR exports, server access logs, and Referer leakage on
 * any redirect.
 *
 * Browser safety: hosted endpoint — running directly from the browser
 * exposes the key over the wire. Use a server proxy in production.
 */

import {
	type ChatMessage,
	type ChatProvider,
	type GenerateInput,
	type GenerateOutput,
	ProviderError,
} from "./types.js";

export interface GeminiOptions {
	apiKey: string;
	model?: string;
}

const ID = "gemini";

export function createGemini(opts: GeminiOptions): ChatProvider {
	const model = opts.model ?? "gemini-2.5-flash";
	return {
		id: ID,
		label: "Google Gemini (free tier)",
		free: true,
		async generate(input: GenerateInput): Promise<GenerateOutput> {
			const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
				model,
			)}:generateContent`;

			const { systemText, contents } = mapMessages(input.messages);
			const generationConfig: Record<string, unknown> = {};
			if (input.temperature !== undefined)
				generationConfig.temperature = input.temperature;
			if (input.maxTokens !== undefined)
				generationConfig.maxOutputTokens = input.maxTokens;

			const body: Record<string, unknown> = { contents };
			if (systemText) {
				body.systemInstruction = {
					role: "system",
					parts: [{ text: systemText }],
				};
			}
			if (Object.keys(generationConfig).length > 0) {
				body.generationConfig = generationConfig;
			}

			let res: Response;
			try {
				const init: RequestInit = {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-goog-api-key": opts.apiKey,
					},
					body: JSON.stringify(body),
				};
				if (input.signal) init.signal = input.signal;
				res = await fetch(url, init);
			} catch (err) {
				if (err instanceof Error && err.name === "AbortError") {
					throw new ProviderError("ABORTED", "Request aborted", ID);
				}
				// Do NOT include err.message — some browsers echo the full URL
				// (which contains the API key) in fetch failure messages.
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
					"Missing candidates[0].content.parts[0].text",
					ID,
				);
			}
			return { text, model };
		},
	};
}

function mapMessages(messages: ChatMessage[]): {
	systemText: string | undefined;
	contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>;
} {
	const sys: string[] = [];
	const contents: Array<{
		role: "user" | "model";
		parts: Array<{ text: string }>;
	}> = [];
	for (const m of messages) {
		if (m.role === "system") {
			sys.push(m.content);
			continue;
		}
		const role: "user" | "model" = m.role === "assistant" ? "model" : "user";
		contents.push({ role, parts: [{ text: m.content }] });
	}
	return { systemText: sys.length ? sys.join("\n\n") : undefined, contents };
}

function extractText(json: unknown): string | undefined {
	if (!json || typeof json !== "object") return undefined;
	const cands = (json as { candidates?: unknown }).candidates;
	if (!Array.isArray(cands) || cands.length === 0) return undefined;
	const first = cands[0];
	if (!first || typeof first !== "object") return undefined;
	const content = (first as { content?: unknown }).content;
	if (!content || typeof content !== "object") return undefined;
	const parts = (content as { parts?: unknown }).parts;
	if (!Array.isArray(parts) || parts.length === 0) return undefined;
	const p0 = parts[0];
	if (!p0 || typeof p0 !== "object") return undefined;
	const t = (p0 as { text?: unknown }).text;
	return typeof t === "string" ? t : undefined;
}
