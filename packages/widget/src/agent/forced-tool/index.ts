/**
 * Forced-tool dispatcher.
 *
 * Both the Planner and the Critic call `callForcedTool(input)` with a
 * `provider` field. We look up the right per-provider adapter and
 * forward the call. Adapters surface the same `ForcedToolError` shape
 * regardless of provider, so caller code stays vendor-agnostic.
 */

import { callAnthropic } from "./anthropic.js";
import { callGemini } from "./gemini.js";
import { callGroq } from "./groq.js";
import { callOpenAI } from "./openai.js";
import {
	type ForcedToolAdapter,
	type ForcedToolInput,
	type ProviderId,
	UnknownProviderError,
} from "./types.js";
import { callUFNavigator } from "./uf-navigator.js";

const ADAPTERS: Record<ProviderId, ForcedToolAdapter> = {
	anthropic: callAnthropic,
	groq: callGroq,
	openai: callOpenAI,
	gemini: callGemini,
	"uf-navigator": callUFNavigator,
};

/**
 * Catalogue exposed to the UI for the provider/model dropdowns. Order
 * matters — the first entry is the default (Groq, free).
 */
export interface ProviderInfo {
	id: ProviderId;
	label: string;
	/** Where to obtain a key. */
	signupUrl: string;
	/** Free tier on the API itself? */
	free: boolean;
	/** Recommended models, in display order. The first is the default. */
	models: ReadonlyArray<{ id: string; label: string }>;
}

export const PROVIDER_CATALOGUE: ReadonlyArray<ProviderInfo> = [
	{
		id: "groq",
		label: "Groq (free tier)",
		signupUrl: "https://console.groq.com/keys",
		free: true,
		models: [
			{ id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (recommended)" },
			{ id: "mixtral-8x7b-32768", label: "Mixtral 8x7B (long context)" },
			{
				id: "llama-3.1-8b-instant",
				label: "Llama 3.1 8B (fast, weaker tool-calling)",
			},
		],
	},
	{
		id: "gemini",
		label: "Google Gemini (free tier)",
		signupUrl: "https://aistudio.google.com/app/apikey",
		free: true,
		models: [
			{ id: "gemini-2.0-flash", label: "Gemini 2.0 Flash (recommended)" },
			{ id: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
			{ id: "gemini-1.5-flash", label: "Gemini 1.5 Flash" },
		],
	},
	{
		id: "anthropic",
		label: "Anthropic",
		signupUrl: "https://console.anthropic.com/settings/keys",
		free: false,
		models: [
			{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (recommended)" },
			{ id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (cheaper)" },
			{ id: "claude-opus-4-7", label: "Claude Opus 4.7 (heaviest)" },
		],
	},
	{
		id: "openai",
		label: "OpenAI",
		signupUrl: "https://platform.openai.com/api-keys",
		free: false,
		models: [
			{ id: "gpt-4o-mini", label: "GPT-4o mini (recommended)" },
			{ id: "gpt-4o", label: "GPT-4o" },
			{ id: "gpt-4-turbo", label: "GPT-4 Turbo" },
		],
	},
	{
		id: "uf-navigator",
		label: "UF Navigator (Llama)",
		signupUrl: "https://api.ai.it.ufl.edu/ui",
		free: true,
		models: [
			// gpt-oss reasoning models go first: in 2026-05-15 audit they
			// outperformed Llama at tool-arg coverage on the same prompts.
			// vLLM emits a `reasoning_content` field alongside `tool_calls`;
			// our adapter ignores it and only reads tool_calls, so the
			// integration is drop-in.
			{
				id: "gpt-oss-120b",
				label: "gpt-oss 120B reasoning (recommended)",
			},
			{
				id: "gpt-oss-20b",
				label: "gpt-oss 20B reasoning (fast)",
			},
			{
				id: "llama-3.3-70b-instruct",
				label: "Llama 3.3 70B",
			},
			{
				id: "llama-3.1-70b-instruct",
				label: "Llama 3.1 70B",
			},
		],
	},
];

export function getProviderInfo(id: ProviderId): ProviderInfo {
	const found = PROVIDER_CATALOGUE.find((p) => p.id === id);
	if (!found) throw new UnknownProviderError(id);
	return found;
}

/** Default provider id (Groq, free). */
export const DEFAULT_PROVIDER_ID: ProviderId = "groq";

/** Default model for a given provider — the first entry in its catalogue. */
export function defaultModelFor(id: ProviderId): string {
	const first = getProviderInfo(id).models[0];
	if (!first?.id) {
		throw new Error(`no default model for provider ${id}`);
	}
	return first.id;
}

/**
 * Dispatch a forced-tool call to the right provider adapter. All adapters
 * share the {@link ForcedToolError} taxonomy so caller code stays
 * vendor-agnostic.
 */
export async function callForcedTool(
	input: ForcedToolInput,
): Promise<Record<string, unknown>> {
	const adapter = ADAPTERS[input.provider];
	if (!adapter) throw new UnknownProviderError(input.provider);
	return adapter(input);
}

export type {
	ForcedToolAdapter,
	ForcedToolInput,
	ProviderId,
} from "./types.js";
export { ForcedToolError, UnknownProviderError } from "./types.js";
