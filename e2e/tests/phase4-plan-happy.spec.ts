import { expect, test } from "@playwright/test";

/**
 * Phase 4 — happy path.
 *
 * Drives the demo page (which already mounts <geo-chatbot id="bot">). We use
 * the test-only `__setLlmCall` hook to inject a deterministic Plan, push a
 * stub planner DatasetProfile, call ask(), and assert that:
 *
 *   • the unprefixed `plan` CustomEvent fires with a Plan whose goal matches
 *     the stub
 *   • <plan-review> mounts inside the widget's shadow root and shows the goal
 *   • clicking `button.run` triggers approval, which fires `progress` events
 *     and a final `result` event
 *
 * Phase 4 emits unprefixed events (`plan`, `progress`, `result`, `error`)
 * via the element's internal `_emit`; the typed `dataset-loaded` event uses
 * the prefixed `geochatbot:` form. The specs reflect that asymmetry.
 */
test("Phase 4 — plan happy path", async ({ page }) => {
	await page.goto("/");
	await page.waitForSelector("geo-chatbot");

	// Install a window-level event collector and seed the planner stub.
	await page.evaluate(async () => {
		const el = document.querySelector("geo-chatbot") as HTMLElement & {
			setProvider: (p: {
				name: string;
				apiKey: string;
				model?: string;
			}) => void;
			pushData: (d: Record<string, unknown>) => Promise<void>;
			ask: (q: string) => Promise<void>;
			__setLlmCall: (
				fn: (input: unknown) => Promise<Record<string, unknown>>,
			) => void;
		};
		type Trace = Array<{ kind: string; detail: unknown }>;
		const w = window as unknown as { __p4Trace: Trace };
		w.__p4Trace = [];
		const push = (kind: string) => (e: Event) =>
			w.__p4Trace.push({ kind, detail: (e as CustomEvent).detail });
		for (const k of ["plan", "progress", "result", "error"] as const) {
			el.addEventListener(k, push(k));
		}

		el.setProvider({
			name: "anthropic",
			apiKey: "sk-ant-test",
			model: "claude-sonnet-4-6",
		});
		el.__setLlmCall(async () => ({
			goal: "Test goal",
			assumptions: [],
			dataset_refs: ["sales"],
			steps: [
				{
					id: "s1",
					tool: "render.summary",
					args: { text: "ok" },
					why: "final",
				},
			],
		}));
		await el.pushData({
			name: "sales",
			kind: "table",
			rows: 1,
			columns: [],
			sample: [],
		});
		await el.ask("how many points?");
	});

	// Wait for the `plan` event to land.
	await expect
		.poll(
			async () =>
				await page.evaluate(() =>
					(
						(window as unknown as { __p4Trace: Array<{ kind: string }> })
							.__p4Trace ?? []
					).some((e) => e.kind === "plan"),
				),
			{ timeout: 5_000, intervals: [50, 100, 250] },
		)
		.toBe(true);

	// <plan-review> mounts inside the widget shadow root and renders the goal.
	await expect
		.poll(
			async () =>
				await page.evaluate(() => {
					const el = document.querySelector("geo-chatbot");
					const pr = el?.shadowRoot?.querySelector("plan-review");
					return pr?.shadowRoot?.querySelector(".title")?.textContent ?? null;
				}),
			{ timeout: 5_000, intervals: [50, 100, 250] },
		)
		.toBe("Test goal");

	// Click Approve & run via shadow-piercing locator.
	await page
		.locator("geo-chatbot")
		.locator("plan-review")
		.locator("button.run")
		.click();

	// Approval triggers progress + result.
	await expect
		.poll(
			async () =>
				await page.evaluate(() => {
					const trace =
						(window as unknown as { __p4Trace: Array<{ kind: string }> })
							.__p4Trace ?? [];
					return {
						progress: trace.some((e) => e.kind === "progress"),
						result: trace.some((e) => e.kind === "result"),
						error: trace.some((e) => e.kind === "error"),
					};
				}),
			{ timeout: 5_000, intervals: [50, 100, 250] },
		)
		.toEqual({ progress: true, result: true, error: false });
});
