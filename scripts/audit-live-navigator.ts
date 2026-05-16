/**
 * UF Navigator audit harness — comprehensive coverage of the agent's
 * tool surface against the LiteLLM-hosted Llama models exposed to UF
 * individual API keys.
 *
 * What it does
 *   - Loads NAVIGATOR_API_KEY + NAVIGATOR_BASE_URL + NAVIGATOR_MODEL from
 *     .env.local (reads file directly; no dotenv dependency).
 *   - Reads the prompt corpus from
 *     packages/eval/tasks/comprehensive_v1.json
 *   - For each prompt, runs the agentic ReAct loop against the
 *     gateway, captures the produced Plan, and scores plan-shape against
 *     `acceptable_plan_shapes` (does the produced plan match one of the
 *     accepted tool sequences?).
 *   - Optionally re-runs the same prompt in single-shot mode via the
 *     Planner class so we can compare both code paths.
 *   - Emits a JSONL audit report to
 *     audit-reports/navigator-llama-<model>-<timestamp>.jsonl and a
 *     summary table to stdout.
 *
 * Usage:
 *   pnpm exec tsx scripts/audit-live-navigator.ts \
 *     [--model=llama-3.3-70b-instruct] \
 *     [--mode=both|single-shot|agentic] \
 *     [--filter=tag-or-id-substring] \
 *     [--limit=N]
 *
 * Notes:
 *   - This is a headless harness; no browser DOM, no DuckDB. We score
 *     plan shape only. Plan EXECUTION (does the plan return the right
 *     answer?) requires real DuckDB and lives in the Playwright suite.
 *   - The key is never echoed.
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tableFromJSON } from "apache-arrow";
import { zodToJsonSchema } from "zod-to-json-schema";
import "../packages/widget/src/agent/tools/index.js";
import type { InspectionRunCtx } from "../packages/widget/src/agent/agentic/inspect-runners.js";
import { runAgentLoop } from "../packages/widget/src/agent/agentic/loop.js";
import type {
	DatasetEntry,
	ExecutorEngine,
} from "../packages/widget/src/agent/executor/types.js";
import { callForcedTool } from "../packages/widget/src/agent/forced-tool/index.js";
import { AGENTIC_PREAMBLE } from "../packages/widget/src/agent/prompts/agentic-preamble.js";
import { listTools } from "../packages/widget/src/agent/tools/registry.js";
import { PlanSchema, type Plan } from "../packages/widget/src/agent/types.js";
import {
	PlanValidationError,
	validatePlan,
} from "../packages/widget/src/agent/validate-plan.js";

/* -------------------------------------------------------------------------- */
/* .env.local loader (no external deps)                                       */
/* -------------------------------------------------------------------------- */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

function loadDotEnvLocal(): void {
	const path = resolve(REPO_ROOT, ".env.local");
	if (!existsSync(path)) return;
	const raw = readFileSync(path, "utf8");
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq < 0) continue;
		const k = trimmed.slice(0, eq).trim();
		const v = trimmed.slice(eq + 1).trim();
		if (!(k in process.env)) process.env[k] = v;
	}
}

loadDotEnvLocal();

const API_KEY = process.env.NAVIGATOR_API_KEY;
const BASE_URL =
	process.env.NAVIGATOR_BASE_URL ?? "https://api.ai.it.ufl.edu/v1";
const ENDPOINT = `${BASE_URL.replace(/\/$/, "")}/chat/completions`;

if (!API_KEY) {
	console.error(
		"ERROR: NAVIGATOR_API_KEY missing. Put it in .env.local at repo root.",
	);
	process.exit(2);
}

/* -------------------------------------------------------------------------- */
/* CLI args                                                                   */
/* -------------------------------------------------------------------------- */

interface Args {
	model: string;
	mode: "single-shot" | "agentic" | "both";
	filter: string | null;
	limit: number | null;
}

