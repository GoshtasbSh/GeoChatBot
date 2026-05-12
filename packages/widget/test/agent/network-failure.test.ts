// @vitest-environment happy-dom
/**
 * §T network failure modes — every fetch error path in the LLM call
 * surface must produce a typed ForcedToolError (not a raw exception).
 *
 * Audit invariants:
 *   T1 offline / DNS fail              → NETWORK
 *   T2 slow + abort                    → AbortError propagates as itself
 *   T3 truncated body (not JSON)       → BAD_RESPONSE
 *   T4 CORS / generic fetch throw      → NETWORK
 *   T5 missing tool_calls in response  → NO_TOOL_USE
 *   T6 5xx upstream                    → NETWORK (not BAD_RESPONSE)
 *   T7 400 client error                → BAD_RESPONSE
 *   T8 401/403 auth                    → AUTH
 *   T9 429 rate limit                  → RATE_LIMIT (+ Retry-After when present)
 *
 * The test surface uses `callOpenAICompat` directly so we cover the Groq
 * + OpenAI path with one suite. The Anthropic and Gemini adapters are
 * symmetric and have their own tests in dispatcher.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callOpenAICompat } from "../../src/agent/forced-tool/openai-compat.js";
import type { ForcedToolError } from "../../src/agent/forced-tool/types.js";

const fetchSpy = vi.spyOn(globalThis, "fetch");

beforeEach(() => fetchSpy.mockReset());
afterEach(() => fetchSpy.mockReset());

const baseInput = {
	provider: "groq" as const,
	apiKey: "test",
	model: "m",
	cachedSystemPrompt: "sys",
	systemPrompt: "",
	userMessage: "q",
	toolName: "submit_plan",
	toolDescription: "d",
	toolInputSchema: {},
	dangerouslyAllowBrowser: true,
};

function call(): Promise<unknown> {
	return callOpenAICompat(
		baseInput,
		"https://api.groq.com/openai/v1/chat/completions",
		"groq",
	);
}

describe("§T network failure modes — openai-compat adapter", () => {
	it("T1 offline / DNS fail → NETWORK", async () => {
		fetchSpy.mockRejectedValueOnce(new TypeError("Failed to fetch"));
		await expect(call()).rejects.toMatchObject({
			name: "ForcedToolError",
			code: "NETWORK",
		});
	});

	it("T2 abort during fetch propagates as AbortError (not ForcedToolError)", async () => {
		fetchSpy.mockImplementationOnce(() => {
			const err = new Error("aborted");
			err.name = "AbortError";
			return Promise.reject(err);
		});
		await expect(call()).rejects.toMatchObject({ name: "AbortError" });
	});

	it("T3 truncated / non-JSON body → BAD_RESPONSE", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => {
				throw new SyntaxError("Unexpected EOF");
			},
		} as Response);
		await expect(call()).rejects.toMatchObject({ code: "BAD_RESPONSE" });
	});

	it("T4 generic fetch throw (CORS) → NETWORK", async () => {
		fetchSpy.mockRejectedValueOnce(new TypeError("NetworkError"));
		await expect(call()).rejects.toMatchObject({ code: "NETWORK" });
	});

	it("T5 missing tool_calls → NO_TOOL_USE", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({ choices: [{ message: { content: "hi" } }] }),
		} as Response);
		await expect(call()).rejects.toMatchObject({ code: "NO_TOOL_USE" });
	});

	it("T6 5xx upstream → NETWORK (transient, retry-suggestive)", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: false,
			status: 503,
			headers: new Headers(),
			json: async () => ({}),
		} as Response);
		await expect(call()).rejects.toMatchObject({
			code: "NETWORK",
			status: 503,
		});
	});

	it("T7 400 client error → BAD_RESPONSE", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: false,
			status: 400,
			headers: new Headers(),
			json: async () => ({}),
		} as Response);
		await expect(call()).rejects.toMatchObject({
			code: "BAD_RESPONSE",
			status: 400,
		});
	});

	it("T8 401 auth fail → AUTH", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: false,
			status: 401,
			headers: new Headers(),
			json: async () => ({}),
		} as Response);
		await expect(call()).rejects.toMatchObject({ code: "AUTH" });
	});

	it("T8b 403 forbidden → AUTH", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: false,
			status: 403,
			headers: new Headers(),
			json: async () => ({}),
		} as Response);
		await expect(call()).rejects.toMatchObject({ code: "AUTH" });
	});

	it("T9 429 with numeric Retry-After surfaces retryAfterMs", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: false,
			status: 429,
			headers: new Headers({ "Retry-After": "30" }),
			json: async () => ({}),
		} as Response);
		try {
			await call();
			expect.fail("should have thrown");
		} catch (e) {
			const err = e as ForcedToolError;
			expect(err.code).toBe("RATE_LIMIT");
			expect(err.retryAfterMs).toBe(30000);
		}
	});

	it("T9b 429 with HTTP-date Retry-After surfaces retryAfterMs", async () => {
		const future = new Date(Date.now() + 5000).toUTCString();
		fetchSpy.mockResolvedValueOnce({
			ok: false,
			status: 429,
			headers: new Headers({ "Retry-After": future }),
			json: async () => ({}),
		} as Response);
		try {
			await call();
			expect.fail("should have thrown");
		} catch (e) {
			const err = e as ForcedToolError;
			expect(err.code).toBe("RATE_LIMIT");
			expect(err.retryAfterMs).toBeGreaterThan(3000);
			expect(err.retryAfterMs).toBeLessThanOrEqual(5500);
		}
	});

	it("T9c 429 without Retry-After still throws RATE_LIMIT (no retryAfterMs)", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: false,
			status: 429,
			headers: new Headers(),
			json: async () => ({}),
		} as Response);
		try {
			await call();
			expect.fail("should have thrown");
		} catch (e) {
			const err = e as ForcedToolError;
			expect(err.code).toBe("RATE_LIMIT");
			expect(err.retryAfterMs).toBeUndefined();
		}
	});

	it("T-unsupported: in-browser without dangerouslyAllowBrowser → UNSUPPORTED", async () => {
		// In happy-dom `window` exists; ensure the guard fires when consent is omitted.
		await expect(
			callOpenAICompat(
				{ ...baseInput, dangerouslyAllowBrowser: false },
				"https://api.groq.com/openai/v1/chat/completions",
				"groq",
			),
		).rejects.toMatchObject({ code: "UNSUPPORTED" });
	});
});
