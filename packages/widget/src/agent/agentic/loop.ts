/**
 * Multi-turn agent loop driver (ReAct flavour).
 *
 * Flow per question:
 *
 *   ┌─ system + user ─► LLM ─► tool_calls
 *   │                            │
 *   │           ┌────────────────┴──────────────┐
 *   │           ▼                               ▼
 *   │   inspect.* (DuckDB)               finalize_plan ──► return Plan
 *   │           │
 *   │   "tool_result: …" ───┐
 *   └──────── append ◄──────┘  (append observation to message history; loop)
 *
 * Iteration cap: 8 (defensive against infinite tool calling).
 * Token cap: max_tokens per call * iterations.
 *
 * Provider support:
 *   - OpenAI-compat (Groq + OpenAI + Together + OpenRouter via the same
 *     /chat/completions schema) is implemented here directly. Anthropic
 *     and Gemini have different multi-turn shapes and are deferred.
 *   - The LLM-call function is INJECTABLE so tests drive the loop with
 *     a deterministic stub.
 *
 * The loop's output is always either:
 *   - a typed Plan (resolved when `finalize_plan` is called), or
 *   - a thrown error (if the iteration cap is reached or the LLM emits
 *     a tool call we don't recognise N times in a row).
 *
 * The caller is responsible for validating the returned Plan against
 * `validate-plan.ts` and feeding it to the executor — the loop only
 * produces the Plan, it does NOT execute it.
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import type { Plan } from "../types.js";
import { type InspectionRunCtx, runInspection } from "./inspect-runners.js";
import { INSPECT_TOOLS } from "./inspect-tools.js";

/** Public type of the function the loop calls to invoke the LLM. */
export interface LoopLLMRequest {
	apiKey: string;
	model: string;
	endpoint: string;
	/** OpenAI-compat messages array (system + history). */
	messages: ReadonlyArray<LoopChatMessage>;
	/** OpenAI-compat tools array (already JSON-serialised schema). */
	tools: ReadonlyArray<LoopToolDef>;
	/** Optional abort signal forwarded to fetch. */
	signal?: AbortSignal;
	/** Per-call token budget. */
	maxTokens?: number;
	/** Whether to allow direct browser calls. */
	dangerouslyAllowBrowser?: boolean;
}

export type LoopChatMessage =
	| { role: "system"; content: string }
	| { role: "user"; content: string }
	| {
			role: "assistant";
			content: string | null;
			tool_calls?: Array<{
				id: string;
				type: "function";
				function: { name: string; arguments: string };
			}>;
	  }
	| { role: "tool"; tool_call_id: string; content: string };

