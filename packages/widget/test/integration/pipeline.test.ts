// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { GeoChatBotElement } from "../../src/index.js";
import "../../src/element.js";
import "../../src/agent/tools/index.js";

const validPlan = {
	goal: "demo",
	assumptions: [],
	dataset_refs: ["sales"],
	steps: [
		{ id: "s1", tool: "render.summary", args: { text: "hi" }, why: "final" },
	],
};

async function mountWithStubPlanner(planResp: unknown = validPlan) {
	const el = document.createElement("geo-chatbot") as GeoChatBotElement;
	document.body.appendChild(el);
	el.__setLlmCall = vi.fn().mockResolvedValue(planResp);
	el.__setLlmCall(vi.fn().mockResolvedValue(planResp));
	// Provider with a fake api key so planner can build
	el.setProvider({
		name: "anthropic",
		apiKey: "k",
		generate: async () => ({ text: "" }),
	});
	el.pushData({
		name: "sales",
		kind: "table",
		rows: 10,
		columns: [],
		sample: [],
	});
	return el;
}

describe("full pipeline (mocked LLM)", () => {
	it("emits plan event after ask()", async () => {
		const el = document.createElement("geo-chatbot") as GeoChatBotElement;
		document.body.appendChild(el);
		const llm = vi.fn().mockResolvedValue(validPlan);
		el.__setLlmCall(llm);
		el.setProvider({
			name: "anthropic",
			apiKey: "k",
			generate: async () => ({ text: "" }),
		});
		el.pushData({
			name: "sales",
			kind: "table",
			rows: 10,
			columns: [],
			sample: [],
		});
		const seen = vi.fn();
		el.addEventListener("plan", seen);
		await el.ask("any question");
		expect(seen).toHaveBeenCalledTimes(1);
		expect(seen.mock.calls[0][0].detail.plan.goal).toBe("demo");
	});

	it("does NOT auto-execute; waits for approvePlan()", async () => {
		const el = document.createElement("geo-chatbot") as GeoChatBotElement;
		document.body.appendChild(el);
		el.__setLlmCall(vi.fn().mockResolvedValue(validPlan));
		el.setProvider({
			name: "anthropic",
			apiKey: "k",
			generate: async () => ({ text: "" }),
		});
		el.pushData({
			name: "sales",
			kind: "table",
			rows: 10,
			columns: [],
			sample: [],
		});
		const progress = vi.fn();
		el.addEventListener("progress", progress);
		await el.ask("q");
		expect(progress).not.toHaveBeenCalled();
		el.approvePlan();
		await new Promise((r) => setTimeout(r, 0));
		expect(progress).toHaveBeenCalled();
	});

	it("emits result event for the final render.summary", async () => {
		const el = document.createElement("geo-chatbot") as GeoChatBotElement;
		document.body.appendChild(el);
		el.__setLlmCall(vi.fn().mockResolvedValue(validPlan));
		el.setProvider({
			name: "anthropic",
			apiKey: "k",
			generate: async () => ({ text: "" }),
		});
		el.pushData({
			name: "sales",
			kind: "table",
			rows: 10,
			columns: [],
			sample: [],
		});
		const result = vi.fn();
		el.addEventListener("result", result);
		await el.ask("q");
		el.approvePlan();
		await new Promise((r) => setTimeout(r, 10));
		expect(
			result.mock.calls.some(
				(c: unknown[]) =>
					(c[0] as CustomEvent<{ kind: string }>).detail.kind === "summary",
			),
		).toBe(true);
	});

	it("rejects a plan with bad SQL at validate-sql layer", async () => {
		const badPlan = {
			...validPlan,
			steps: [
				{
					id: "s1",
					tool: "sql",
					args: { query: "DROP TABLE sales" },
					output_var: "r",
					why: "bad",
				},
				{ id: "s2", tool: "render.summary", args: { text: "x" }, why: "final" },
			],
		};
		const el = document.createElement("geo-chatbot") as GeoChatBotElement;
		document.body.appendChild(el);
		el.__setLlmCall(vi.fn().mockResolvedValue(badPlan));
		el.setProvider({
			name: "anthropic",
			apiKey: "k",
			generate: async () => ({ text: "" }),
		});
		el.pushData({
			name: "sales",
			kind: "table",
			rows: 10,
			columns: [],
			sample: [],
		});
		const errEv = vi.fn();
		el.addEventListener("error", errEv);
		await el.ask("q");
		el.approvePlan();
		await new Promise((r) => setTimeout(r, 0));
		expect(errEv).toHaveBeenCalled();
	});

	it("every event includes planId", async () => {
		const el = document.createElement("geo-chatbot") as GeoChatBotElement;
		document.body.appendChild(el);
		el.__setLlmCall(vi.fn().mockResolvedValue(validPlan));
		el.setProvider({
			name: "anthropic",
			apiKey: "k",
			generate: async () => ({ text: "" }),
		});
		el.pushData({
			name: "sales",
			kind: "table",
			rows: 10,
			columns: [],
			sample: [],
		});
		const events: Array<
			["plan" | "progress" | "result", Record<string, unknown>]
		> = [];
		el.addEventListener("plan", (e: Event) =>
			events.push(["plan", (e as CustomEvent<Record<string, unknown>>).detail]),
		);
		el.addEventListener("progress", (e: Event) =>
			events.push([
				"progress",
				(e as CustomEvent<Record<string, unknown>>).detail,
			]),
		);
		el.addEventListener("result", (e: Event) =>
			events.push([
				"result",
				(e as CustomEvent<Record<string, unknown>>).detail,
			]),
		);
		await el.ask("q");
		el.approvePlan();
		await new Promise((r) => setTimeout(r, 10));
		for (const [name, detail] of events) {
			expect(detail.planId, `${name} missing planId`).toBeTruthy();
		}
	});
});
