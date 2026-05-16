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

/** Recognised provider ids. All implement forced tool calls. */
export type ProviderId =
	| "anthropic"
	| "groq"
	| "openai"
	| "gemini"
	| "uf-navigator";

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
	 * Reasoning effort for models that expose it (gpt-oss-120b/20b via UF
	 * Navigator's LiteLLM proxy passes this through as `reasoning_effort`
	 * in the request body). Adapters that don't recognise it silently
	 * drop it. Default behaviour: omit, which lets the model use its own
	 * default (`medium` for gpt-oss). Audit 2026-05-16 R.4-b.
	 */
	reasoningEffort?: "low" | "medium" | "high";
	/**
	 * Acknowledge that calling LLM APIs from the browser exposes the API
	 * key to scripts on the page. All adapters refuse direct-from-browser
	 * calls unless this is explicitly true.
	 */
	dangerouslyAllowBrowser?: boolean;
}

export class ForcedToolError extends Error {
	readonly code:
		| "AUTH"
		| "RATE_LIMIT"
		| "NETWORK"
		| "BAD_RESPONSE"
		| "NO_TOOL_USE"
		| "ABORTED"
		// AUDIT-017: distinct code for "we refuse to make this call from
		// the browser without explicit consent." Previously mapped to
		// NETWORK, which prompts users to retry (useless — the call will
		// keep being refused). UNSUPPORTED signals "configuration must
		// change, not the network."
		| "UNSUPPORTED";
	readonly provider: ProviderId;
	readonly status?: number;
	/**
	 * AUDIT-K4 (2026-05-11): how long the host should wait before retrying.
	 * Populated for RATE_LIMIT errors when the provider returns a
	 * `Retry-After` header (seconds OR HTTP-date). Lets the UI render a
	 * countdown card instead of dumping a generic 429 message into the
	 * events log.
	 */
	readonly retryAfterMs?: number;
	constructor(
		code: ForcedToolError["code"],
		provider: ProviderId,
		message: string,
		status?: number,
		retryAfterMs?: number,
	) {
		super(message);
		this.name = "ForcedToolError";
		this.code = code;
		this.provider = provider;
		if (status !== undefined) this.status = status;
		if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
	}
}

/**
 * Parse a `Retry-After` header value into milliseconds.
 *
 *   - Numeric form ("30") → 30 seconds.
 *   - HTTP-date form ("Fri, 31 Dec 2026 23:59:59 GMT") → milliseconds
 *     until that timestamp.
 *   - Anything else (missing, malformed) → undefined.
 *
 * Always returns a non-negative number; clamps to a sane upper bound
 * (10 minutes) so a misbehaving provider can't park the UI for hours.
 * AUDIT-K4: shared helper because every forced-tool adapter + the
 * agentic loop's OpenAI-compat fetch needs the same parsing semantics.
 */
export function parseRetryAfter(
	headerValue: string | null,
): number | undefined {
	if (!headerValue) return undefined;
	const trimmed = headerValue.trim();
	if (trimmed === "") return undefined;
	const MAX_MS = 10 * 60 * 1000; // 10 minutes
	// Numeric: seconds.
	if (/^\d+(\.\d+)?$/.test(trimmed)) {
		const secs = Number.parseFloat(trimmed);
		if (!Number.isFinite(secs) || secs < 0) return undefined;
		return Math.min(MAX_MS, Math.round(secs * 1000));
	}
	// HTTP-date.
	const t = Date.parse(trimmed);
	if (Number.isNaN(t)) return undefined;
	const delta = t - Date.now();
	if (delta <= 0) return 0;
	return Math.min(MAX_MS, delta);
}

/** A provider-specific adapter. Returns the parsed tool input as a plain object. */
export type ForcedToolAdapter = (
	input: ForcedToolInput,
) => Promise<Record<string, unknown>>;

/** Thrown by the dispatcher when an unknown provider id is passed. */
export class UnknownProviderError extends Error {
	constructor(provider: string) {
		super(`unknown provider: ${provider}`);
		this.name = "UnknownProviderError";
	}
}
