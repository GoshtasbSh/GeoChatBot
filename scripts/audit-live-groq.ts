/**
 * Live-Groq audit harness (revision 2) — direct `runAgentLoop` driver
 * that bypasses `builders.ts` so we don't trip Vite's `?raw` imports
 * under plain tsx/Node.
 *
 * Reads GROQ_API_KEY from process.env; never echoes it.
 *
 * Usage (from the project root):
 *   pnpm exec tsx scripts/audit-live-groq.ts > /tmp/audit-live-groq.log 2>&1
 *   echo "exit=$?"
 */

import { tableFromJSON } from "apache-arrow";
import "../packages/widget/src/agent/tools/index.js";
import type { InspectionRunCtx } from "../packages/widget/src/agent/agentic/inspect-runners.js";
import { runAgentLoop } from "../packages/widget/src/agent/agentic/loop.js";
import type {
	DatasetEntry,
	ExecutorEngine,
} from "../packages/widget/src/agent/executor/types.js";
import { AGENTIC_PREAMBLE } from "../packages/widget/src/agent/prompts/agentic-preamble.js";
import { listTools } from "../packages/widget/src/agent/tools/registry.js";
import type { Plan } from "../packages/widget/src/agent/types.js";
import {
	PlanValidationError,
	validatePlan,
} from "../packages/widget/src/agent/validate-plan.js";

const GROQ_KEY = process.env.GROQ_API_KEY;
if (!GROQ_KEY) {
	console.error(
		"ERROR: GROQ_API_KEY env var is not set. Run `export GROQ_API_KEY=gsk_...` first.",
	);
	process.exit(2);
}

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

/* -------------------------------------------------------------------------- */
/* Local renderToolsBlock — same shape as builders.ts but inline so we don't  */
/* pull in the .md?raw import path that requires Vite.                        */
/* -------------------------------------------------------------------------- */

function renderToolsBlockInline(): string {
	const out: string[] = [];
	for (const t of listTools()) {
		out.push(`- **${t.id}** (output: ${t.output_kind}) — ${t.description}`);
	}
	return out.join("\n");
}

