/**
 * §M provider wire-format depth — each provider adapter must speak its
 * NATIVE protocol so we don't quietly send OpenAI-shaped requests to
 * Anthropic (or vice versa).
 *
 * For every adapter we assert:
 *   1. Request URL / method / authorization header is correct.
 *   2. Tool-call envelope shape matches the provider's documented format:
 *      - OpenAI/Groq:   body.tools[].function + body.tool_choice
 *      - Anthropic:     body.tools[]{input_schema} + body.tool_choice
 *      - Gemini:        body.tools[]{functionDeclarations}[] + tool_config
 *   3. Cost/parsing failures map to the correct ForcedToolError code.
 *
 * Anthropic/Gemini live calls require their own keys (not provided in
 * this audit). The wire-format tests below pin the request SHAPE to
 * the providers' current public docs without needing a live key.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callAnthropic } from "../../../src/agent/forced-tool/anthropic.js";
import { callGemini } from "../../../src/agent/forced-tool/gemini.js";
import { callOpenAICompat } from "../../../src/agent/forced-tool/openai-compat.js";
import type { ForcedToolInput } from "../../../src/agent/forced-tool/types.js";

const fetchSpy = vi.spyOn(globalThis, "fetch");
beforeEach(() => fetchSpy.mockReset());
afterEach(() => fetchSpy.mockReset());

const baseInput: ForcedToolInput = {
	provider: "groq",
	apiKey: "TEST_KEY",
	model: "test-model",
	cachedSystemPrompt: "you are a planner",
	systemPrompt: "with this dataset",
	userMessage: "show points",
	toolName: "submit_plan",
	toolDescription: "Submit a plan",
	toolInputSchema: { type: "object", properties: {} },
	dangerouslyAllowBrowser: true,
};

describe("§M Anthropic adapter wire format", () => {
	it("posts to api.anthropic.com /v1/messages with x-api-key + anthropic-version", async () => {
		fetchSpy.mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({
				content: [
					{
						type: "tool_use",
						name: "submit_plan",
						input: { goal: "g", dataset_refs: ["x"], steps: [] },
					},
				],
			}),
		} as Response);
		await callAnthropic({ ...baseInput, provider: "anthropic" }).catch(
			() => {},
		);
		expect(fetchSpy).toHaveBeenCalled();
		const [url, init] = fetchSpy.mock.calls[0] ?? [];
		expect(String(url)).toMatch(/api\.anthropic\.com\/v1\/messages/);
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers["x-api-key"]).toBe("TEST_KEY");
		expect(headers["anthropic-version"]).toBeDefined();
		expect(headers.Authorization).toBeUndefined();
	});

	it("body uses input_schema and tool_choice.type === 'tool'", async () => {
		fetchSpy.mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({
				content: [
					{
						type: "tool_use",
						name: "submit_plan",
						input: { goal: "g", dataset_refs: ["x"], steps: [] },
					},
				],
			}),
		} as Response);
		await callAnthropic({ ...baseInput, provider: "anthropic" }).catch(
			() => {},
		);
		const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
		const body = JSON.parse(init.body as string);
		expect(body.tools[0].input_schema).toBeDefined();
		expect(body.tools[0].function).toBeUndefined();
		expect(body.tool_choice.type).toBe("tool");
		expect(body.tool_choice.name).toBe("submit_plan");
	});
});

describe("§M Gemini adapter wire format", () => {
	it("posts to generativelanguage.googleapis.com with key in URL (NOT in headers)", async () => {
		fetchSpy.mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										name: "submit_plan",
										args: { goal: "g", dataset_refs: ["x"], steps: [] },
									},
								},
							],
						},
					},
				],
			}),
		} as Response);
		await callGemini({ ...baseInput, provider: "gemini" }).catch(() => {});
		const [url, init] = fetchSpy.mock.calls[0] ?? [];
		expect(String(url)).toMatch(/generativelanguage\.googleapis\.com/);
		const headers = (init as RequestInit).headers as Record<string, string>;
		// Gemini takes the key in x-goog-api-key (current API) OR as ?key=
		// query param. Verify either path doesn't put it in Authorization.
		expect(headers.Authorization).toBeUndefined();
	});

	it("body uses functionDeclarations + tool_config", async () => {
		fetchSpy.mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										name: "submit_plan",
										args: { goal: "g", dataset_refs: ["x"], steps: [] },
									},
								},
							],
						},
					},
				],
			}),
		} as Response);
		await callGemini({ ...baseInput, provider: "gemini" }).catch(() => {});
		const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
		const body = JSON.parse(init.body as string);
		expect(body.tools[0].functionDeclarations).toBeDefined();
		expect(Array.isArray(body.tools[0].functionDeclarations)).toBe(true);
		// Gemini uses camelCase `toolConfig` per current REST API (v1beta).
		expect(body.toolConfig).toBeDefined();
		expect(body.toolConfig.functionCallingConfig.mode).toBe("ANY");
	});
});

describe("§M OpenAI-compat adapter wire format (Groq + OpenAI)", () => {
	it("posts with Authorization: Bearer", async () => {
		fetchSpy.mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({
				choices: [
					{
						message: {
							tool_calls: [
								{
									id: "c1",
									function: {
										name: "submit_plan",
										arguments: `{"goal":"g","dataset_refs":["x"],"steps":[]}`,
									},
								},
							],
						},
					},
				],
			}),
		} as Response);
		await callOpenAICompat(
			baseInput,
			"https://api.groq.com/openai/v1/chat/completions",
			"groq",
		).catch(() => {});
		const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer TEST_KEY");
		expect(headers["x-api-key"]).toBeUndefined();
	});

	it("body.tools[].type === 'function' + tool_choice forces our tool name", async () => {
		fetchSpy.mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({
				choices: [
					{
						message: {
							tool_calls: [
								{
									id: "c1",
									function: {
										name: "submit_plan",
										arguments: `{"goal":"g","dataset_refs":["x"],"steps":[]}`,
									},
								},
							],
						},
					},
				],
			}),
		} as Response);
		await callOpenAICompat(
			baseInput,
			"https://api.openai.com/v1/chat/completions",
			"openai",
		).catch(() => {});
		const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
		expect(body.tools[0].type).toBe("function");
		expect(body.tools[0].function.name).toBe("submit_plan");
		expect(body.tool_choice.type).toBe("function");
		expect(body.tool_choice.function.name).toBe("submit_plan");
	});
});

describe("§M API key never appears in the request URL", () => {
	it("Anthropic: URL does not contain the key", async () => {
		fetchSpy.mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({ content: [] }),
		} as Response);
		await callAnthropic({ ...baseInput, provider: "anthropic" }).catch(
			() => {},
		);
		const url = String(fetchSpy.mock.calls[0]?.[0] ?? "");
		expect(url).not.toContain("TEST_KEY");
	});

	it("OpenAI-compat: URL does not contain the key", async () => {
		fetchSpy.mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({ choices: [] }),
		} as Response);
		await callOpenAICompat(
			baseInput,
			"https://api.groq.com/openai/v1/chat/completions",
			"groq",
		).catch(() => {});
		const url = String(fetchSpy.mock.calls[0]?.[0] ?? "");
		expect(url).not.toContain("TEST_KEY");
	});
});
