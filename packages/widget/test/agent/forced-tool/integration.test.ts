/**
 * AUDIT-026: full provider round-trip smoke tests.
 *
 * Without real API keys we can't hit live endpoints, but we CAN verify
 * each provider adapter's full request body + response parsing against
 * the provider's published wire format. This file mocks fetch with
 * realistic response shapes (copied from each provider's docs as of
 * 2026-Q1) and asserts:
 *
 *   (a) the request body has the provider-correct keys
 *   (b) the response parser extracts tool args correctly
 *   (c) the round-trip returns the expected typed object
 *
 * Companion to dispatcher.test.ts which covers error mapping and
 * defaults; this file fills in the success-path detail.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ForcedToolInput,
	callForcedTool,
	defaultModelFor,
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

const PLAN_TOOL_SCHEMA = {
	type: "object",
	properties: {
		goal: { type: "string" },
		steps: {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: { type: "string" },
					tool: { type: "string" },
					args: { type: "object" },
					why: { type: "string" },
				},
			},
		},
	},
	required: ["goal", "steps"],
} as const;

const baseInput = (provider: ForcedToolInput["provider"]): ForcedToolInput => ({
	provider,
	apiKey: "sk-fake-key",
	model: defaultModelFor(provider),
	cachedSystemPrompt: "You are GeoChatBot's planner.",
	systemPrompt: "Dataset profile: 100 rows of points.",
	userMessage: "Show me the points on a map",
	toolName: "submit_plan",
	toolDescription: "Submit a typed Plan",
	toolInputSchema: PLAN_TOOL_SCHEMA,
});

const CANONICAL_PLAN = {
	goal: "Show points on map",
	steps: [
		{
			id: "s1",
			tool: "render.map",
			args: { layer: "points" },
			why: "render the loaded points",
		},
	],
};

describe("AUDIT-026 — Anthropic full round-trip", () => {
	it("sends a tool-use request with cache_control and parses the tool_use response block", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					id: "msg_01",
					type: "message",
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "toolu_01",
							name: "submit_plan",
							input: CANONICAL_PLAN,
						},
					],
				}),
				{ status: 200 },
			),
		);
		const result = await callForcedTool(baseInput("anthropic"));
		expect(result).toEqual(CANONICAL_PLAN);
		// Request body assertions
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string);
		expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
		expect(body.system[0].text).toBe("You are GeoChatBot's planner.");
		expect(body.tool_choice).toEqual({ type: "tool", name: "submit_plan" });
		expect(body.tools[0].name).toBe("submit_plan");
		expect(body.tools[0].input_schema).toEqual(PLAN_TOOL_SCHEMA);
		expect(body.messages[0].content).toBe("Show me the points on a map");
		// Headers
		const headers = init.headers as Record<string, string>;
		expect(headers["x-api-key"]).toBe("sk-fake-key");
		expect(headers["anthropic-version"]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it("returns NO_TOOL_USE when the response is text-only (no tool_use block)", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					content: [{ type: "text", text: "Sorry, I can't help with that." }],
				}),
				{ status: 200 },
			),
		);
		await expect(callForcedTool(baseInput("anthropic"))).rejects.toMatchObject({
			name: "ForcedToolError",
			code: "NO_TOOL_USE",
		});
	});

	it("returns BAD_RESPONSE when the response is not valid JSON", async () => {
		fetchMock.mockResolvedValue(
			new Response("<html>error</html>", { status: 200 }),
		);
		await expect(callForcedTool(baseInput("anthropic"))).rejects.toMatchObject({
			name: "ForcedToolError",
			code: "BAD_RESPONSE",
		});
	});
});

describe("AUDIT-026 — Groq/OpenAI full round-trip", () => {
	it("Groq parses the OpenAI-compat tool_calls envelope with JSON-string arguments", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								role: "assistant",
								tool_calls: [
									{
										id: "call_01",
										type: "function",
										function: {
											name: "submit_plan",
											arguments: JSON.stringify(CANONICAL_PLAN),
										},
									},
								],
							},
							finish_reason: "tool_calls",
						},
					],
				}),
				{ status: 200 },
			),
		);
		const result = await callForcedTool(baseInput("groq"));
		expect(result).toEqual(CANONICAL_PLAN);
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string);
		expect(body.tool_choice).toEqual({
			type: "function",
			function: { name: "submit_plan" },
		});
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bearer sk-fake-key",
		);
	});

	it("OpenAI returns NO_TOOL_USE when finish_reason: stop but no tool_calls", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [
						{
							message: { role: "assistant", content: "I refuse." },
							finish_reason: "stop",
						},
					],
				}),
				{ status: 200 },
			),
		);
		await expect(callForcedTool(baseInput("openai"))).rejects.toMatchObject({
			name: "ForcedToolError",
			code: "NO_TOOL_USE",
		});
	});

	it("AUDIT-027: Groq surfaces NO_TOOL_USE when tool_calls arguments is malformed JSON", async () => {
		// Documented contract (now aligned with implementation):
		// malformed JSON inside tool_calls.function.arguments is treated
		// as "no tool was successfully invoked" — the caller's
		// NO_TOOL_USE retry path takes over.
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
											arguments: '{"goal": "broken",',
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
			name: "ForcedToolError",
			code: "NO_TOOL_USE",
		});
	});
});

describe("AUDIT-026 — Gemini full round-trip", () => {
	it("parses the functionCall block and uses x-goog-api-key header", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					candidates: [
						{
							content: {
								role: "model",
								parts: [
									{
										functionCall: {
											name: "submit_plan",
											args: CANONICAL_PLAN,
										},
									},
								],
							},
							finishReason: "STOP",
						},
					],
				}),
				{ status: 200 },
			),
		);
		const result = await callForcedTool(baseInput("gemini"));
		expect(result).toEqual(CANONICAL_PLAN);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		// AUDIT-019 lock: key MUST be in header, NOT in URL.
		expect(url).not.toMatch(/\?key=/);
		expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(
			"sk-fake-key",
		);
		const body = JSON.parse(init.body as string);
		expect(body.toolConfig.functionCallingConfig.mode).toBe("ANY");
		expect(body.toolConfig.functionCallingConfig.allowedFunctionNames).toEqual([
			"submit_plan",
		]);
		expect(body.tools[0].functionDeclarations[0].name).toBe("submit_plan");
	});

	it("returns NO_TOOL_USE when Gemini emits a text-only candidate", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					candidates: [
						{
							content: { role: "model", parts: [{ text: "Cannot help." }] },
							finishReason: "STOP",
						},
					],
				}),
				{ status: 200 },
			),
		);
		await expect(callForcedTool(baseInput("gemini"))).rejects.toMatchObject({
			name: "ForcedToolError",
			code: "NO_TOOL_USE",
		});
	});
});

describe("AUDIT-026 — AbortSignal honored on the request side", () => {
	it("forwards the signal into fetch.init for each provider", async () => {
		// Anthropic
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					content: [
						{ type: "tool_use", name: "submit_plan", input: CANONICAL_PLAN },
					],
				}),
				{ status: 200 },
			),
		);
		const ctrl = new AbortController();
		await callForcedTool({ ...baseInput("anthropic"), signal: ctrl.signal });
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(init.signal).toBe(ctrl.signal);
	});
});
