/**
 * UF Navigator Toolkit provider — thin wrapper over `createOpenAICompat`.
 *
 * UF Navigator is a LiteLLM-based gateway hosted by UFIT that fronts a
 * pool of self-hosted Llama models for University of Florida users.
 * Individual API keys are free (capped at $100/mo of local-model spend)
 * and unlock the same OpenAI-compatible /v1/chat/completions surface as
 * Groq, so this provider is a 10-line baseUrl swap.
 *
 *   - UI / key issuance: https://api.ai.it.ufl.edu/ui
 *   - Docs:              https://docs.ai.it.ufl.edu
 *   - Base URL:          https://api.ai.it.ufl.edu/v1
 *
 * Auth: `Authorization: Bearer <apiKey>`.
 *
 * Default model: `llama-3.3-70b-instruct` — the newest 70B Llama exposed
 * to individual keys at time of writing. Smaller (8B / nemotron-nano) is
 * available via the `model` override and runs faster on cheap prompts.
 *
 * Browser safety: same caveat as Groq — running directly from the
 * browser leaks the key to anyone who opens devtools. In production,
 * proxy through your own server. For local evaluation/demo, callers may
 * accept the risk.
 */

import { createOpenAICompat } from "./openai-compat.js";
import type { ChatProvider } from "./types.js";

export interface UFNavigatorOptions {
	apiKey: string;
	model?: string;
	/**
	 * Optional baseUrl override (defaults to the public UFIT gateway).
	 * Useful when UFIT changes hostnames or for tunnelling through a
	 * local proxy during development.
	 */
	baseUrl?: string;
}

export function createUFNavigator(opts: UFNavigatorOptions): ChatProvider {
	return createOpenAICompat({
		baseUrl: opts.baseUrl ?? "https://api.ai.it.ufl.edu/v1",
		apiKey: opts.apiKey,
		model: opts.model ?? "llama-3.3-70b-instruct",
		id: "uf-navigator",
		label: "UF Navigator (Llama)",
		free: true,
	});
}
