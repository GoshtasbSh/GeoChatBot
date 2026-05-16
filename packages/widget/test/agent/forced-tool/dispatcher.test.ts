import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_PROVIDER_ID,
	type ForcedToolInput,
	PROVIDER_CATALOGUE,
	UnknownProviderError,
	callForcedTool,
	defaultModelFor,
	getProviderInfo,
} from "../../../src/agent/forced-tool/index.js";

const fetchMock = vi.fn();

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	vi.stubGlobal("window", undefined);
	fetchMock.mockReset();
});
afterEach(() => {
	vi.unstubAllGlobals();
});

const baseInput = (provider: ForcedToolInput["provider"]): ForcedToolInput => ({
	provider,
	apiKey: "test",
	model: defaultModelFor(provider),
	cachedSystemPrompt: "static",
	systemPrompt: "dynamic",
	userMessage: "do the thing",
	toolName: "submit_plan",
	toolDescription: "submit",
	toolInputSchema: { type: "object", properties: {} },
});

describe("PROVIDER_CATALOGUE", () => {
	it("lists the supported providers in the canonical UI order", () => {
		const ids = PROVIDER_CATALOGUE.map((p) => p.id);
		expect(ids).toEqual([
			"groq",
			"gemini",
			"anthropic",
			"openai",
			"uf-navigator",
		]);
	});

	it("default provider is Groq (free tier)", () => {
		expect(DEFAULT_PROVIDER_ID).toBe("groq");
		expect(getProviderInfo("groq").free).toBe(true);
	});

	it("every provider has at least one model and a signupUrl", () => {
		for (const p of PROVIDER_CATALOGUE) {
			expect(p.models.length).toBeGreaterThan(0);
			expect(p.signupUrl).toMatch(/^https:\/\//);
		}
	});

	it("defaultModelFor returns the first model id for each provider", () => {
		for (const p of PROVIDER_CATALOGUE) {
			expect(defaultModelFor(p.id)).toBe(p.models[0]?.id);
		}
	});
});

describe("callForcedTool dispatcher", () => {
	it("throws UnknownProviderError for an unknown id", async () => {
		await expect(
			callForcedTool({ ...baseInput("groq"), provider: "made-up" as never }),
		).rejects.toBeInstanceOf(UnknownProviderError);
	});

	it("routes Groq to https://api.groq.com/openai/v1/chat/completions", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								tool_calls: [
									{
										type: "function",
										function: {
											name: "submit_plan",
											arguments: '{"goal":"ok"}',
										},
									},
								],
							},
						},
					],
				}),
				{ status: 200 },
			),
		);
		const out = await callForcedTool(baseInput("groq"));
		expect(out).toEqual({ goal: "ok" });
		expect(fetchMock.mock.calls[0]?.[0]).toMatch(
			/api\.groq\.com\/openai\/v1\/chat\/completions/,
		);
		const headers = fetchMock.mock.calls[0]?.[1].headers;
		expect(headers.Authorization).toBe("Bearer test");
	});

	it("routes OpenAI to https://api.openai.com/v1/chat/completions", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								tool_calls: [
									{
										type: "function",
										function: {
											name: "submit_plan",
											arguments: '{"goal":"ok"}',
										},
									},
								],
							},
						},
					],
				}),
				{ status: 200 },
			),
		);
		await callForcedTool(baseInput("openai"));
		expect(fetchMock.mock.calls[0]?.[0]).toMatch(
			/api\.openai\.com\/v1\/chat\/completions/,
		);
	});

	it("routes Anthropic to /v1/messages with x-api-key header", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					content: [
						{ type: "tool_use", name: "submit_plan", input: { goal: "ok" } },
					],
				}),
				{ status: 200 },
			),
		);
		await callForcedTool(baseInput("anthropic"));
		expect(fetchMock.mock.calls[0]?.[0]).toMatch(
			/api\.anthropic\.com\/v1\/messages/,
		);
		const headers = fetchMock.mock.calls[0]?.[1].headers;
		expect(headers["x-api-key"]).toBe("test");
		// No Bearer Authorization header — Anthropic uses its own scheme.
		expect(headers.Authorization).toBeUndefined();
	});

	it("routes Gemini to generativelanguage.googleapis.com with the key in the query string", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					candidates: [
						{
							content: {
								parts: [
									{
										functionCall: { name: "submit_plan", args: { goal: "ok" } },
									},
								],
							},
						},
					],
				}),
				{ status: 200 },
			),
		);
		await callForcedTool(baseInput("gemini"));
		const url = fetchMock.mock.calls[0]?.[0] as string;
		expect(url).toMatch(/generativelanguage\.googleapis\.com\/v1beta\/models/);
		// AUDIT-019: Gemini API key now travels via `x-goog-api-key`
		// header — NOT the URL query — so it doesn't leak into Referer,
		// HAR exports, CDN access logs, or browser history.
		expect(url).not.toMatch(/\?key=/);
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		const headers = init.headers as Record<string, string>;
		expect(headers["x-goog-api-key"]).toBe("test");
	});
});

describe("AbortError propagation across all providers", () => {
	it.each(["anthropic", "groq", "openai", "gemini"] as const)(
		"rethrows AbortError without wrapping for %s",
		async (provider) => {
			const abortErr = Object.assign(new Error("aborted"), {
				name: "AbortError",
			});
			fetchMock.mockRejectedValue(abortErr);
			await expect(callForcedTool(baseInput(provider))).rejects.toMatchObject({
				name: "AbortError",
			});
		},
	);
});

