import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * UF Navigator AGENTIC + RAG probe.
 *
 * Tests the multi-turn ReAct loop (agentic-mode="agentic") and RAG-on
 * retrieval (retrieval="on") against UF Navigator's reasoning model
 * (gpt-oss-120b). The headless coverage spec runs in single-shot only;
 * this spec specifically exercises the planner code paths that the
 * 2026-05-15 audit found broken on Llama (verbose tool_calls + replay).
 *
 * Hypothesis: gpt-oss-120b's reasoning capacity should let it converge
 * in the ReAct loop where Llama 3.3-70B couldn't.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");

function loadEnv(): Record<string, string> {
	const out: Record<string, string> = {};
	try {
		for (const l of readFileSync(
			resolve(REPO_ROOT, ".env.local"),
			"utf8",
		).split(/\r?\n/)) {
			const t = l.trim();
			if (!t || t.startsWith("#")) continue;
			const eq = t.indexOf("=");
			if (eq < 0) continue;
			out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
		}
	} catch {}
	return out;
}
const E = loadEnv();
const KEY = process.env.NAVIGATOR_API_KEY ?? E.NAVIGATOR_API_KEY ?? "";
const MODEL = "gpt-oss-120b";
const POINTS_CSV = readFileSync(resolve(__dirname, "../fixtures/points.csv"));

const CASES = [
	{ id: "agentic-count", question: "How many rows are in this dataset?" },
	{ id: "agentic-chart", question: "Show a bar chart of population by city." },
	{ id: "agentic-map", question: "Map all the points on a map." },
];

test.describe("UF Navigator agentic + RAG (gpt-oss-120b)", () => {
	test.skip(!KEY, "Set NAVIGATOR_API_KEY");

	for (const c of CASES) {
		test(c.id, async ({ page }) => {
			test.setTimeout(240_000);
			const errs: string[] = [];
			page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));

			await page.goto("/");
			await page.waitForSelector("geo-chatbot");

			const csvBytes = Array.from(new Uint8Array(POINTS_CSV));
			const outcome = await page.evaluate(
				async ({ apiKey, model, csvBytes, question }) => {
					const el = document.querySelector("geo-chatbot") as HTMLElement & {
						setProvider: (p: {
							name: string;
							apiKey: string;
							model?: string;
						}) => void;
						pushData: (f: File) => Promise<unknown> | undefined;
						ask: (q: string) => Promise<string>;
						approvePlan: (id?: string) => void;
						on?: (ev: string, cb: (p: unknown) => void) => () => void;
						dangerouslyAllowBrowser?: boolean;
					};
					el.dangerouslyAllowBrowser = true;
					// Explicitly enable agentic ReAct loop + RAG retrieval. These
					// are the harder code paths the 2026-05-15 audit deferred.
					el.setAttribute("agentic-mode", "agentic");
					el.setAttribute("retrieval", "on");
					el.setProvider({ name: "uf-navigator", apiKey, model });

					let resolveResult: (r: { kind: string }) => void = () => {};
					let rejectResult: (err: Error) => void = () => {};
					const result = new Promise<{ kind: string }>((res, rej) => {
						resolveResult = res;
						rejectResult = rej;
					});
					const tid = setTimeout(
						() => rejectResult(new Error("result timeout (180s)")),
						180_000,
					);
					const agenticSteps: string[] = [];

					let resolveData: () => void = () => {};
					const dataLoaded = new Promise<void>((res) => {
						resolveData = res;
					});

					el.on?.("dataset-loaded", () => resolveData());
					el.on?.("agentic-step", (p: unknown) => {
						const e = p as { kind?: string; iteration?: number };
						agenticSteps.push(`${e.iteration ?? "?"}:${e.kind ?? "?"}`);
					});
					el.on?.("plan", (p: unknown) => {
						const planId = (p as { planId?: string }).planId;
						if (planId)
							try {
								el.approvePlan(planId);
							} catch {}
					});
					el.on?.("result", (p: unknown) => {
						clearTimeout(tid);
						resolveResult({ kind: (p as { kind?: string }).kind ?? "unknown" });
					});
					el.on?.("error", (p: unknown) => {
						const e = p as { code?: string; message?: string };
						if (e.code === "AGENTIC_FALLBACK") return;
						clearTimeout(tid);
						rejectResult(
							new Error(`${e.code}: ${(e.message ?? "").slice(0, 200)}`),
						);
					});

					const file = new File([new Uint8Array(csvBytes)], "points.csv", {
						type: "text/csv",
					});
					await el.pushData(file);
					await dataLoaded;
					el.ask(question).catch(() => {});

					try {
						const r = await result;
						return {
							ok: true,
							kind: r.kind,
							agenticSteps,
							err: null as string | null,
						};
					} catch (err) {
						return {
							ok: false,
							kind: null,
							agenticSteps,
							err: String(err).slice(0, 300),
						};
					}
				},
				{ apiKey: KEY, model: MODEL, csvBytes, question: c.question },
			);

			await page.waitForTimeout(1200);
			await page.screenshot({
				path: `test-results/navigator-agentic-${c.id}.png`,
				fullPage: true,
			});

			console.log(`[${c.id}] outcome:`, JSON.stringify(outcome));
			if (errs.length) console.log(`[${c.id}] errors:`, errs.slice(0, 3));

			expect(outcome.ok, `result event fired (err: ${outcome.err ?? ""})`).toBe(
				true,
			);
			expect(
				outcome.agenticSteps.length,
				"agentic loop emitted at least one step event",
			).toBeGreaterThan(0);
		});
	}
});