function parseArgs(): Args {
	const out: Args = {
		model: process.env.NAVIGATOR_MODEL ?? "llama-3.3-70b-instruct",
		mode: "single-shot",
		filter: null,
		limit: null,
	};
	for (const arg of process.argv.slice(2)) {
		const m = arg.match(/^--([^=]+)=(.+)$/);
		if (!m) continue;
		const [, k, v] = m;
		if (k === "model") out.model = v as string;
		else if (k === "mode") out.mode = v as Args["mode"];
		else if (k === "filter") out.filter = v as string;
		else if (k === "limit") out.limit = Number.parseInt(v as string, 10);
	}
	return out;
}

const ARGS = parseArgs();

/* -------------------------------------------------------------------------- */
/* Corpus + dataset profile                                                   */
/* -------------------------------------------------------------------------- */

interface PlanShapeStep {
	tool: string;
}
interface CorpusPrompt {
	id: string;
	question: string;
	dataset_refs: string[];
	acceptable_plan_shapes: PlanShapeStep[][];
	expected: Record<string, unknown>;
	tags: string[];
}

const CORPUS: CorpusPrompt[] = JSON.parse(
	readFileSync(
		resolve(REPO_ROOT, "packages/eval/tasks/comprehensive_v1.json"),
		"utf8",
	),
) as CorpusPrompt[];

/**
 * Static dataset profiles for the synthetic engine. Mirrors the fixtures
 * at packages/eval/geochatbot_eval/fixtures/. We don't need to query
 * real data — the planner only sees the profile block; execution is
 * faked by the synthetic engine.
 */
const PROFILES: Record<
	string,
	{
		name: string;
		kind: "table" | "layer";
		rows: number;
		columns: Array<{ name: string; type: string }>;
		sample: Array<Record<string, unknown>>;
		hasGeometry: boolean;
	}
> = {
	nyc311: {
		name: "nyc311",
		kind: "table",
		rows: 50,
		hasGeometry: true,
		columns: [
			{ name: "unique_key", type: "Int64" },
			{ name: "created_date", type: "Utf8" },
			{ name: "complaint_type", type: "Utf8" },
			{ name: "borough", type: "Utf8" },
			{ name: "latitude", type: "Float64" },
			{ name: "longitude", type: "Float64" },
		],
		sample: [
			{
				unique_key: 1001,
				created_date: "2024-01-03",
				complaint_type: "Noise",
				borough: "Brooklyn",
				latitude: 40.6782,
				longitude: -73.9442,
			},
		],
	},
	boroughs: {
		name: "boroughs",
		kind: "layer",
		rows: 5,
		hasGeometry: true,
		columns: [
			{ name: "name", type: "Utf8" },
			{ name: "boro_code", type: "Int64" },
			{ name: "geometry", type: "Geometry" },
		],
		sample: [{ name: "Manhattan", boro_code: 1 }],
	},
};

function renderDatasetsBlock(refs: string[]): string {
	const out: string[] = [];
	for (const ref of refs) {
		const p = PROFILES[ref];
		if (!p) continue;
		out.push(`## ${p.name} (${p.kind}, ${p.rows} rows)`);
		out.push("Columns:");
		for (const c of p.columns) out.push(`- ${c.name}: ${c.type}`);
		if (p.sample.length > 0) {
			out.push("Sample row:");
			out.push("```json");
			out.push(JSON.stringify(p.sample[0], null, 2));
			out.push("```");
		}
		out.push("");
	}
	return out.join("\n");
}

