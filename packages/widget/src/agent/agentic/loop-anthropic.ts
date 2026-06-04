/**
 * Anthropic adapter for the agentic inspection loop.
 *
 * The loop uses OpenAI-compatible message / tool-call shapes internally.
 * This adapter converts them to Anthropic's native Messages API format
 * (content blocks, tool_use / tool_result) and maps the response back.
 *
 * Drop-in replacement for the default `callLLM` in `runAgentLoop`:
 *
 *   const plan = await runAgentLoop({
 *     ...opts,
 *     llmCall: makeAnthropicLoopCall(apiKey, "claude-sonnet-4-6"),
 *   });
 */

import type {
	LoopChatMessage,
	LoopLLMCall,
	LoopLLMRequest,
	LoopLLMResponse,
	LoopToolDef,
} from "./loop.js";

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// ── Format converters ─────────────────────────────────────────────────────────

type AnthropicContent =
	| { type: "text"; text: string }
	| {
			type: "tool_use";
			id: string;
			name: string;
			input: Record<string, unknown>;
	  }
	| { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicMessage {
	role: "user" | "assistant";
	content: string | AnthropicContent[];
}

/**
 * Convert OpenAI-compat LoopChatMessage[] → Anthropic messages[].
 * System messages are separated out (Anthropic puts them in a top-level
 * `system` field, not in the messages array).
 */
function toAnthropicMessages(messages: ReadonlyArray<LoopChatMessage>): {
	system: string;
	messages: AnthropicMessage[];
} {
	const systemParts: string[] = [];
	const out: AnthropicMessage[] = [];

	for (const m of messages) {
		if (m.role === "system") {
			systemParts.push(m.content);
			continue;
		}

		if (m.role === "user") {
			out.push({ role: "user", content: m.content });
			continue;
		}

		if (m.role === "tool") {
			// OpenAI tool result → Anthropic tool_result (must go into a user turn)
			const last = out[out.length - 1];
			const block: AnthropicContent = {
				type: "tool_result",
				tool_use_id: m.tool_call_id,
				content: m.content,
			};
			if (last?.role === "user" && Array.isArray(last.content)) {
				(last.content as AnthropicContent[]).push(block);
			} else {
				out.push({ role: "user", content: [block] });
			}
			continue;
		}

		if (m.role === "assistant") {
			const content: AnthropicContent[] = [];
			if (m.content) content.push({ type: "text", text: m.content });
			for (const tc of m.tool_calls ?? []) {
				let args: Record<string, unknown> = {};
				try {
					args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
				} catch {
					// leave empty
				}
				content.push({
					type: "tool_use",
					id: tc.id,
					name: tc.function.name,
					input: args,
				});
			}
			const first = content[0];
			out.push({
				role: "assistant",
				content:
					content.length === 1 && first?.type === "text"
						? (first as { type: "text"; text: string }).text
						: content,
			});
		}
	}

	return { system: systemParts.join("\n\n"), messages: out };
}

/** Convert OpenAI-compat tool defs → Anthropic tools array. */
function toAnthropicTools(tools: ReadonlyArray<LoopToolDef>): Array<{
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
}> {
	return tools.map((t) => ({
		name: t.function.name,
		description: t.function.description,
		input_schema: t.function.parameters,
	}));
}

/** Convert Anthropic response content → LoopLLMResponse. */
function fromAnthropicResponse(content: AnthropicContent[]): LoopLLMResponse {
	const tool_calls: LoopLLMResponse["tool_calls"] = [];
	let text: string | null = null;

	for (const block of content) {
		if (block.type === "text") {
			text = (text ?? "") + block.text;
		} else if (block.type === "tool_use") {
			tool_calls.push({
				id: block.id,
				name: block.name,
				args: block.input ?? {},
			});
		}
	}

	return { text, tool_calls };
}

// ── Main adapter factory ──────────────────────────────────────────────────────

/**
 * Create a LoopLLMCall that talks to Anthropic's Messages API.
 * The returned function is a drop-in replacement for the default
 * OpenAI-compat call in runAgentLoop.
 */
export function makeAnthropicLoopCall(): LoopLLMCall {
	return async (req: LoopLLMRequest): Promise<LoopLLMResponse> => {
		const { system, messages } = toAnthropicMessages(req.messages);
		const tools = toAnthropicTools(req.tools);

		const body: Record<string, unknown> = {
			model: req.model,
			max_tokens: req.maxTokens ?? 1024,
			system: system || undefined,
			messages,
			tools,
			// "any" = must call at least one tool (equivalent to OpenAI's "required")
			tool_choice: { type: "any" },
		};

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"x-api-key": req.apiKey,
			"anthropic-version": ANTHROPIC_VERSION,
		};
		if (typeof window !== "undefined") {
			headers["anthropic-dangerous-direct-browser-access"] = "true";
		}

		const init: RequestInit = {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		};
		if (req.signal) init.signal = req.signal;

		const res = await fetch(ANTHROPIC_ENDPOINT, init);

		if (!res.ok) {
			const txt = await res.text().catch(() => "");
			throw new Error(
				`Anthropic loop call HTTP ${res.status}: ${txt.slice(0, 300)}`,
			);
		}

		const json = (await res.json()) as {
			content: AnthropicContent[];
			stop_reason?: string;
		};

		return fromAnthropicResponse(json.content ?? []);
	};
}
