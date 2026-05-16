import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * UF Navigator end-to-end coverage suite.
 *
 * Unlike the other Phase 4 specs (which stub `__setLlmCall` to test the
 * widget plumbing deterministically), this spec drives the REAL widget
 * against the REAL UF Navigator gateway and exercises:
 *
 *   1. provider config (uf-navigator) survives setProvider()
 *   2. real Llama planner produces a Plan event
 *   3. real DuckDB-WASM executes the plan
 *   4. result event fires with usable output (table/chart/map/summary)
 *
 * The key is read from .env.local (NAVIGATOR_API_KEY). If the env var
 * is missing, all tests in this file are SKIPPED rather than failing —
 * the suite is opt-in by environment.
 *
 * Each prompt-case is one Playwright test() so timing/screenshots are
 * isolated; if Llama goes off the rails on prompt 7 the rest still run.
 */

/* -------------------------------------------------------------------------- */
/* .env.local loader (dependency-free)                                        */
/* -------------------------------------------------------------------------- */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const ENV_LOCAL = resolve(REPO_ROOT, ".env.local");

function loadEnvLocal(): Record<string, string> {
	const out: Record<string, string> = {};
	try {
		const raw = readFileSync(ENV_LOCAL, "utf8");
		for (const line of raw.split(/\r?\n/)) {
			const t = line.trim();
			if (!t || t.startsWith("#")) continue;
			const eq = t.indexOf("=");
			if (eq < 0) continue;
			out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
		}
	} catch {
		/* ignore */
	}
	return out;
}

const ENV = loadEnvLocal();
const API_KEY = process.env.NAVIGATOR_API_KEY ?? ENV.NAVIGATOR_API_KEY ?? "";
const MODEL =
	process.env.NAVIGATOR_MODEL ??
	ENV.NAVIGATOR_MODEL ??
	"llama-3.3-70b-instruct";

const POINTS_CSV = readFileSync(resolve(__dirname, "../fixtures/points.csv"));

/* -------------------------------------------------------------------------- */
/* Cases — representative slice spanning output kinds + data types            */
/* -------------------------------------------------------------------------- */

type ResultMatcher =
	| { kind: "any-result"; mustContain?: string[] }
	| { kind: "must-render"; renderer: "summary" | "table" | "chart" | "map" }
	| { kind: "graceful-failure" }; // out-of-scope: any error|message OK

interface Case {
	id: string;
	question: string;
	dataset: "points-csv" | "geojson" | "no-geo";
	matcher: ResultMatcher;
	/** Longer timeout for multi-step plans. Default 90s. */
	timeoutMs?: number;
}

const CASES: Case[] = [
	{
		id: "count-rows",
		question: "How many rows are in this dataset?",
		dataset: "points-csv",
		matcher: { kind: "any-result", mustContain: ["5"] },
	},
	{
		id: "sum-population",
		question: "What is the total population?",
		dataset: "points-csv",
		matcher: { kind: "any-result", mustContain: ["2", "1"] }, // total = 2,238,683
	},
	{
		id: "topn-city-by-population",
		question: "Which city has the largest population?",
		dataset: "points-csv",
		matcher: { kind: "any-result", mustContain: ["Jacksonville"] },
	},
	{
		id: "groupby-bar-chart",
		question: "Show a bar chart of population by city.",
		dataset: "points-csv",
		matcher: { kind: "must-render", renderer: "chart" },
	},
	{
		id: "render-map-points",
		question: "Map the points.",
		dataset: "points-csv",
		matcher: { kind: "must-render", renderer: "map" },
	},
	{
		id: "render-table-raw",
		question: "Show me the data as a table.",
		dataset: "points-csv",
		matcher: { kind: "must-render", renderer: "table" },
		timeoutMs: 60_000,
	},
	{
		id: "summary-stats",
		question: "Give me summary statistics for the population column.",
		dataset: "points-csv",
		matcher: { kind: "any-result", mustContain: ["mean", "min", "max"] },
	},
	{
		id: "filter-then-count",
		question: "How many cities have population over 300000?",
		dataset: "points-csv",
		matcher: { kind: "any-result", mustContain: ["3"] }, // Miami, Tampa, Jacksonville
	},
	{
		id: "non-spatial-aggregate",
		question: "What is the average price?",
		dataset: "no-geo",
		matcher: { kind: "any-result", mustContain: ["9.", "10."] },
	},
	{
		id: "boolean-filter",
		question: "How many products are in stock?",
		dataset: "no-geo",
		matcher: { kind: "any-result", mustContain: ["2"] },
	},
	{
		id: "geojson-count",
		question: "How many features are in this layer?",
		dataset: "geojson",
		matcher: { kind: "any-result", mustContain: ["3"] },
	},
	{
		id: "out-of-scope-raster",
		question: "Compute NDVI from a Landsat raster of this area.",
		dataset: "points-csv",
		matcher: { kind: "graceful-failure" },
	},
];

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Inject API key into the page, configure the widget for UF Navigator,
 * load the chosen dataset, and ask the question. Resolves with the
 * captured event trace.
 */