function renderToolsBlock(): string {
	const out: string[] = [];
	for (const t of listTools()) {
		out.push(`- **${t.id}** (output: ${t.output_kind}) — ${t.description}`);
	}
	return out.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Synthetic engine (probes only — no real execution)                         */
/* -------------------------------------------------------------------------- */

function makeEngine(refs: string[]): ExecutorEngine {
	const columnsByName = new Map<
		string,
		Array<{ name: string; type: string }>
	>();
	const samplesByName = new Map<string, Array<Record<string, unknown>>>();
	for (const ref of refs) {
		const p = PROFILES[ref];
		if (!p) continue;
		columnsByName.set(ref, p.columns);
		samplesByName.set(ref, p.sample);
	}
	return {
		hasSpatial: true,
		async query(sql: string) {
			const m = sql.match(/FROM\s+([A-Za-z_][A-Za-z0-9_]*)/i);
			const tbl = m?.[1];
			if (/pragma_table_info/i.test(sql)) {
				const cols = (tbl && columnsByName.get(tbl)) ?? [];
				return tableFromJSON(
					cols.map((c) => ({ name: c.name, type: c.type, nullable: false })),
				);
			}
			if (/COUNT\(\*\)/i.test(sql)) {
				const rows = PROFILES[tbl ?? ""]?.rows ?? 50;
				return tableFromJSON([{ n: rows }]);
			}
			const samples = (tbl && samplesByName.get(tbl)) ?? [];
			if (samples.length > 0) return tableFromJSON(samples);
			return tableFromJSON([{ ok: 1 }]);
		},
	};
}

/* -------------------------------------------------------------------------- */
/* Plan-shape scoring                                                         */
/* -------------------------------------------------------------------------- */

interface ScoreResult {
	matched: boolean;
	matchedShape?: number;
	reason?: string;
}

/**
 * Plan-shape match: the produced plan's tool sequence (in order)
 * must include every tool in one of the acceptable shapes, in the
 * relative order specified. Extra tools between expected ones are OK;
 * skipped expected tools are not.
 */
function scorePlanShape(
	plan: Plan,
	shapes: PlanShapeStep[][],
): ScoreResult {
	const produced = plan.steps.map((s) => s.tool);
	if (shapes.length === 1 && shapes[0]?.length === 0) {
		return {
			matched: false,
			reason: "out-of-scope prompt should have been refused, not planned",
		};
	}
	for (let i = 0; i < shapes.length; i++) {
		const shape = shapes[i] as PlanShapeStep[];
		let cursor = 0;
		let ok = true;
		for (const expected of shape) {
			const idx = produced.indexOf(expected.tool, cursor);
			if (idx < 0) {
				ok = false;
				break;
			}
			cursor = idx + 1;
		}
		if (ok) return { matched: true, matchedShape: i };
	}
	return {
		matched: false,
		reason: `produced [${produced.join(" → ")}] matches no acceptable shape`,
	};
}

/* -------------------------------------------------------------------------- */
/* Runners                                                                    */
/* -------------------------------------------------------------------------- */

interface RunResult {
	id: string;
	tags: string[];
	mode: "single-shot" | "agentic";
	model: string;
	status: "PASS" | "FAIL" | "ERROR";
	plan?: { steps: Array<{ tool: string }> };
	matchedShape?: number;
	reason?: string;
	durationMs: number;
}

/* ----- Single-shot planner: reads planner.system.md off disk to bypass --- */
/* the Vite `?raw` import in builders.ts, then issues a single forced-tool */
/* round-trip via callForcedTool. No message replay, no token-budget       */
/* truncation across iterations.                                            */

const PLANNER_SYSTEM_RAW = readFileSync(
	resolve(
		REPO_ROOT,
		"packages/widget/src/agent/prompts/planner.system.md",
	),
	"utf8",
);

function buildPlannerSystemPrompt(refs: string[]): string {
	return PLANNER_SYSTEM_RAW.replace(
		"{{datasets_block}}",
		renderDatasetsBlock(refs),
	).replace("{{tools_block}}", renderToolsBlock());
}

const PLAN_TOOL_INPUT_SCHEMA = zodToJsonSchema(PlanSchema, {
	target: "openApi3",
}) as Record<string, unknown>;

async function runSingleShot(p: CorpusPrompt): Promise<RunResult> {
	const t0 = Date.now();
	const systemPrompt = buildPlannerSystemPrompt(p.dataset_refs);
	try {
		const raw = await callForcedTool({
			provider: "uf-navigator",
			apiKey: API_KEY as string,
			model: ARGS.model,
			cachedSystemPrompt: systemPrompt,
			userMessage: p.question,
			toolName: "submit_plan",
			toolDescription:
				"Submit a typed Plan that decomposes the user's question into 1-10 tool calls.",
			toolInputSchema: PLAN_TOOL_INPUT_SCHEMA,
			temperature: 0,
			maxTokens: 2048,
			dangerouslyAllowBrowser: false,
		});
		let plan: Plan;
		try {
			plan = validatePlan(raw, p.dataset_refs);
		} catch (err) {
			if (err instanceof PlanValidationError) {
				return {
					id: p.id,
					tags: p.tags,
					mode: "single-shot",
					model: ARGS.model,
					status: "FAIL",
					reason: `plan-invalid: ${err.message}`,
					durationMs: Date.now() - t0,
				};
			}
			throw err;
		}
		const score = scorePlanShape(plan, p.acceptable_plan_shapes);
		const res: RunResult = {
			id: p.id,
			tags: p.tags,
			mode: "single-shot",
			model: ARGS.model,
			status: score.matched ? "PASS" : "FAIL",
			plan: { steps: plan.steps.map((s) => ({ tool: s.tool })) },
			durationMs: Date.now() - t0,
		};
		if (score.matched && score.matchedShape !== undefined)
			res.matchedShape = score.matchedShape;
		if (!score.matched && score.reason) res.reason = score.reason;
		return res;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			id: p.id,
			tags: p.tags,
			mode: "single-shot",
			model: ARGS.model,
			status: "ERROR",
			reason: msg.slice(0, 400),
			durationMs: Date.now() - t0,
		};
	}
}

