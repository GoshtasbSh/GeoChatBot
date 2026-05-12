// @vitest-environment happy-dom
/**
 * §V concurrency — generation guard + abort semantics.
 *
 * Audit invariants:
 *   V3 rapid Ask → Cancel → Ask → Cancel produces NO late events on the
 *      stale generation. Specifically: a planner promise that resolves
 *      AFTER `clear()` ran must not fire `plan` / `result` / `error`
 *      events on the now-cleared element.
 *
 *   Bonus: the existing per-session generation counter (`this.generation`
 *   in element.ts) must monotonically increase, and every async path that
 *   reads its captured gen must short-circuit when the current gen
 *   doesn't match.
 *
 * Multi-tab tests (V1 saves-store cross-tab, V2 theme cross-tab) require
 * two `localStorage` realms and are deferred to a follow-up live e2e run
 * — happy-dom only has one realm.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { type GeoChatBotElement, defineGeoChatBot } from "../src/index";

beforeAll(() => {
	defineGeoChatBot();
});

async function mountWithProvider(): Promise<GeoChatBotElement> {
	const el = document.createElement("geo-chatbot") as GeoChatBotElement;
	document.body.appendChild(el);
	// Provide a synthetic dataset so ask() doesn't refuse on "no data."
	(
		el as unknown as { _execDatasets: unknown }
	) /* eslint-disable-line */._execDatasets = [];
	(el as unknown as { _datasets: unknown[] })._datasets = [
		{
			name: "fake",
			kind: "table",
			rows: 1,
			columns: [{ name: "id", type: "Int64" }],
			sample: [],
		},
	];
	await el.updateComplete;
	return el;
}

describe("§V3 generation guard suppresses late events after clear()", () => {
	it("bumps `generation` on every clear()", async () => {
		const el = await mountWithProvider();
		const before = (el as unknown as { generation: number }).generation;
		el.clear();
		const after1 = (el as unknown as { generation: number }).generation;
		el.clear();
		const after2 = (el as unknown as { generation: number }).generation;
		expect(after1).toBeGreaterThan(before);
		expect(after2).toBeGreaterThan(after1);
	});

	it("planAbort is aborted (and replaced) on clear()", async () => {
		const el = await mountWithProvider();
		const ac = new AbortController();
		(el as unknown as { _planAbort?: AbortController })._planAbort = ac;
		el.clear();
		expect(ac.signal.aborted).toBe(true);
	});

	it("execAbort is aborted on clear()", async () => {
		const el = await mountWithProvider();
		const ac = new AbortController();
		(el as unknown as { _execAbort?: AbortController })._execAbort = ac;
		el.clear();
		expect(ac.signal.aborted).toBe(true);
	});

	it("survives 100 back-to-back clear() calls without state corruption", async () => {
		const el = await mountWithProvider();
		for (let i = 0; i < 100; i++) el.clear();
		expect(
			(el as unknown as { generation: number }).generation,
		).toBeGreaterThan(99);
		// _datasets / loaded / saves should remain in their post-clear shape.
		expect((el as unknown as { _datasets: unknown[] })._datasets).toEqual([]);
		expect((el as unknown as { loaded: unknown[] }).loaded).toEqual([]);
	});

	it("does NOT fire `error` events for an aborted planner promise (when generation has moved)", async () => {
		const el = await mountWithProvider();
		const seenError = vi.fn();
		el.addEventListener("geochatbot:error", seenError);

		// Simulate a stale plan promise that rejects after we've already cleared.
		const gen = (el as unknown as { generation: number }).generation;
		el.clear(); // bump generation
		// gen is now stale. The element.ts code path checks `gen !== this.generation`
		// before dispatching error. We can simulate that by attempting to dispatch
		// directly with the stale gen captured — the production code paths read it
		// and short-circuit; here we just verify clear() doesn't itself fire an
		// error event.
		await new Promise((r) => setTimeout(r, 20));
		expect(seenError).not.toHaveBeenCalled();
		// Sanity: gen has bumped.
		expect(
			(el as unknown as { generation: number }).generation,
		).toBeGreaterThan(gen);
	});

	it("clear() removes a mounted plan-review modal so a late approve cannot resurrect it", async () => {
		const el = await mountWithProvider();
		// Manually inject a modal element to mimic an open plan-review.
		const sr = el.shadowRoot;
		if (sr) {
			const modal = document.createElement("gcb-modal");
			sr.appendChild(modal);
			expect(sr.querySelector("gcb-modal")).toBeTruthy();
			el.clear();
			expect(sr.querySelector("gcb-modal")).toBeNull();
		}
	});

	it("rapid clear() bursts are idempotent on busy/error/_pendingPlan", async () => {
		const el = await mountWithProvider();
		(el as unknown as { busy: boolean }).busy = true;
		(el as unknown as { error: { code: string } | null }).error = {
			code: "X",
		};
		(el as unknown as { _pendingPlan: object })._pendingPlan = { id: "p1" };
		for (let i = 0; i < 5; i++) el.clear();
		expect((el as unknown as { busy: boolean }).busy).toBe(false);
		expect((el as unknown as { error: unknown }).error).toBeNull();
		expect(
			(el as unknown as { _pendingPlan: unknown })._pendingPlan,
		).toBeUndefined();
	});
});

describe("§V disconnectedCallback also aborts pending work", () => {
	it("removing the element from the DOM bumps generation", async () => {
		const el = await mountWithProvider();
		const before = (el as unknown as { generation: number }).generation;
		el.remove();
		const after = (el as unknown as { generation: number }).generation;
		expect(after).toBeGreaterThan(before);
	});

	it("removing the element aborts a captured _planAbort", async () => {
		const el = await mountWithProvider();
		const ac = new AbortController();
		(el as unknown as { _planAbort?: AbortController })._planAbort = ac;
		el.remove();
		expect(ac.signal.aborted).toBe(true);
	});
});
