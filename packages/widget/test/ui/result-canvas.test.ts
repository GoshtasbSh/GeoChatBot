// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import "../../src/ui/result-canvas.js";
import type { ResultPayload } from "../../src/agent/executor/types.js";

interface Turn {
	id: string;
	question: string;
	results: ResultPayload[];
}

interface CanvasEl extends HTMLElement {
	updateComplete: Promise<unknown>;
	setResult(p: ResultPayload | unknown): void;
	beginTurn(q: string): void;
	setOrigin(o: { planId: string; stepId: string; question: string }): void;
	correctLastSummary(text: string): void;
	clear(): void;
	_turns: Turn[];
}

function mount(): CanvasEl {
	const el = document.createElement("result-canvas") as unknown as CanvasEl;
	document.body.appendChild(el);
	return el;
}

describe("<result-canvas>", () => {
	it("starts empty (no turns rendered)", async () => {
		const el = mount();
		await el.updateComplete;
		expect(el._turns.length).toBe(0);
		// Empty state shown
		expect(el.shadowRoot?.querySelector(".empty")).toBeTruthy();
	});

	it("appends results to a single turn (auto-creates turn for legacy callers)", async () => {
		const el = mount();
		el.setResult({ kind: "summary", text: "hello" });
		el.setResult({ kind: "table", rows: [{ a: 1 }], columns: ["a"] });
		await el.updateComplete;
		expect(el._turns.length).toBe(1);
		expect(el._turns[0]?.results.length).toBe(2);
		const r0 = el._turns[0]?.results[0];
		const r1 = el._turns[0]?.results[1];
		expect(r0).toBeDefined();
		expect(r1).toBeDefined();
		expect(r0).toMatchObject({
			kind: "summary",
			text: "hello",
		});
		expect(r1).toMatchObject({ kind: "table" });
	});

	it("beginTurn creates a new user turn with question", async () => {
		const el = mount();
		el.beginTurn("How many rows?");
		el.setResult({ kind: "summary", text: "5 rows" });
		await el.updateComplete;
		expect(el._turns.length).toBe(1);
		expect(el._turns[0]?.question).toBe("How many rows?");
		const first = el._turns[0]?.results[0];
		expect(first).toBeDefined();
		expect(first).toMatchObject({ kind: "summary" });
	});

	it("clear() drops all turns", async () => {
		const el = mount();
		el.setResult({ kind: "summary", text: "hi" });
		el.clear();
		await el.updateComplete;
		expect(el._turns.length).toBe(0);
	});

	it("does not crash on a malformed chart payload missing spec.data", async () => {
		const el = mount();
		el.setResult({ kind: "chart", spec: { kind: "bar" } });
		await expect(el.updateComplete).resolves.toBeDefined();
		const chartRes = el._turns[0]?.results[0];
		expect(chartRes).toBeDefined();
		expect(chartRes).toMatchObject({ kind: "chart" });
		expect(el.shadowRoot).toBeTruthy();
	});

	it("does not crash on a malformed layer payload missing geojson.features", async () => {
		const el = mount();
		el.setResult({ kind: "layer", geojson: { type: "FeatureCollection" } });
		await expect(el.updateComplete).resolves.toBeDefined();
		const layerRes = el._turns[0]?.results[0];
		expect(layerRes).toBeDefined();
		expect(layerRes).toMatchObject({ kind: "layer" });
		expect(el.shadowRoot).toBeTruthy();
	});

	// AUDIT-016: render.summary's hero/body split used a greedy regex
	// `[°a-zA-Z%]*` that ate trailing English words. "5 buffered features"
	// rendered as hero="5 buffered" / rest="features". The tightened
	// regex pins the unit suffix to a known set and requires a word
	// boundary so plain English stays in the body.
	it("AUDIT-016: summary hero regex does not eat trailing English words", async () => {
		const el = mount();
		el.setResult({ kind: "summary", text: "5 buffered features" });
		await el.updateComplete;
		const card = el.shadowRoot?.querySelector(".card");
		expect(card).toBeTruthy();
		const text = card?.textContent ?? "";
		// "buffered" must appear in the body, not the hero number.
		expect(text).toContain("buffered features");
		// No hero should contain the word "buffered".
		const hero = el.shadowRoot?.querySelector(".hero-num, .summary-hero");
		if (hero) expect(hero.textContent ?? "").not.toContain("buffered");
	});

	it("AUDIT-016: summary hero still extracts numbers with valid unit suffixes", async () => {
		const el = mount();
		el.setResult({ kind: "summary", text: "1,234.5 km between sites" });
		await el.updateComplete;
		const card = el.shadowRoot?.querySelector(".card");
		expect(card).toBeTruthy();
		const text = card?.textContent ?? "";
		expect(text).toContain("between sites");
	});

	it("correctLastSummary replaces the most recent summary text in place", async () => {
		const el = mount();
		el.setResult({
			kind: "table",
			rows: [{ level: "Middle", r: 7.4 }],
			columns: ["level", "r"],
		});
		el.setResult({ kind: "summary", text: "Elementary is the highest." });
		await el.updateComplete;
		el.correctLastSummary("Middle is the highest at 7.4.");
		await el.updateComplete;
		// still exactly one summary card (replaced, not appended)
		const summaries =
			el._turns[0]?.results.filter((r) => r.kind === "summary") ?? [];
		expect(summaries.length).toBe(1);
		expect((summaries[0] as { text: string }).text).toBe(
			"Middle is the highest at 7.4.",
		);
		// table card untouched
		expect(el._turns[0]?.results.filter((r) => r.kind === "table").length).toBe(
			1,
		);
	});

	it("correctLastSummary is a no-op when there is no summary", async () => {
		const el = mount();
		el.setResult({ kind: "table", rows: [{ a: 1 }], columns: ["a"] });
		await el.updateComplete;
		expect(() => el.correctLastSummary("x")).not.toThrow();
		expect(
			el._turns[0]?.results.filter((r) => r.kind === "summary").length,
		).toBe(0);
	});
});