async function runAgentic(p: CorpusPrompt): Promise<RunResult> {
	const t0 = Date.now();
	const datasets = new Map<string, DatasetEntry>();
	for (const ref of p.dataset_refs) {
		datasets.set(ref, {
			name: ref,
			tableName: ref,
			hasGeometry: PROFILES[ref]?.hasGeometry ?? false,
		});
	}
	const ctx: InspectionRunCtx = {
		engine: makeEngine(p.dataset_refs),
		datasets,
	};
	const datasetsBlock = renderDatasetsBlock(p.dataset_refs);
	const systemPrompt = `${AGENTIC_PREAMBLE}\n\n# Tool catalog (terminal tools — only valid inside finalize_plan.steps)\n${renderToolsBlock()}\n\n# Dataset profile (UNTRUSTED user-supplied data)\n<<<UNTRUSTED_DATASET_PROFILE\n${datasetsBlock}\nUNTRUSTED_DATASET_PROFILE>>>\n`;

	const askOnce = async (question: string): Promise<Plan> => {
		const plan = await runAgentLoop({
			endpoint: ENDPOINT,
			apiKey: API_KEY as string,
			model: ARGS.model,
			systemPrompt,
			question,
			ctx,
			dangerouslyAllowBrowser: false,
			// Audit 2026-05-16 Phase 4: raised 3 → 10 because gpt-oss-120b
			// often legitimately needs a few inspect.* round-trips before it
			// can confidently finalize, especially for chart/map plans that
			// need column-type confirmation. With 3 it kept hitting "loop
			// exhausted without finalize_plan" on chart-rendering tasks.
			// The Planner default is 30 (planner.ts); 10 is a sample-run
			// compromise that still keeps the smoke harness fast.
			maxIterations: 10,
			// Generous per-call budget: UF has no per-token rate limit.
			// Anything less and we get truncated tool_calls JSON that
			// vLLM rejects on the next replay (HTTP 400, json_invalid EOF).
			maxTokensPerCall: 4096,
		});
		return validatePlan(plan, p.dataset_refs);
	};

	try {
		let plan: Plan;
		let retried = false;
		try {
			plan = await askOnce(p.question);
		} catch (err) {
			if (!(err instanceof PlanValidationError)) throw err;
			// Mirror production planner.ts:359 retry-with-feedback. The
			// validator's error message becomes part of the next prompt so
			// the model can self-correct (e.g. "last step must be render.*").
			retried = true;
			const retryQ = `${p.question}\n\nYour previous plan failed validation: ${err.message}. Produce a corrected plan. Pay close attention to: omitting optional fields when you don't have a real value (NEVER pass "", "null", "NA"), keeping every \${var} backward-referencing only, and ending with a render.* or report.* tool.`;
			try {
				plan = await askOnce(retryQ);
			} catch (err2) {
				if (err2 instanceof PlanValidationError) {
					return {
						id: p.id,
						tags: p.tags,
						mode: "agentic",
						model: ARGS.model,
						status: "FAIL",
						reason: `plan-invalid-after-retry: ${err2.message}`,
						durationMs: Date.now() - t0,
					};
				}
				throw err2;
			}
		}
		const score = scorePlanShape(plan, p.acceptable_plan_shapes);
		const res: RunResult = {
			id: p.id,
			tags: p.tags,
			mode: "agentic",
			model: ARGS.model,
			status: score.matched ? "PASS" : "FAIL",
			plan: { steps: plan.steps.map((s) => ({ tool: s.tool })) },
			durationMs: Date.now() - t0,
		};
		if (score.matched && score.matchedShape !== undefined)
			res.matchedShape = score.matchedShape;
		if (!score.matched && score.reason) res.reason = score.reason;
		if (retried) res.reason = `${res.reason ?? ""} [recovered-via-retry]`.trim();
		return res;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			id: p.id,
			tags: p.tags,
			mode: "agentic",
			model: ARGS.model,
			status: "ERROR",
			reason: msg.slice(0, 400),
			durationMs: Date.now() - t0,
		};
	}
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