describe("Browser-direct guard fires for every provider", () => {
	it.each(["anthropic", "groq", "openai", "gemini"] as const)(
		"refuses %s calls without dangerouslyAllowBrowser when window is defined",
		async (provider) => {
			vi.stubGlobal("window", { document: {} });
			// AUDIT-017: browser-key-guard refusal is UNSUPPORTED, NOT
			// NETWORK — the UI shouldn't suggest "retry, the network is
			// flaky" when the cause is missing config consent.
			await expect(callForcedTool(baseInput(provider))).rejects.toMatchObject({
				name: "ForcedToolError",
				code: "UNSUPPORTED",
			});
		},
	);
});

describe("AUDIT-018 — 5xx mapped to NETWORK (transient) across all providers", () => {
	it.each(["anthropic", "groq", "openai", "gemini"] as const)(
		"maps 503 to NETWORK for %s (was BAD_RESPONSE before audit pass 3)",
		async (provider) => {
			fetchMock.mockResolvedValue(new Response("", { status: 503 }));
			await expect(callForcedTool(baseInput(provider))).rejects.toMatchObject({
				name: "ForcedToolError",
				code: "NETWORK",
				status: 503,
			});
		},
	);

	it.each(["anthropic", "groq", "openai", "gemini"] as const)(
		"maps 502 to NETWORK for %s",
		async (provider) => {
			fetchMock.mockResolvedValue(new Response("", { status: 502 }));
			await expect(callForcedTool(baseInput(provider))).rejects.toMatchObject({
				name: "ForcedToolError",
				code: "NETWORK",
				status: 502,
			});
		},
	);

	it.each(["anthropic", "groq", "openai", "gemini"] as const)(
		"4xx (e.g. 400) still maps to BAD_RESPONSE for %s",
		async (provider) => {
			fetchMock.mockResolvedValue(new Response("", { status: 400 }));
			await expect(callForcedTool(baseInput(provider))).rejects.toMatchObject({
				name: "ForcedToolError",
				code: "BAD_RESPONSE",
				status: 400,
			});
		},
	);
});

describe("Status code mapping is consistent across providers", () => {
	it.each([
		["anthropic", { content: [] }],
		["groq", { choices: [] }],
		["openai", { choices: [] }],
		["gemini", { candidates: [] }],
	] as const)("maps 401 to AUTH for %s", async (provider, _shape) => {
		fetchMock.mockResolvedValue(new Response("", { status: 401 }));
		await expect(callForcedTool(baseInput(provider))).rejects.toMatchObject({
			name: "ForcedToolError",
			code: "AUTH",
			status: 401,
		});
	});

	it.each(["anthropic", "groq", "openai", "gemini"] as const)(
		"maps 429 to RATE_LIMIT for %s",
		async (provider) => {
			fetchMock.mockResolvedValue(new Response("", { status: 429 }));
			await expect(callForcedTool(baseInput(provider))).rejects.toMatchObject({
				name: "ForcedToolError",
				code: "RATE_LIMIT",
				status: 429,
			});
		},
	);
});

describe("OpenAI-compatible providers handle string-encoded arguments", () => {
	it("parses the JSON-string arguments field for Groq", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								tool_calls: [
									{
										type: "function",
										function: {
											name: "submit_plan",
											arguments: '{"a": 1, "b": [1, 2]}',
										},
									},
								],
							},
						},
					],
				}),
				{ status: 200 },
			),
		);
		const out = await callForcedTool(baseInput("groq"));
		expect(out).toEqual({ a: 1, b: [1, 2] });
	});

	it("returns NO_TOOL_USE when Groq returns malformed arguments JSON", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								tool_calls: [
									{
										type: "function",
										function: {
											name: "submit_plan",
											arguments: "{this is not json",
										},
									},
								],
							},
						},
					],
				}),
				{ status: 200 },
			),
		);
		await expect(callForcedTool(baseInput("groq"))).rejects.toMatchObject({
			code: "NO_TOOL_USE",
		});
	});

	it("returns NO_TOOL_USE when Groq returns no tool_calls", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [
						{ message: { content: "I will not call the tool, sorry." } },
					],
				}),
				{ status: 200 },
			),
		);
		await expect(callForcedTool(baseInput("groq"))).rejects.toMatchObject({
			code: "NO_TOOL_USE",
		});
	});
});

describe("Gemini parses functionCall.args as an object", () => {
	it("returns the args object when functionCall is present", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					candidates: [
						{
							content: {
								parts: [
									{
										functionCall: {
											name: "submit_plan",
											args: { goal: "g", steps: [] },
										},
									},
								],
							},
						},
					],
				}),
				{ status: 200 },
			),
		);
		const out = await callForcedTool(baseInput("gemini"));
		expect(out).toEqual({ goal: "g", steps: [] });
	});

	it("returns NO_TOOL_USE when Gemini returns text-only response", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					candidates: [{ content: { parts: [{ text: "I refuse." }] } }],
				}),
				{ status: 200 },
			),
		);
		await expect(callForcedTool(baseInput("gemini"))).rejects.toMatchObject({
			code: "NO_TOOL_USE",
		});
	});
});
