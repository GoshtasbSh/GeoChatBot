/**
 * Provider barrel — public surface for the widget's LLM abstraction.
 *
 * Hosts pick a provider, instantiate it with their credentials, and
 * register it with `setProvider`. The element layer reads from
 * `getProvider()` at request time.
 */

export type {
	ChatMessage,
	ChatProvider,
	GenerateInput,
	GenerateOutput,
	ProviderErrorCode,
} from "./types.js";
export { ProviderError } from "./types.js";

export { setProvider, getProvider, clearProvider } from "./registry.js";

export { createEcho } from "./echo.js";
export { createOpenAICompat } from "./openai-compat.js";
export type { OpenAICompatOptions } from "./openai-compat.js";
export { createGroq } from "./groq.js";
export type { GroqOptions } from "./groq.js";
export { createAnthropic } from "./anthropic.js";
export type { AnthropicOptions } from "./anthropic.js";
export { createGemini } from "./gemini.js";
export type { GeminiOptions } from "./gemini.js";
