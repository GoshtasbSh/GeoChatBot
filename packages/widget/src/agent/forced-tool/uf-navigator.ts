/**
 * UF Navigator Toolkit forced-tool adapter.
 *
 * UF Navigator is a LiteLLM proxy hosted by UFIT that exposes
 * OpenAI-compatible /chat/completions for self-hosted Llama models, so
 * tool-calling works identically to Groq/OpenAI. This module is a thin
 * URL wrapper. See `providers/uf-navigator.ts` for the chat-only
 * provider and `widget/src/agent/forced-tool/openai-compat.ts` for the
 * shared protocol logic.
 *
 * Recommended models (issued to individual UF keys) for tool-calling:
 *   - llama-3.3-70b-instruct   (default — best plan-shape adherence)
 *   - llama-3.1-70b-instruct   (fallback)
 * Smaller models (8B, nemotron-nano) tend to drop the forced tool call
 * silently; the adapter surfaces this as NO_TOOL_USE.
 */

import { callOpenAICompat } from "./openai-compat.js";
import type { ForcedToolInput } from "./types.js";

const ENDPOINT = "https://api.ai.it.ufl.edu/v1/chat/completions";

export async function callUFNavigator(
	input: ForcedToolInput,
): Promise<Record<string, unknown>> {
	return callOpenAICompat(input, ENDPOINT, "uf-navigator");
}
