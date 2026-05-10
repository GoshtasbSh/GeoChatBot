// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import "../../src/ui/plan-review.js";
import "../../src/agent/tools/index.js";
import type { Plan } from "../../src/agent/types.js";
import type { PlanReview } from "../../src/ui/plan-review.js";

const plan: Plan = {
	goal: "demo goal",
	assumptions: ["a1"],
	dataset_refs: ["x"],
	steps: [
		{
			id: "s1",
			tool: "sql",
			args: { query: "SELECT 1" },
			output_var: "r",
			why: "first",
		},
		{ id: "s2", tool: "render.summary", args: { text: "done" }, why: "last" },
	],
};

function mount(plan?: Plan, mode: "plan" | "running" = "plan"): PlanReview {
	const el = document.createElement("plan-review") as PlanReview;
	if (plan) el.plan = plan;
	el.mode = mode;
	document.body.appendChild(el);
	return el;
}

describe("<plan-review>", () => {
	it("renders nothing when plan is undefined", () => {
		const el = mount();
		expect(el.shadowRoot?.textContent ?? "").toBe("");
	});

	it("renders the goal and exactly two step cards", async () => {
		const el = mount(plan);
		await el.updateComplete;
		const root = el.shadowRoot;
		expect(root).toBeTruthy();
		expect(root?.textContent).toContain("demo goal");
		expect(root?.querySelectorAll(".step").length).toBe(2);
	});

	it("emits plan:approve on Run click", async () => {
		const el = mount(plan);
		await el.updateComplete;
		const spy = vi.fn();
		el.addEventListener("plan:approve", spy);
		el.shadowRoot
			?.querySelector("button.run")
			?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("emits plan:reject on Reject click", async () => {
		const el = mount(plan);
		await el.updateComplete;
		const spy = vi.fn();
		el.addEventListener("plan:reject", spy);
		el.shadowRoot
			?.querySelector("button.reject")
			?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("renders status orbs in running mode based on stepStatus map", async () => {
		const el = mount(plan, "running");
		el.stepStatus = new Map([
			["s1", "success"],
			["s2", "running"],
		]);
		await el.updateComplete;
		const orbs = el.shadowRoot?.querySelectorAll(".orb");
		expect(orbs[0]?.classList.contains("success")).toBe(true);
		expect(orbs[1]?.classList.contains("running")).toBe(true);
	});
});

describe("<plan-review> inline edit", () => {
	it("clicking edit reveals input controls", async () => {
		const el = mount(plan);
		await el.updateComplete;
		const editBtn = el.shadowRoot?.querySelectorAll("button.iconbtn")[0] as
			| HTMLButtonElement
			| undefined;
		expect(editBtn).toBeTruthy();
		editBtn?.click();
		await el.updateComplete;
		const inputs = el.shadowRoot?.querySelectorAll("input, select");
		expect(inputs.length).toBeGreaterThan(0);
	});

	it("save with valid args emits step:edit and exits edit mode", async () => {
		const el = mount(plan);
		await el.updateComplete;
		el.shadowRoot
			?.querySelector("button.iconbtn")
			?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		await el.updateComplete;
		const queryInput = el.shadowRoot?.querySelector(
			'input[name="query"]',
		) as HTMLInputElement;
		queryInput.value = "SELECT 2";
		queryInput.dispatchEvent(new Event("input", { bubbles: true }));
		await el.updateComplete;
		const edits: Array<{ args: Record<string, unknown> }> = [];
		el.addEventListener("step:edit", (e: Event) => {
			edits.push((e as CustomEvent<{ args: Record<string, unknown> }>).detail);
		});
		el.shadowRoot
			?.querySelector("button.save")
			?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(edits.length).toBe(1);
		expect(edits[0].args.query).toBe("SELECT 2");
	});

	it("save is disabled while args fail tool zod parse", async () => {
		const el = mount(plan);
		await el.updateComplete;
		// After M16 the per-step actions row contains a single 'edit'
		// iconbtn — the redundant non-interactive 'why?' button was removed.
		// Each step contributes exactly one iconbtn, so index N targets the
		// edit button of step N. Step 1 (s2 / render.summary) is the second.
		const editBtns = el.shadowRoot?.querySelectorAll("button.iconbtn");
		expect(editBtns.length).toBe(2);
		(editBtns[1] as HTMLButtonElement).click();
		await el.updateComplete;
		const textInput = el.shadowRoot?.querySelector(
			'input[name="text"]',
		) as HTMLInputElement;
		textInput.value = "";
		textInput.dispatchEvent(new Event("input", { bubbles: true }));
		await el.updateComplete;
		const save = el.shadowRoot?.querySelector(
			"button.save",
		) as HTMLButtonElement;
		expect(save.disabled).toBe(true);
	});
});
