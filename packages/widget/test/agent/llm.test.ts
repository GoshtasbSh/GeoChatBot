import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callPlannerLLM } from "../../src/agent/llm.js";

const FETCH_OK = (body: Record<string, unknown>) =>
	({
		ok: true,
		json: async () => body,
	}) as Response;

beforeEach(() => {
	vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
	vi.restoreAllMocks();
});

const baseInput = {
	apiKey: "sk-ant-test",
	model: "claude-sonnet-4-6",
	systemPrompt: "sys",
	cachedSystemPrompt: "cached-sys",
	userQuestion: "what?",
	toolName: "submit_plan",
	toolDescription: "submit a plan",
	toolInputSchema: {
		type: "object",
		properties: {},
		additionalProperties: false,
	} as const,
};

describe("callPlannerLLM", () => {
	it("posts to api.anthropic.com with proper headers and tool_choice", async () => {
		vi.mocked(globalThis.fetch).mockResolvedValue(
			FETCH_OK({
				content: [
					{ type: "tool_use", id: "x", name: "submit_plan", input: { ok: 1 } },
				],
				stop_reason: "tool_use",
			}),
		);
		const out = await callPlannerLLM(baseInput);
		expect(out).toEqual({ ok: 1 });
		const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
		expect(url).toBe("https://api.anthropic.com/v1/messages");
		expect(
			(init as RequestInit).headers as Record<string, string>,
		).toMatchObject({
			"x-api-key": "sk-ant-test",
			"anthropic-version": "2023-06-01",
		});
		const body = JSON.parse((init as RequestInit).body as string);
		expect(body.tool_choice).toEqual({ type: "tool", name: "submit_plan" });
		expect(body.tools[0].name).toBe("submit_plan");
		expect(body.system).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "text",
					cache_control: { type: "ephemeral" },
				}),
			]),
		);
	});

	it("throws if no tool_use block present", async () => {
		vi.mocked(globalThis.fetch).mockResolvedValue(
			FETCH_OK({ content: [{ type: "text", text: "hi" }] }),
		);
		await expect(callPlannerLLM(baseInput)).rejects.toThrow(/tool_use/);
	});

	it("throws on AUTH (401)", async () => {
		vi.mocked(globalThis.fetch).mockResolvedValue({
			ok: false,
			status: 401,
			json: async () => ({}),
		} as Response);
		await expect(callPlannerLLM(baseInput)).rejects.toThrow(/auth|401/i);
	});

	it("throws on rate limit (429)", async () => {
		vi.mocked(globalThis.fetch).mockResolvedValue({
			ok: false,
			status: 429,
			json: async () => ({}),
		} as Response);
		await expect(callPlannerLLM(baseInput)).rejects.toThrow(/rate|429/i);
	});

	it("does not log the API key on network failure", async () => {
		vi.mocked(globalThis.fetch).mockRejectedValue(new Error("boom"));
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(callPlannerLLM(baseInput)).rejects.toThrow();
		for (const call of errSpy.mock.calls) {
			const joined = call.map(String).join(" ");
			expect(joined).not.toContain("sk-ant-test");
		}
	});
});
