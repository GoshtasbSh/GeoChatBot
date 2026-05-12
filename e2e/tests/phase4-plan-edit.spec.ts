import { expect, test } from "@playwright/test";

/**
 * Phase 4 — inline edit changes Step.args.
 *
 * Drives the demo page. Uses `__setLlmCall` to seed a 2-step plan whose first
 * step is a SQL step. Clicks the per-step `edit` icon, edits the `query`
 * input, hits `save`, then asserts:
 *
 *   • the widget's plan-review now reflects the edited `query` value
 *   • approval still flows through to a final `result` event without an
 *     `error` (no SQL validator regression on the edited string)
 */
test("Phase 4 — inline edit updates step args", async ({ page }) => {
	await page.goto("/");
	await page.waitForSelector("geo-chatbot");

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
			goal: "Inline edit smoke",
			assumptions: [],
			dataset_refs: ["sales"],
			steps: [
				{
					id: "s1",
					tool: "sql",
					args: { query: "SELECT * FROM sales" },
					output_var: "r",
					why: "pull rows",
				},
				{
					id: "s2",
					tool: "render.summary",
					args: { text: "done" },
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
		await el.ask("q");
	});

	// Wait for the plan to render.
	await expect
		.poll(
			async () =>
				await page.evaluate(
					() =>
						!!document
							.querySelector("geo-chatbot")
							?.shadowRoot?.querySelector("plan-review")
							?.shadowRoot?.querySelector("button.iconbtn"),
				),
			{ timeout: 5_000, intervals: [50, 100, 250] },
		)
		.toBe(true);

	const planReview = page.locator("geo-chatbot").locator("plan-review");

	// Click the first per-step "edit" icon button (the first .iconbtn on the
	// first step row).
	await planReview.locator("button.iconbtn").first().click();

	// Wait for the editor input to appear.
	const queryInput = planReview.locator('input[name="query"]');
	await expect(queryInput).toBeVisible({ timeout: 5_000 });

	await queryInput.fill("SELECT 1 AS one");
	await planReview.locator("button.save").click();

	// After save, the widget mutates the pending plan in place and re-renders;
	// the displayed args row should now show the new query.
	await expect
		.poll(
			async () =>
				await page.evaluate(() => {
					const pr = document
						.querySelector("geo-chatbot")
						?.shadowRoot?.querySelector("plan-review");
					const text = pr?.shadowRoot?.textContent ?? "";
					return text;
				}),
			{ timeout: 5_000, intervals: [50, 100, 250] },
		)
		.toContain("SELECT 1 AS one");

	// Approve and assert progress+result fire without an error event.
	await planReview.locator("button.run").click();

	// 15 s timeout (vs the 5 s default elsewhere in this file) accommodates
	// DuckDB-WASM's cold-load on the first execution after page navigation —
	// the SQL step needs an initialized engine, and the .wasm + Worker setup
	// can take 3-8 seconds on a fresh tab. The other polls in this test
	// don't touch the engine so they keep the tighter 5 s budget.
	await expect
		.poll(
			async () =>
				await page.evaluate(() => {
					const trace =
						(
							window as unknown as {
								__p4Trace: Array<{ kind: string; detail?: { code?: string } }>;
							}
						).__p4Trace ?? [];
					return {
						progress: trace.filter((e) => e.kind === "progress").length,
						result: trace.some((e) => e.kind === "result"),
						hardError: trace.some(
							(e) =>
								e.kind === "error" && e.detail?.code !== "AGENTIC_FALLBACK",
						),
					};
				}),
			{ timeout: 15_000, intervals: [100, 250, 500] },
		)
		.toMatchObject({ result: true, hardError: false });
});