export interface LoopToolDef {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

export interface LoopLLMResponse {
	/** Free-text reasoning the LLM emitted alongside tool calls. */
	text: string | null;
	/** OpenAI-style tool_calls block. Empty array == "model just talked". */
	tool_calls: Array<{
		id: string;
		name: string;
		/** Already JSON-parsed arguments object. */
		args: Record<string, unknown>;
	}>;
}

export type LoopLLMCall = (req: LoopLLMRequest) => Promise<LoopLLMResponse>;

export interface AgentLoopOptions {
	endpoint: string;
	apiKey: string;
	model: string;
	systemPrompt: string;
	question: string;
	ctx: InspectionRunCtx;
	/** Maximum total iterations (LLM calls). Default 8. */
	maxIterations?: number;
	/** Per-iteration token budget. Default 1024. */
	maxTokensPerCall?: number;
	/** Abort signal forwarded to the LLM call. */
	signal?: AbortSignal;
	/** Required when running in a browser. */
	dangerouslyAllowBrowser?: boolean;
	/** Test/integration override of the LLM transport. */
	llmCall?: LoopLLMCall;
	/** Fired before each LLM call — useful for UI status. */
	onStep?: (
		e:
			| { kind: "reason"; iteration: number; text: string | null }
			| {
					kind: "tool";
					iteration: number;
					toolId: string;
					args: Record<string, unknown>;
					observation: string;
			  }
			| { kind: "finalize"; iteration: number; plan: Plan }
			| { kind: "budget-exhausted"; iteration: number }
			| { kind: "unknown-tool"; iteration: number; toolId: string },
	) => void;
}

/**
 * Run the loop and return a Plan. Throws on iteration-cap exhaustion or
 * unrecoverable LLM errors. Validation against `validate-plan.ts` is the
 * caller's responsibility — the loop only constructs the structure.
 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<Plan> {
	const {
		endpoint,
		apiKey,
		model,
		systemPrompt,
		question,
		ctx,
		// Lowered from 8 → 5 because Groq's free-tier 12k TPM cap is the
		// bottleneck for most users. With a ~3k-token system prompt
		// (preamble + tool catalog + dataset profile + 22 examples), each
		// iteration eats ~1.5–3k tokens; 5 iterations stays under quota
		// while still giving the LLM 4 inspection probes + finalize.
		maxIterations = 5,
		// Lowered from 1024 → 512: tool-arg JSON + a short reasoning span
		// fit easily in 512; 1024 was leftover headroom that mostly
		// translated to padded output tokens against the TPM ceiling.
		maxTokensPerCall = 512,
		signal,
		dangerouslyAllowBrowser,
		llmCall = defaultOpenAICompatCall,
		onStep,
	} = opts;

	const tools = buildToolsBlock();

	const messages: LoopChatMessage[] = [
		{ role: "system", content: systemPrompt },
		{ role: "user", content: question },
	];

	let consecutiveUnknown = 0;
	let consecutiveFreeText = 0;
	for (let iter = 0; iter < maxIterations; iter++) {
		// Abort fast-path. Without this an aborted clear() during an
		// in-flight inspection round only takes effect at the *next* fetch
		// — meaning DuckDB queries that started before the abort still
		// run to completion and burn time. Checking here lets us bail out
		// between iterations as soon as the signal fires.
		if (signal?.aborted) {
			const err = new Error("agent loop aborted");
			err.name = "AbortError";
			throw err;
		}
		const resp = await llmCall({
			apiKey,
			model,
			endpoint,
			messages,
			tools,
			...(signal ? { signal } : {}),
			maxTokens: maxTokensPerCall,
			...(dangerouslyAllowBrowser !== undefined
				? { dangerouslyAllowBrowser }
				: {}),
		});

		if (resp.text) {
			onStep?.({ kind: "reason", iteration: iter, text: resp.text });
		}

		if (resp.tool_calls.length === 0) {
			// The model produced free text and no tool call. Push the message
			// and prod it to commit to a tool — usually finalize_plan.
			messages.push({ role: "assistant", content: resp.text ?? "" });
			messages.push({
				role: "user",
				content:
					"You must call a tool — either an inspect.* tool to gather more info, " +
					"or finalize_plan to commit a final Plan. Do not answer in free text.",
			});
			consecutiveFreeText++;
			// Symmetric to the unknown-tool cap: if a model keeps producing
			// free text despite the prod, fail fast instead of burning the
			// full iteration budget. Smaller models (Groq Llama-3.1-8B) are
			// the usual offenders. Cap matches the unknown-tool cap.
			if (consecutiveFreeText >= 3) {
				throw new Error(
					"agent loop: model produced free text 3 times in a row instead of calling a tool",
				);
			}
			continue;
		}
		consecutiveFreeText = 0;

		// Append the assistant turn (tool_calls) BEFORE we run the tools, so
		// the OpenAI-compat tool_call_id wiring is preserved.
		messages.push({
			role: "assistant",
			content: resp.text ?? null,
			tool_calls: resp.tool_calls.map((tc) => ({
				id: tc.id,
				type: "function",
				function: { name: tc.name, arguments: JSON.stringify(tc.args) },
			})),
		});

		let finalize: Plan | null = null;
		for (const tc of resp.tool_calls) {
			if (tc.name === INSPECT_TOOLS.finalize_plan.id) {
				const parsed = INSPECT_TOOLS.finalize_plan.args.safeParse(tc.args);
				if (!parsed.success) {
					messages.push({
						role: "tool",
						tool_call_id: tc.id,
						content: `error: finalize_plan args failed validation: ${parsed.error.message}. Fix and re-call.`,
					});
					continue;
				}
				finalize = parsed.data as Plan;
				onStep?.({ kind: "finalize", iteration: iter, plan: finalize });
				// We acknowledge the tool call but immediately return after the
				// loop — no need to keep iterating.
				messages.push({
					role: "tool",
					tool_call_id: tc.id,
					content: "plan accepted",
				});
				break;
			}
			// Look for an inspection tool by id. The Set carries `string` values
			// (TS would otherwise narrow to the literal-union of all inspection
			// ids, which makes `.has(tc.name)` reject `tc.name: string`).
			const knownIds: ReadonlySet<string> = new Set<string>(
				Object.values(INSPECT_TOOLS).map((t) => t.id as string),
			);
			if (!knownIds.has(tc.name)) {
				consecutiveUnknown++;
				onStep?.({ kind: "unknown-tool", iteration: iter, toolId: tc.name });
				messages.push({
					role: "tool",
					tool_call_id: tc.id,
					content: `error: unknown tool "${tc.name}". Valid tools: ${[...knownIds].join(", ")}`,
				});
				if (consecutiveUnknown >= 3) {
					throw new Error(
						`agent loop: model called unknown tools 3 times in a row (last: "${tc.name}")`,
					);
				}
				continue;
			}
			consecutiveUnknown = 0;
			const observation = await runInspection(tc.name, tc.args, ctx);
			onStep?.({
				kind: "tool",
				iteration: iter,
				toolId: tc.name,
				args: tc.args,
				observation,
			});
			// Cap each observation in the LLM-visible message history at
			// ~600 chars so a probe_sql returning a wide row dump doesn't
			// eat the entire TPM budget on the next iteration. The full
			// observation still flows through onStep → UI for the user.
			const truncated =
				observation.length > 600
					? `${observation.slice(0, 600)}\n…(observation truncated; see full output in UI trace)`
					: observation;
			messages.push({
				role: "tool",
				tool_call_id: tc.id,
				content: truncated,
			});
		}

		if (finalize) return finalize;
	}
	onStep?.({ kind: "budget-exhausted", iteration: maxIterations });
	throw new Error(
		`agent loop: exhausted ${maxIterations} iterations without finalize_plan`,
	);
}

/* -------------------------------------------------------------------------- */
/* Default LLM transport — OpenAI-compat                                      */
/* -------------------------------------------------------------------------- */

async function defaultOpenAICompatCall(
	req: LoopLLMRequest,
): Promise<LoopLLMResponse> {
	const inBrowser = typeof window !== "undefined";
	if (inBrowser && req.dangerouslyAllowBrowser !== true) {
		throw new Error(
			"Direct-from-browser agent loop calls leak the API key. Pass dangerouslyAllowBrowser:true to acknowledge, or proxy through your own server.",
		);
	}

	const body = {
		model: req.model,
		temperature: 0,
		max_tokens: req.maxTokens ?? 1024,
		messages: req.messages,
		tools: req.tools,
		// "required" forces the model to call SOME registered tool (any of
		// inspect.* OR finalize_plan) but not a specific one — the model
		// still chooses which. Stricter than "auto", which on smaller models
		// (Groq Llama-3.1-8B) is more likely to be ignored, leading to
		// free-text replies that burn iterations without progress. The free-
		// text cap in runAgentLoop catches the residual cases where a
		// provider doesn't honor "required".
		tool_choice: "required",
	};

	const init: RequestInit = {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${req.apiKey}`,
		},
		body: JSON.stringify(body),
	};
	if (req.signal) init.signal = req.signal;

	const res = await fetch(req.endpoint, init);
	if (!res.ok) {
		const txt = await res.text().catch(() => "");
		// Surface 429s with a more actionable hint. Groq's free tier (12k
		// TPM) is the most common 429 source for this widget; a typed
		// "RATE_LIMIT" error code lets the host fold a retry-suggestion
		// into the UI instead of dumping a raw HTTP body on the user.
		if (res.status === 429) {
			const err = new Error(
				`Rate limit hit (HTTP 429). Wait a few seconds and try again, switch to a smaller model in Settings, or use a paid provider. Provider response: ${txt.slice(0, 200)}`,
			);
			(err as { code?: string }).code = "RATE_LIMIT";
			throw err;
		}
		if (res.status === 401 || res.status === 403) {
			const err = new Error(
				`Auth failed (HTTP ${res.status}). Re-enter your API key in Settings.`,
			);
			(err as { code?: string }).code = "AUTH";
			throw err;
		}
		throw new Error(
			`agent loop LLM call failed: HTTP ${res.status} ${txt.slice(0, 240)}`,
		);
	}
	const json = (await res.json()) as {
		choices?: Array<{
			message?: {
				content?: string | null;
				tool_calls?: Array<{
					id?: string;
					function?: { name?: string; arguments?: string };
				}>;
			};
		}>;
	};

	const msg = json.choices?.[0]?.message;
	const text = typeof msg?.content === "string" ? msg.content : null;
	const calls: LoopLLMResponse["tool_calls"] = [];
	for (const tc of msg?.tool_calls ?? []) {
		const id = tc?.id ?? `call_${Math.random().toString(36).slice(2)}`;
		const name = tc?.function?.name;
		const argsStr = tc?.function?.arguments ?? "{}";
		if (typeof name !== "string") continue;
		let args: Record<string, unknown> = {};
		try {
			args = JSON.parse(argsStr);
		} catch {
			args = {};
		}
		calls.push({ id, name, args });
	}
	return { text, tool_calls: calls };
}

/* -------------------------------------------------------------------------- */
/* Tool block builder                                                         */
/* -------------------------------------------------------------------------- */

function buildToolsBlock(): LoopToolDef[] {
	// zod-to-json-schema is the same library the planner uses; emitting
	// openApi3 keeps the output compatible with both OpenAI and Groq.
	const out: LoopToolDef[] = [];
	for (const t of Object.values(INSPECT_TOOLS)) {
		const schema = zodToJsonSchema(t.args, { target: "openApi3" }) as Record<
			string,
			unknown
		>;
		out.push({
			type: "function",
			function: {
				name: t.id,
				description: t.description,
				parameters: schema,
			},
		});
	}
	return out;
}

/** Public test-only export so unit tests can build the same tool block. */
export const _internals = { buildToolsBlock, defaultOpenAICompatCall };
