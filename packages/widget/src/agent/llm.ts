/**
 * Planner-side forced-tool dispatcher.
 *
 * Thin wrapper that adapts the planner's existing `PlannerLLMInput`
 * shape to the provider-agnostic `callForcedTool` registry. Each
 * provider's API quirks (Anthropic's tool_use vs OpenAI's function
 * calls vs Gemini's functionDeclarations) are encapsulated in
 * `agent/forced-tool/<provider>.ts`.
 *
 * Default provider is `'anthropic'` for backwards compatibility — the
 * settings UI defaults to Groq, but tests + code that constructed
 * PlannerLLMInput before multi-provider support continue to work.
 */

import {
	ForcedToolError,
	type ProviderId,
	callForcedTool,
} from "./forced-tool/index.js";

export interface PlannerLLMInput {
	/** Provider id; defaults to 'anthropic' if omitted. */
	provider?: ProviderId;
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

/**
 * Legacy error class — preserved so existing tests / callers that
 * `instanceof PlannerLLMError` keep working. New code can catch
 * {@link ForcedToolError} directly via `agent/forced-tool/index.js`.
 */
export class PlannerLLMError extends Error {
	readonly code:
		| "AUTH"
		| "RATE_LIMIT"
		| "NETWORK"
		| "BAD_RESPONSE"
		| "NO_TOOL_USE"
		| "ABORTED"
		// AUDIT-017: bubble UNSUPPORTED so the UI distinguishes a
		// browser-key-guard refusal from a transient network failure.
		| "UNSUPPORTED";
	readonly status?: number;
	constructor(code: PlannerLLMError["code"], message: string, status?: number) {
		super(message);
		this.name = "PlannerLLMError";
		this.code = code;
		if (status !== undefined) this.status = status;
	}
}

export async function callPlannerLLM(
	input: PlannerLLMInput,
): Promise<Record<string, unknown>> {
	const provider = input.provider ?? "anthropic";
	try {
		return await callForcedTool({
			provider,
			apiKey: input.apiKey,
			model: input.model,
			cachedSystemPrompt: input.cachedSystemPrompt,
			systemPrompt: input.systemPrompt,
			userMessage: input.userQuestion,
			toolName: input.toolName,
			toolDescription: input.toolDescription,
			toolInputSchema: input.toolInputSchema,
			...(input.temperature !== undefined
				? { temperature: input.temperature }
				: {}),
			...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
			...(input.signal !== undefined ? { signal: input.signal } : {}),
			...(input.dangerouslyAllowBrowser !== undefined
				? { dangerouslyAllowBrowser: input.dangerouslyAllowBrowser }
				: {}),
		});
	} catch (err) {
		// Cancellations propagate as native AbortError so the host can
		// distinguish user-initiated abort from a real network failure.
		if (err instanceof Error && err.name === "AbortError") throw err;
		if (err instanceof ForcedToolError) {
			const code = err.code === "ABORTED" ? "ABORTED" : err.code;
			throw new PlannerLLMError(code, err.message, err.status);
		}
		throw err;
	}
}
