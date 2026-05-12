/**
 * K4 regression: rate-limit recovery in the agentic loop.
 *
 * Scenario (real, from a Groq free-tier session):
 *   - User on Groq llama-3.3-70b-versatile, 300-row CSV.
 *   - First two agentic questions succeed.
 *   - Third question lands a 429 mid-iteration with
 *     `Retry-After: 30` from Groq's reverse proxy.
 *   - Pre-fix: the run dead-ended with a raw 429 message at the
 *     events log foot. No retry, no countdown.
 *
 * Post-fix contract this test pins down:
 *   1. Retry-After header is parsed into milliseconds and exposed on
 *      the thrown error (via the `retryAfterMs` field).
 *   2. The agentic loop auto-retries on 429 up to
 *      `maxRateLimitRetries` (default 2).
 *   3. Each retry waits at least `Retry-After` (capped at 60s) and
 *      emits a `rate-limit-wait` event so the UI can show a
 *      countdown card.
 *   4. The retry budget is finite — if 429s persist past the cap,
 *      the loop propagates the error so the UI can surface it.
 *   5. Abort during a rate-limit wait halts the loop cleanly.
 */

import { tableFromJSON } from "apache-arrow";
import { describe, expect, it } from "vitest";
import {
	type LoopLLMCall,
	runAgentLoop,
} from "../../../src/agent/agentic/loop.js";
import type {
	DatasetEntry,
	ExecutorEngine,
} from "../../../src/agent/executor/types.js";
import {
	ForcedToolError,
	parseRetryAfter,
} from "../../../src/agent/forced-tool/types.js";

const stubEngine = (): ExecutorEngine => ({
	hasSpatial: true,
	async query() {
		return tableFromJSON([{ ok: 1 }]);
	},
});

const stubDatasets = (): Map<string, DatasetEntry> =>
	new Map([["survey", { name: "survey", tableName: "survey" }]]);

const ok = () =>
	({
		text: null,
		tool_calls: [
			{
				id: "c1",
				name: "finalize_plan",
				args: {
					goal: "g",
					assumptions: [],
					dataset_refs: ["survey"],
					steps: [
						{
							id: "s1",
							tool: "render.summary",
							args: { text: "done" },
							why: "show",
						},
					],
				},
			},
		],
	}) as Awaited<ReturnType<LoopLLMCall>>;

describe("K4: parseRetryAfter helper", () => {
	it("parses numeric seconds", () => {
		expect(parseRetryAfter("30")).toBe(30000);
		expect(parseRetryAfter("0")).toBe(0);
		expect(parseRetryAfter("1.5")).toBe(1500);
	});
	it("parses HTTP-date form", () => {
		const future = new Date(Date.now() + 5000).toUTCString();
		const ms = parseRetryAfter(future) ?? -1;
		// Allow a small drift window for clock jitter.
		expect(ms).toBeGreaterThan(3000);
		expect(ms).toBeLessThanOrEqual(5000);
	});
	it("returns undefined for missing/malformed values", () => {
		expect(parseRetryAfter(null)).toBeUndefined();
		expect(parseRetryAfter("")).toBeUndefined();
		expect(parseRetryAfter("  ")).toBeUndefined();
		expect(parseRetryAfter("not a date")).toBeUndefined();
	});
	it("clamps to 10 minutes", () => {
		expect(parseRetryAfter("99999")).toBe(10 * 60 * 1000);
	});
	it("returns 0 for past HTTP-dates", () => {
		const past = new Date(Date.now() - 60_000).toUTCString();
		expect(parseRetryAfter(past)).toBe(0);
	});
});