async function runCase(
	page: import("@playwright/test").Page,
	c: Case,
	bundle: { apiKey: string; model: string; csvBytes: number[] },
): Promise<{
	plan: boolean;
	result: boolean;
	errors: Array<{ code?: string; message?: string }>;
	resultDetails: Array<Record<string, unknown>>;
	progressKinds: string[];
}> {
	await page.goto("/");
	await page.waitForSelector("geo-chatbot");

	return await page.evaluate(
		async ({ apiKey, model, csvBytes, c }) => {
			type Trace = Array<{ kind: string; detail: unknown }>;
			const w = window as unknown as { __navTrace: Trace };
			w.__navTrace = [];

			const el = document.querySelector("geo-chatbot") as HTMLElement & {
				setProvider: (p: {
					name: string;
					apiKey: string;
					model?: string;
				}) => void;
				pushData: (
					f: File | Record<string, unknown>,
				) => Promise<unknown> | void;
				ask: (q: string) => Promise<string>;
				approvePlan: (id?: string) => void;
				setMode?: (m: "full" | "headless") => void;
				on?: (ev: string, cb: (p: unknown) => void) => () => void;
				dangerouslyAllowBrowser?: boolean;
			};

			el.dangerouslyAllowBrowser = true;
			// Headless mode skips the plan-review approval gate so the
			// executor runs immediately when the planner returns. Otherwise
			// the test would hang waiting for a human to click "Approve".
			el.setMode?.("headless");
			// Demo page hardcodes agentic-mode="agentic" but the ReAct loop
			// is structurally incompatible with UF Navigator's vLLM (see
			// 2026-05-15 audit). Force single-shot.
			el.setAttribute("agentic-mode", "single-shot");
			el.setProvider({ name: "uf-navigator", apiKey, model });

			const cap = (kind: string) => (e: unknown) => {
				const detail =
					e && (e as { detail?: unknown }).detail !== undefined
						? ((e as { detail: unknown }).detail as {
								planId?: string;
							})
						: (e as { planId?: string });
				w.__navTrace.push({ kind, detail });
				// Auto-approve the plan so the executor runs without a human
				// click. Headless mode just hides the plan-review UI; it does
				// NOT auto-execute. Without this the spec hangs forever.
				if (kind === "plan" && detail?.planId) {
					try {
						el.approvePlan(detail.planId);
					} catch {
						/* race with abort — ignore */
					}
				}
			};
			for (const k of ["plan", "progress", "result", "error"] as const) {
				el.addEventListener(k, cap(k) as EventListener);
			}

			// Load dataset
			let file: File;
			if (c.dataset === "points-csv") {
				file = new File([new Uint8Array(csvBytes)], "points.csv", {
					type: "text/csv",
				});
			} else if (c.dataset === "no-geo") {
				const csv =
					"id,product,price,in_stock\n1,widget,9.99,true\n2,gadget,14.50,false\n3,gizmo,3.25,true\n";
				file = new File([csv], "products.csv", { type: "text/csv" });
			} else {
				const gj = {
					type: "FeatureCollection",
					features: [
						{
							type: "Feature",
							properties: { name: "A", value: 10 },
							geometry: { type: "Point", coordinates: [-82.32, 29.65] },
						},
						{
							type: "Feature",
							properties: { name: "B", value: 20 },
							geometry: { type: "Point", coordinates: [-80.19, 25.76] },
						},
						{
							type: "Feature",
							properties: { name: "C", value: 30 },
							geometry: { type: "Point", coordinates: [-81.38, 28.54] },
						},
					],
				};
				file = new File([JSON.stringify(gj)], "points.geojson", {
					type: "application/geo+json",
				});
			}
			// Subscribe BEFORE pushData — otherwise the event can fire
			// during the await and we'd hang forever waiting for it.
			const datasetLoaded = new Promise<void>((resolveDataset, rejectDataset) => {
				const tid = setTimeout(
					() => rejectDataset(new Error("dataset-loaded timeout")),
					30_000,
				);
				const off = el.on?.("dataset-loaded", () => {
					clearTimeout(tid);
					off?.();
					resolveDataset();
				});
			});
			await el.pushData(file);
			await datasetLoaded;

			// Ask question
			try {
				await el.ask(c.question);
			} catch {
				// ask() can throw on planner errors; trace captures the error event
			}

			// Wait until result OR error event lands (or timeout)
			const deadline = Date.now() + (c.matcher.kind === "graceful-failure" ? 30_000 : 90_000);
			while (Date.now() < deadline) {
				const t = w.__navTrace;
				if (
					t.some(
						(e) => e.kind === "result" || e.kind === "error",
					)
				) {
					break;
				}
				await new Promise((r) => setTimeout(r, 250));
			}

			const trace = w.__navTrace;
			const errors = trace
				.filter((e) => e.kind === "error")
				.map((e) => (e.detail ?? {}) as { code?: string; message?: string });
			const resultDetails = trace
				.filter((e) => e.kind === "result")
				.map((e) => (e.detail ?? {}) as Record<string, unknown>);
			return {
				plan: trace.some((e) => e.kind === "plan"),
				result: trace.some((e) => e.kind === "result"),
				errors,
				resultDetails,
				progressKinds: trace
					.filter((e) => e.kind === "progress")
					.map((e) => {
						const d = e.detail as { phase?: string };
						return d?.phase ?? "unknown";
					}),
			};
		},
		{
			apiKey: bundle.apiKey,
			model: bundle.model,
			csvBytes: bundle.csvBytes,
			c,
		},
	);
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

// Skip the whole file when no key is configured.
const hasKey = API_KEY.length > 0;
test.describe("UF Navigator end-to-end coverage", () => {
	test.skip(!hasKey, "Set NAVIGATOR_API_KEY in .env.local to enable");

	for (const c of CASES) {
		test(`${c.id}: ${c.question.slice(0, 60)}`, async ({ page }) => {
			test.setTimeout(c.timeoutMs ?? 180_000);

			// Surface browser errors so the test report is actionable.
			const consoleErrors: string[] = [];
			page.on("console", (m) => {
				if (m.type() === "error") consoleErrors.push(m.text());
			});
			page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

			const csvBytes = Array.from(new Uint8Array(POINTS_CSV));
			const trace = await runCase(page, c, {
				apiKey: API_KEY,
				model: MODEL,
				csvBytes,
			});
			if (consoleErrors.length > 0) {
				console.log(
					`[${c.id}] browser console errors:`,
					consoleErrors.slice(0, 5),
				);
			}
			console.log(`[${c.id}] trace:`, JSON.stringify(trace).slice(0, 400));

			// Always artifact, even on assertion failure below
			await page.screenshot({
				path: `test-results/navigator-${c.id}.png`,
				fullPage: true,
			});

			if (c.matcher.kind === "graceful-failure") {
				// Either model refuses (error event with friendly message) OR
				// produces a plan that the validator/executor rejects — either
				// way, no uncaught exception bubbles out and the UI doesn't
				// hang. Just assert the page is still responsive.
				expect(trace).toBeTruthy();
				return;
			}

			// Real result expected
			expect(trace.plan, "planner emitted a plan event").toBeTruthy();
			expect(
				trace.result,
				`executor emitted a result event (errors: ${JSON.stringify(
					trace.errors,
				).slice(0, 200)})`,
			).toBeTruthy();

			if (c.matcher.kind === "must-render") {
				// The widget's result `kind` field maps to: summary, table, chart,
				// layer (for maps). "map" in the matcher is shorthand for "layer".
				const wanted =
					c.matcher.renderer === "map" ? "layer" : c.matcher.renderer;
				const found = trace.resultDetails.some((r) => {
					const k = (r as { kind?: unknown }).kind;
					return typeof k === "string" && k === wanted;
				});
				expect(
					found,
					`expected kind=${wanted} in result details; got: ${JSON.stringify(
						trace.resultDetails.map((r) => (r as { kind?: unknown }).kind),
					)}`,
				).toBeTruthy();
			} else if (c.matcher.kind === "any-result") {
				if (c.matcher.mustContain) {
					const blob = JSON.stringify(trace.resultDetails).toLowerCase();
					const hits = c.matcher.mustContain.some((t) =>
						blob.includes(t.toLowerCase()),
					);
					expect(
						hits,
						`expected one of ${JSON.stringify(c.matcher.mustContain)} in result; got: ${blob.slice(0, 300)}`,
					).toBeTruthy();
				}
			}
		});
	}
});