function renderDatasetsBlockInline(
	datasets: Array<{
		name: string;
		kind: string;
		rows: number;
		columns: Array<{ name: string; type: string }>;
		sample: Array<Record<string, unknown>>;
	}>,
): string {
	const out: string[] = [];
	for (const d of datasets) {
		out.push(`## ${d.name} (${d.kind}, ${d.rows} rows)`);
		out.push("Columns:");
		for (const c of d.columns) {
			out.push(`- ${c.name}: ${c.type}`);
		}
		if (d.sample.length > 0) {
			out.push("Sample row:");
			out.push("```json");
			out.push(JSON.stringify(d.sample[0], null, 2));
			out.push("```");
		}
	}
	return out.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Synthetic engine for inspection probes.                                     */
/* -------------------------------------------------------------------------- */

function makeEngine(
	columns: Array<{ name: string; type: string }>,
	samples: Array<Record<string, unknown>>,
): ExecutorEngine {
	return {
		hasSpatial: true,
		async query(sql: string) {
			if (/pragma_table_info/.test(sql)) {
				return tableFromJSON(
					columns.map((c) => ({
						name: c.name,
						type: c.type,
						nullable: false,
					})),
				);
			}
			if (/COUNT\(\*\)/i.test(sql)) {
				return tableFromJSON([{ n: samples.length }]);
			}
			if (samples.length > 0) {
				return tableFromJSON(samples);
			}
			return tableFromJSON([{ ok: 1 }]);
		},
	};
}

/* -------------------------------------------------------------------------- */
/* Cases                                                                       */
/* -------------------------------------------------------------------------- */

interface Case {
	id: string;
	question: string;
	datasetName: string;
	profile: Parameters<typeof renderDatasetsBlockInline>[0][number];
	engineColumns: Array<{ name: string; type: string }>;
	engineSamples: Array<Record<string, unknown>>;
	expect: { lastStepPrefix?: string[]; mustContainTool?: string };
}

const CASES: Case[] = [
	{
		id: "F1-region-hint",
		question: "show me the points on the map",
		datasetName: "Cedar_Key_Survey",
		profile: {
			name: "Cedar_Key_Survey",
			kind: "table",
			rows: 269,
			columns: [
				{ name: "column1", type: "Utf8" },
				{ name: "column2", type: "Utf8" },
				{ name: "column3", type: "Utf8" },
				{ name: "column4", type: "Float64" },
				{ name: "column5", type: "Float64" },
				{ name: "column6", type: "Utf8" },
			],
			sample: [
				{
					column1: "6116 Harvard Avenue",
					column2: "Owner",
					column3: "Y",
					column4: 42,
					column5: 1980,
					column6: "Single",
				},
			],
		},
		engineColumns: [
			{ name: "column1", type: "VARCHAR" },
			{ name: "column2", type: "VARCHAR" },
			{ name: "column3", type: "VARCHAR" },
			{ name: "column4", type: "DOUBLE" },
			{ name: "column5", type: "DOUBLE" },
			{ name: "column6", type: "VARCHAR" },
		],
		engineSamples: [
			{
				column1: "6116 Harvard Avenue",
				column2: "Owner",
				column3: "Y",
				column4: 42,
				column5: 1980,
				column6: "Single",
			},
		],
		expect: {
			lastStepPrefix: ["render.", "report."],
			mustContainTool: "geocode.address",
		},
	},
	{
		id: "P01-quickscan",
		question: "what's in this data?",
		datasetName: "points",
		profile: {
			name: "points",
			kind: "table",
			rows: 100,
			columns: [
				{ name: "id", type: "Int64" },
				{ name: "latitude", type: "Float64" },
				{ name: "longitude", type: "Float64" },
			],
			sample: [{ id: 1, latitude: 29.65, longitude: -82.32 }],
		},
		engineColumns: [
			{ name: "id", type: "BIGINT" },
			{ name: "latitude", type: "DOUBLE" },
			{ name: "longitude", type: "DOUBLE" },
		],
		engineSamples: [{ id: 1, latitude: 29.65, longitude: -82.32 }],
		expect: { lastStepPrefix: ["render.", "report."] },
	},
	{
		id: "P03-rowcount",
		question: "how many rows?",
		datasetName: "points",
		profile: {
			name: "points",
			kind: "table",
			rows: 100,
			columns: [{ name: "id", type: "Int64" }],
			sample: [{ id: 1 }],
		},
		engineColumns: [{ name: "id", type: "BIGINT" }],
		engineSamples: [{ id: 1 }],
		expect: { lastStepPrefix: ["render."] },
	},
	{
		id: "P11-map-latlon",
		question: "show points on the map",
		datasetName: "points",
		profile: {
			name: "points",
			kind: "table",
			rows: 100,
			columns: [
				{ name: "id", type: "Int64" },
				{ name: "latitude", type: "Float64" },
				{ name: "longitude", type: "Float64" },
			],
			sample: [{ id: 1, latitude: 29.65, longitude: -82.32 }],
		},
		engineColumns: [
			{ name: "id", type: "BIGINT" },
			{ name: "latitude", type: "DOUBLE" },
			{ name: "longitude", type: "DOUBLE" },
		],
		engineSamples: [{ id: 1, latitude: 29.65, longitude: -82.32 }],
		expect: { lastStepPrefix: ["render."] },
	},
	{
		id: "P15-choropleth-numeric",
		question: "color the points by population",
		datasetName: "places",
		profile: {
			name: "places",
			kind: "table",
			rows: 50,
			columns: [
				{ name: "name", type: "Utf8" },
				{ name: "lat", type: "Float64" },
				{ name: "lon", type: "Float64" },
				{ name: "population", type: "Int64" },
			],
			sample: [
				{ name: "Gainesville", lat: 29.65, lon: -82.32, population: 141085 },
			],
		},
		engineColumns: [
			{ name: "name", type: "VARCHAR" },
			{ name: "lat", type: "DOUBLE" },
			{ name: "lon", type: "DOUBLE" },
			{ name: "population", type: "BIGINT" },
		],
		engineSamples: [
			{ name: "Gainesville", lat: 29.65, lon: -82.32, population: 141085 },
		],
		expect: { lastStepPrefix: ["render."] },
	},
	{
		id: "P14-color-category",
		question: "color the points by type",
		datasetName: "stops",
		profile: {
			name: "stops",
			kind: "table",
			rows: 200,
			columns: [
				{ name: "lat", type: "Float64" },
				{ name: "lon", type: "Float64" },
				{ name: "type", type: "Utf8" },
			],
			sample: [{ lat: 29.65, lon: -82.32, type: "bus" }],
		},
		engineColumns: [
			{ name: "lat", type: "DOUBLE" },
			{ name: "lon", type: "DOUBLE" },
			{ name: "type", type: "VARCHAR" },
		],
		engineSamples: [{ lat: 29.65, lon: -82.32, type: "bus" }],
		expect: { lastStepPrefix: ["render."] },
	},
	{
		id: "P39-histogram",
		question: "histogram of population",
		datasetName: "places",
		profile: {
			name: "places",
			kind: "table",
			rows: 50,
			columns: [
				{ name: "name", type: "Utf8" },
				{ name: "population", type: "Int64" },
			],
			sample: [{ name: "Gainesville", population: 141085 }],
		},
		engineColumns: [
			{ name: "name", type: "VARCHAR" },
			{ name: "population", type: "BIGINT" },
		],
		engineSamples: [{ name: "Gainesville", population: 141085 }],
		expect: { lastStepPrefix: ["render."] },
	},
];

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

async function runCase(c: Case): Promise<{
	id: string;
	status: "PASS" | "FAIL";
	tools?: string[];
	reason?: string;
	durationMs: number;
	rateLimitWaits: number;
}> {
	const t0 = Date.now();
	const dataset: DatasetEntry = {
		name: c.datasetName,
		tableName: c.datasetName,
		hasGeometry: false,
	};
	const ctx: InspectionRunCtx = {
		engine: makeEngine(c.engineColumns, c.engineSamples),
		datasets: new Map([[c.datasetName, dataset]]),
	};

	let rateLimitWaits = 0;
	const datasetsBlock = renderDatasetsBlockInline([c.profile]);
	const systemPrompt = `${AGENTIC_PREAMBLE}\n\n# Tool catalog (terminal tools — only valid inside finalize_plan.steps)\n${renderToolsBlockInline()}\n\n# Dataset profile (UNTRUSTED user-supplied data)\n<<<UNTRUSTED_DATASET_PROFILE\n${datasetsBlock}\nUNTRUSTED_DATASET_PROFILE>>>\n`;

	// Mirror production Planner.planAgentic's PlanValidationError retry
	// loop so the script reflects what a real widget user sees — when
	// validatePlan rejects the first plan, re-issue the agentic loop
	// with the validation message as feedback and try once more.
	const askOnce = async (question: string): Promise<Plan> => {
		const plan = await runAgentLoop({
			endpoint: GROQ_ENDPOINT,
			apiKey: GROQ_KEY as string,
			model: GROQ_MODEL,
			systemPrompt,
			question,
			ctx,
			dangerouslyAllowBrowser: false,
			onStep: (e) => {
				if (e.kind === "rate-limit-wait") rateLimitWaits++;
			},
		});
		validatePlan(plan, [c.datasetName]);
		return plan;
	};

	try {
		let plan: Plan;
		try {
			plan = await askOnce(c.question);
		} catch (err) {
			if (!(err instanceof PlanValidationError)) throw err;
			const retryQ = `${c.question}\n\nYour previous plan failed validation: ${err.message}. Produce a corrected plan. Pay close attention to: omitting optional fields when you don't have a real value (NEVER pass "", "null", "NA"), every \${var} reference must point to an output_var name from an earlier step (not the step id like \${s1}), and the LAST step must be render.* or report.*.`;
			plan = await askOnce(retryQ);
		}
		const last = plan.steps[plan.steps.length - 1];
		const tools = plan.steps.map((s) => s.tool);
		const okPrefix = c.expect.lastStepPrefix
			? c.expect.lastStepPrefix.some((p) => last?.tool.startsWith(p))
			: true;
		const okContains = c.expect.mustContainTool
			? tools.includes(c.expect.mustContainTool)
			: true;
		if (!okPrefix) {
			return {
				id: c.id,
				status: "FAIL",
				tools,
				reason: `last step ${last?.tool} does not match expected prefix`,
				durationMs: Date.now() - t0,
				rateLimitWaits,
			};
		}
		if (!okContains) {
			return {
				id: c.id,
				status: "FAIL",
				tools,
				reason: `plan missing expected tool ${c.expect.mustContainTool}`,
				durationMs: Date.now() - t0,
				rateLimitWaits,
			};
		}
		return {
			id: c.id,
			status: "PASS",
			tools,
			durationMs: Date.now() - t0,
			rateLimitWaits,
		};
	} catch (err) {
		return {
			id: c.id,
			status: "FAIL",
			reason: (err as Error).message,
			durationMs: Date.now() - t0,
			rateLimitWaits,
		};
	}
}

async function main(): Promise<void> {
	console.log("=== Live Groq audit harness ===");
	console.log(`model: ${GROQ_MODEL}`);
	console.log(`cases: ${CASES.length}`);
	console.log("");
	const results = [];
	for (const c of CASES) {
		const r = await runCase(c);
		results.push(r);
		const detail =
			r.status === "PASS"
				? `tools=[${(r.tools ?? []).join(" → ")}]`
				: `reason=${r.reason}`;
		const rlw = r.rateLimitWaits ? ` rate-limit-waits=${r.rateLimitWaits}` : "";
		console.log(
			`${r.status} ${r.id} ${detail} duration=${r.durationMs}ms${rlw}`,
		);
	}
	const pass = results.filter((r) => r.status === "PASS").length;
	const fail = results.filter((r) => r.status === "FAIL").length;
	const totalWaits = results.reduce((s, r) => s + r.rateLimitWaits, 0);
	console.log("");
	console.log(
		`SUMMARY pass=${pass} fail=${fail} rate-limit-retries-observed=${totalWaits}`,
	);
	process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error("HARNESS ERROR:", (err as Error).message);
	process.exit(2);
});