describe("K4: agent loop auto-retries on 429", () => {
	it("emits rate-limit-wait and retries the same iteration", async () => {
		const sleeps: number[] = [];
		const waitEvents: Array<{ attempt: number; waitMs: number }> = [];
		let llmCalls = 0;
		const llmCall: LoopLLMCall = async () => {
			llmCalls++;
			if (llmCalls === 1) {
				const err = new Error("rate limited (429)") as Error & {
					code?: string;
					retryAfterMs?: number;
				};
				err.code = "RATE_LIMIT";
				err.retryAfterMs = 2000;
				throw err;
			}
			return ok();
		};
		const plan = await runAgentLoop({
			endpoint: "http://stub/chat/completions",
			apiKey: "k",
			model: "m",
			systemPrompt: "sys",
			question: "show data",
			ctx: { engine: stubEngine(), datasets: stubDatasets() },
			llmCall,
			sleepImpl: async (ms) => {
				sleeps.push(ms);
			},
			onStep: (e) => {
				if (e.kind === "rate-limit-wait") {
					waitEvents.push({ attempt: e.attempt, waitMs: e.waitMs });
				}
			},
		});
		expect(plan.steps[0]?.tool).toBe("render.summary");
		expect(llmCalls).toBe(2);
		expect(waitEvents).toHaveLength(1);
		expect(waitEvents[0]?.attempt).toBe(1);
		// Backoff floor (2^1 * 1000 = 2000ms) coincides with Retry-After here.
		expect(waitEvents[0]?.waitMs).toBeGreaterThanOrEqual(2000);
		expect(sleeps[0]).toBeGreaterThanOrEqual(2000);
	});

	it("propagates RATE_LIMIT when retries exhaust", async () => {
		let llmCalls = 0;
		const llmCall: LoopLLMCall = async () => {
			llmCalls++;
			const err = new Error("rate limited (429)") as Error & {
				code?: string;
				retryAfterMs?: number;
			};
			err.code = "RATE_LIMIT";
			err.retryAfterMs = 1000;
			throw err;
		};
		await expect(
			runAgentLoop({
				endpoint: "http://stub/chat/completions",
				apiKey: "k",
				model: "m",
				systemPrompt: "sys",
				question: "show",
				ctx: { engine: stubEngine(), datasets: stubDatasets() },
				llmCall,
				maxRateLimitRetries: 1,
				sleepImpl: async () => {},
			}),
		).rejects.toThrow(/rate limit/i);
		// 1 retry → 2 total calls.
		expect(llmCalls).toBe(2);
	});

	it("aborts cleanly during a rate-limit wait", async () => {
		const ac = new AbortController();
		const llmCall: LoopLLMCall = async () => {
			const err = new Error("rate limited (429)") as Error & {
				code?: string;
				retryAfterMs?: number;
			};
			err.code = "RATE_LIMIT";
			err.retryAfterMs = 10_000;
			throw err;
		};
		const p = runAgentLoop({
			endpoint: "http://stub/chat/completions",
			apiKey: "k",
			model: "m",
			systemPrompt: "sys",
			question: "show",
			ctx: { engine: stubEngine(), datasets: stubDatasets() },
			llmCall,
			signal: ac.signal,
			sleepImpl: (_ms, signal) =>
				new Promise((_, reject) => {
					if (signal?.aborted) {
						const err = new Error("aborted");
						err.name = "AbortError";
						reject(err);
						return;
					}
					signal?.addEventListener(
						"abort",
						() => {
							const err = new Error("aborted");
							err.name = "AbortError";
							reject(err);
						},
						{ once: true },
					);
				}),
		});
		// Defer the abort to a microtask so the loop has time to register
		// its abort listener inside sleepImpl before we fire.
		await Promise.resolve();
		ac.abort();
		await expect(p).rejects.toThrow(/abort/i);
	});
});

describe("§N: agentic loop recovers from provider tool_use_failed (HTTP 400)", () => {
	it("pushes a corrective user message and continues instead of throwing", async () => {
		let llmCalls = 0;
		const messagesSeen: string[][] = [];
		const llmCall: LoopLLMCall = async (req) => {
			llmCalls++;
			messagesSeen.push(
				req.messages.map(
					(m) =>
						`${m.role}:${typeof m.content === "string" ? m.content.slice(0, 60) : "?"}`,
				),
			);
			if (llmCalls === 1) {
				const err = new Error(
					`provider tool_use_failed: HTTP 400 {"error":{"message":"tool call validation failed: attempted to call tool 'render.map' which was not in request.tools","type":"invalid_request_error","code":"tool_use_failed"}}`,
				) as Error & { code?: string; rawBody?: string };
				err.code = "TOOL_USE_FAILED";
				err.rawBody = `{"error":{"message":"tool call validation failed: attempted to call tool 'render.map' which was not in request.tools"}}`;
				throw err;
			}
			return ok();
		};
		const plan = await runAgentLoop({
			endpoint: "http://stub/chat/completions",
			apiKey: "k",
			model: "m",
			systemPrompt: "sys",
			question: "show on map",
			ctx: { engine: stubEngine(), datasets: stubDatasets() },
			llmCall,
			sleepImpl: async () => {},
		});
		expect(plan.steps[0]?.tool).toBe("render.summary");
		expect(llmCalls).toBe(2);
		// Iteration 2 saw a corrective user message that names the failed tool.
		const lastTurn = messagesSeen[messagesSeen.length - 1] ?? [];
		const found = lastTurn.some((m) => m.includes("render.map"));
		expect(found).toBe(true);
	});

	it("counts tool_use_failed toward the consecutive-unknown cap", async () => {
		let llmCalls = 0;
		const llmCall: LoopLLMCall = async () => {
			llmCalls++;
			const err = new Error("provider tool_use_failed") as Error & {
				code?: string;
				rawBody?: string;
			};
			err.code = "TOOL_USE_FAILED";
			err.rawBody = `tool 'render.map' which was not in request.tools`;
			throw err;
		};
		await expect(
			runAgentLoop({
				endpoint: "http://stub/chat/completions",
				apiKey: "k",
				model: "m",
				systemPrompt: "sys",
				question: "show",
				ctx: { engine: stubEngine(), datasets: stubDatasets() },
				llmCall,
				sleepImpl: async () => {},
			}),
		).rejects.toThrow(/unknown tools 3 times/);
		expect(llmCalls).toBeGreaterThanOrEqual(3);
	});
});

describe("K4: ForcedToolError carries retryAfterMs", () => {
	it("preserves retryAfterMs through the constructor", () => {
		const e = new ForcedToolError(
			"RATE_LIMIT",
			"groq",
			"rate limited",
			429,
			17_500,
		);
		expect(e.code).toBe("RATE_LIMIT");
		expect(e.retryAfterMs).toBe(17_500);
		expect(e.status).toBe(429);
	});
});