function badge(s: RunResult["status"]): string {
	if (s === "PASS") return "PASS";
	if (s === "FAIL") return "FAIL";
	return "ERR ";
}

async function main(): Promise<void> {
	let prompts = CORPUS;
	if (ARGS.filter) {
		const f = ARGS.filter.toLowerCase();
		prompts = prompts.filter(
			(p) => p.id.toLowerCase().includes(f) || p.tags.some((t) => t.includes(f)),
		);
	}
	if (ARGS.limit !== null) prompts = prompts.slice(0, ARGS.limit);

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const reportDir = resolve(REPO_ROOT, "audit-reports");
	mkdirSync(reportDir, { recursive: true });
	const logPath = resolve(
		reportDir,
		`navigator-llama-${ARGS.model.replace(/[^a-z0-9]/gi, "_")}-${stamp}.jsonl`,
	);

	console.log("=== UF Navigator audit harness ===");
	console.log(`endpoint: ${ENDPOINT}`);
	console.log(`model:    ${ARGS.model}`);
	console.log(`mode:     ${ARGS.mode}`);
	console.log(`prompts:  ${prompts.length}`);
	console.log(`report:   ${logPath}`);
	console.log("");

	const results: RunResult[] = [];
	const modes: Array<"single-shot" | "agentic"> =
		ARGS.mode === "both"
			? ["single-shot", "agentic"]
			: [ARGS.mode];

	for (const p of prompts) {
		for (const m of modes) {
			const r = m === "agentic" ? await runAgentic(p) : await runSingleShot(p);
			results.push(r);
			writeFileSync(logPath, `${JSON.stringify(r)}\n`, { flag: "a" });
			const tools = r.plan
				? r.plan.steps.map((s) => s.tool).join(" → ")
				: "";
			console.log(
				`${badge(r.status)} ${m.padEnd(11)} ${p.id.padEnd(34)} ${
					r.durationMs.toString().padStart(5)
				}ms ${tools || r.reason || ""}`.slice(0, 220),
			);
		}
	}

	const total = results.length;
	const pass = results.filter((r) => r.status === "PASS").length;
	const fail = results.filter((r) => r.status === "FAIL").length;
	const err = results.filter((r) => r.status === "ERROR").length;
	console.log("");
	console.log(
		`SUMMARY total=${total} pass=${pass} fail=${fail} err=${err} (${(
			(pass / total) *
			100
		).toFixed(0)}%)`,
	);
	console.log(`report saved to: ${logPath}`);
	process.exit(fail + err === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error("HARNESS ERROR:", (err as Error).message);
	process.exit(2);
});
