import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * UF Navigator VISUAL coverage suite — sibling to navigator-coverage.spec.ts.
 *
 * The headless coverage spec uses `setMode("headless")` which suppresses
 * UI rendering — screenshots come out blank. This spec runs in `full` mode
 * and auto-approves each plan, so the result-canvas mounts and renders
 * the actual chart / table / map / summary. Screenshots are the human-eye
 * proof that the model's answer is correct.
 *
 * One PNG per case at `e2e/test-results/navigator-vis-<id>.png`.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");

function loadEnv(): Record<string, string> {
	const out: Record<string, string> = {};
	try {
		for (const l of readFileSync(resolve(REPO_ROOT, ".env.local"), "utf8").split(
			/\r?\n/,
		)) {
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
const MODEL =
	process.env.NAVIGATOR_MODEL ?? E.NAVIGATOR_MODEL ?? "llama-3.3-70b-instruct";
const POINTS_CSV = readFileSync(resolve(__dirname, "../fixtures/points.csv"));

interface VisualCase {
	id: string;
	question: string;
	expectKind: "summary" | "table" | "chart" | "layer";
}

const CASES: VisualCase[] = [
	{ id: "count", question: "How many rows are in this dataset?", expectKind: "summary" },
	{ id: "stats", question: "Give me summary statistics for the population column.", expectKind: "table" },
	{ id: "topn-bar", question: "Show a bar chart of population by city.", expectKind: "chart" },
	{ id: "map", question: "Map the points.", expectKind: "layer" },
	{ id: "filter", question: "How many cities have population over 300000?", expectKind: "summary" },
];

test.describe("UF Navigator visual coverage (full mode, auto-approve)", () => {
	test.skip(!KEY, "Set NAVIGATOR_API_KEY in .env.local to enable");

	for (const c of CASES) {
		test(`visual: ${c.id} — ${c.question}`, async ({ page }) => {
			test.setTimeout(180_000);

			const consoleErrors: string[] = [];
			page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

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
						pushData: (f: File) => Promise<unknown> | void;
						ask: (q: string) => Promise<string>;
						approvePlan: (id?: string) => void;
						on?: (ev: string, cb: (p: unknown) => void) => () => void;
						dangerouslyAllowBrowser?: boolean;
					};
					el.dangerouslyAllowBrowser = true;
					// The demo page hardcodes agentic-mode="agentic" but the
					// ReAct loop is structurally incompatible with UF Navigator
					// (see audit report). Force single-shot for these tests.
					el.setAttribute("agentic-mode", "single-shot");
					el.setProvider({ name: "uf-navigator", apiKey, model });

					// Register listeners BEFORE any async work so we don't miss events.
					let resolveResult: (r: { kind: string }) => void = () => {};
					let rejectResult: (err: Error) => void = () => {};
					const resultArrived = new Promise<{ kind: string }>((res, rej) => {
						resolveResult = res;
						rejectResult = rej;
					});
					const tid = setTimeout(
						() => rejectResult(new Error("result timeout")),
						120_000,
					);

					let resolveDataset: () => void = () => {};
					const datasetLoaded = new Promise<void>(
						(res) => (resolveDataset = res),
					);

					el.on?.("dataset-loaded", () => resolveDataset());
					el.on?.("plan", (p: unknown) => {
						const planId = (p as { planId?: string }).planId;
						if (planId) {
							// Auto-approve so the executor runs immediately.
							try {
								el.approvePlan(planId);
							} catch {}
						}
					});
					el.on?.("result", (p: unknown) => {
						clearTimeout(tid);
						const d = (p ?? {}) as { kind?: string };
						resolveResult({ kind: d.kind ?? "unknown" });
					});
					el.on?.("error", (p: unknown) => {
						const e = (p ?? {}) as { code?: string; message?: string };
						// AGENTIC_FALLBACK is a soft warning, not a hard error.
						if (e.code === "AGENTIC_FALLBACK") return;
						clearTimeout(tid);
						rejectResult(
							new Error(`${e.code ?? "ERROR"}: ${(e.message ?? "").slice(0, 200)}`),
						);
					});

					const file = new File([new Uint8Array(csvBytes)], "points.csv", {
						type: "text/csv",
					});
					await el.pushData(file);
					await datasetLoaded;
					el.ask(question).catch(() => {});
					try {
						const r = await resultArrived;
						return { ok: true, kind: r.kind, err: null as string | null };
					} catch (err) {
						return {
							ok: false,
							kind: null,
							err: String(err).slice(0, 300),
						};
					}
				},
				{ apiKey: KEY, model: MODEL, csvBytes, question: c.question },
			);

			// Let the result-canvas paint before screenshot.
			await page.waitForTimeout(1500);
			await page.screenshot({
				path: `test-results/navigator-vis-${c.id}.png`,
				fullPage: true,
			});

			if (consoleErrors.length) {
				console.log(`[${c.id}] page errors:`, consoleErrors.slice(0, 3));
			}
			console.log(`[${c.id}] result:`, JSON.stringify(outcome));

			expect(outcome.ok, `result event fired (err: ${outcome.err ?? ""})`).toBe(
				true,
			);
			expect(outcome.kind, `expected kind=${c.expectKind}`).toBe(c.expectKind);
		});
	}
});
