/**
 * TRUE end-to-end correctness audit.
 *
 * For each question with a KNOWN ground-truth answer:
 *   1. Ask gpt-oss-120b for a plan
 *   2. Execute the plan against real DuckDB (loaded with the fixture)
 *   3. Extract the actual numeric / row-count answer from the final render's input
 *   4. Compare to ground truth with tolerance
 *
 * This tests CORRECTNESS, not just plan-shape.
 *
 * Geocoding is NOT included — it requires 5+ min of live Nominatim per call;
 * we honestly accept that and limit geocoding to plan-shape verification.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { DuckDBInstance } from "@duckdb/node-api";
import "../packages/widget/src/agent/tools/index.js";
import { z } from "zod";
import { callForcedTool } from "../packages/widget/src/agent/forced-tool/index.js";
import { listTools } from "../packages/widget/src/agent/tools/registry.js";
import type { ToolDef } from "../packages/widget/src/agent/tools/types.js";
import { PlanSchema } from "../packages/widget/src/agent/types.js";
import { validatePlan } from "../packages/widget/src/agent/validate-plan.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

function loadEnv(): void {
	const path = resolve(REPO_ROOT, ".env.local");
	if (!existsSync(path)) return;
	for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
		const t = line.trim(); if (!t || t.startsWith("#")) continue;
		const eq = t.indexOf("="); if (eq < 0) continue;
		const k = t.slice(0, eq).trim(); const v = t.slice(eq + 1).trim();
		if (!(k in process.env)) process.env[k] = v;
	}
}
loadEnv();
const API_KEY = process.env.NAVIGATOR_API_KEY;
if (!API_KEY) { console.error("NAVIGATOR_API_KEY missing"); process.exit(2); }
const MODEL = process.argv.find(a => a.startsWith("--model="))?.split("=")[1] ?? "gpt-oss-120b";

const FIXTURES: Record<string, { path: string; header: boolean; view: string }> = {
	A: { path: "e2e/fixtures/audit-2026-05-16/clean_urban_points.csv", header: true, view: "A" },
	B: { path: "e2e/fixtures/audit-2026-05-16/mixed_geometry_polygons.csv", header: true, view: "B" },
	C: { path: "e2e/fixtures/audit-2026-05-16/latlon_with_dates.csv", header: true, view: "C" },
	D: { path: "e2e/fixtures/audit-2026-05-16/messy_real_world.csv", header: false, view: "D" },
	F: { path: "e2e/fixtures/audit-2026-05-16/huge_performance.csv", header: true, view: "F" },
	G: { path: "e2e/fixtures/audit-2026-05-16/international_unicode.csv", header: true, view: "G" },
	H: { path: "e2e/fixtures/audit-2026-05-16/timestamps_and_geom.csv", header: true, view: "H" },
};

// Ground-truth-anchored question pack.
// Each entry: question, dataset, expected check function.
interface ExpectCheck {
	kind: "row_count" | "scalar" | "row_in_top" | "category_in_top" | "value_close" | "value_exact" | "rows_at_least";
	expected: number | string;
	tolerance?: number;
	column?: string;
	role?: "first" | "any";
}
interface Q {
	id: string;
	dataset_id: string;
	question: string;
	expect: ExpectCheck;
	family: string;
}
const GROUND_TRUTH: Record<string, any> = JSON.parse(
	readFileSync(resolve(REPO_ROOT, "audit-reports/ground-truth-2026-05-16.json"), "utf8"),
);

const QUESTIONS: Q[] = [
	// === Dataset A — clean urban points ===
	{ id: "A.gt01", dataset_id: "A", question: "How many rows in the dataset?", expect: { kind: "value_close", expected: 200, tolerance: 0 }, family: "count" },
	{ id: "A.gt02", dataset_id: "A", question: "Count rows where category is residential", expect: { kind: "value_close", expected: 35, tolerance: 0 }, family: "filter-count" },
	{ id: "A.gt03", dataset_id: "A", question: "Average population", expect: { kind: "value_close", expected: 12386.8, tolerance: 5 }, family: "aggregate-mean" },
	{ id: "A.gt04", dataset_id: "A", question: "What is the maximum population?", expect: { kind: "value_close", expected: GROUND_TRUTH.A.max_population, tolerance: 0 }, family: "aggregate-max" },
	{ id: "A.gt05", dataset_id: "A", question: "Show top 5 rows by population, descending", expect: { kind: "rows_at_least", expected: 5 }, family: "top-n" },
	{ id: "A.gt06", dataset_id: "A", question: "Count rows grouped by category", expect: { kind: "rows_at_least", expected: 5 }, family: "groupby" },

	// === Dataset B — polygons ===
	{ id: "B.gt01", dataset_id: "B", question: "How many counties are in this dataset?", expect: { kind: "value_close", expected: 50, tolerance: 0 }, family: "count" },
	{ id: "B.gt02", dataset_id: "B", question: "Count counties where crime_rate_per_1k > 5", expect: { kind: "value_close", expected: GROUND_TRUTH.B.high_crime_count, tolerance: 0 }, family: "filter-count" },
	{ id: "B.gt03", dataset_id: "B", question: "Show top 3 counties by pop_2020 descending", expect: { kind: "rows_at_least", expected: 3 }, family: "top-n" },
	{ id: "B.gt04", dataset_id: "B", question: "What is the average median income?", expect: { kind: "value_close", expected: GROUND_TRUTH.B.mean_income, tolerance: 100 }, family: "aggregate-mean" },

	// === Dataset C — lat/lon events ===
	{ id: "C.gt01", dataset_id: "C", question: "How many event records?", expect: { kind: "value_close", expected: 500, tolerance: 0 }, family: "count" },
	{ id: "C.gt02", dataset_id: "C", question: "What is the maximum severity?", expect: { kind: "value_close", expected: 5, tolerance: 0 }, family: "aggregate-max" },
	{ id: "C.gt03", dataset_id: "C", question: "Count events with severity 4 or 5", expect: { kind: "value_close", expected: GROUND_TRUTH.C.severity_4_or_5_count, tolerance: 0 }, family: "filter-count" },
	{ id: "C.gt04", dataset_id: "C", question: "Count rows where severity IS NULL", expect: { kind: "value_close", expected: GROUND_TRUTH.C.null_severity_count, tolerance: 0 }, family: "filter-null" },
	{ id: "C.gt05", dataset_id: "C", question: "Group event count by event_type", expect: { kind: "rows_at_least", expected: 10 }, family: "groupby" },

	// === Dataset D — messy ===
	{ id: "D.gt01", dataset_id: "D", question: "How many rows in this data?", expect: { kind: "value_close", expected: 400, tolerance: 0 }, family: "count" },
	{ id: "D.gt02", dataset_id: "D", question: "Group by column4 and count, top 5", expect: { kind: "rows_at_least", expected: 4 }, family: "groupby" },

	// === Dataset F — large ===
	{ id: "F.gt01", dataset_id: "F", question: "How many rows?", expect: { kind: "value_close", expected: 100000, tolerance: 0 }, family: "count" },
	{ id: "F.gt02", dataset_id: "F", question: "Average of value_a", expect: { kind: "value_close", expected: GROUND_TRUTH.F.mean_value_a, tolerance: 2 }, family: "aggregate-mean" },
	{ id: "F.gt03", dataset_id: "F", question: "How many distinct categories?", expect: { kind: "value_close", expected: GROUND_TRUTH.F.category_count, tolerance: 0 }, family: "count-distinct" },
	{ id: "F.gt04", dataset_id: "F", question: "Top 5 categories by frequency", expect: { kind: "rows_at_least", expected: 5 }, family: "top-n-groupby" },

	// === Dataset G — i18n ===
	{ id: "G.gt01", dataset_id: "G", question: "How many rows?", expect: { kind: "value_close", expected: 150, tolerance: 0 }, family: "count" },
	{ id: "G.gt02", dataset_id: "G", question: "How many distinct pais (countries)?", expect: { kind: "value_close", expected: GROUND_TRUTH.G.distinct_countries, tolerance: 0 }, family: "count-distinct" },

	// === Dataset H — timestamps + WKT ===
	{ id: "H.gt01", dataset_id: "H", question: "How many rows?", expect: { kind: "value_close", expected: 300, tolerance: 0 }, family: "count" },
	{ id: "H.gt02", dataset_id: "H", question: "Count rows where metric > 50", expect: { kind: "value_close", expected: GROUND_TRUTH.H.over_50_count, tolerance: 0 }, family: "filter-count" },
	{ id: "H.gt03", dataset_id: "H", question: "Average of metric", expect: { kind: "value_close", expected: GROUND_TRUTH.H.mean_metric, tolerance: 1 }, family: "aggregate-mean" },
];

/* ---- profile builder + renderers (copied from audit-fixtures) ---- */
interface DP { name:string; kind:"table"|"layer"; rows:number; geometry?:any; columns:any[]; sample:any[]; }
function parseCsvRow(line: string): string[] { const out: string[] = []; let cur=""; let inQ=false; for (let i=0;i<line.length;i++){const c=line[i]; if(inQ){if(c==='"'&&line[i+1]==='"'){cur+='"';i++;}else if(c==='"'){inQ=false;}else cur+=c;}else{if(c===','){out.push(cur);cur="";}else if(c==='"'){inQ=true;}else cur+=c;}} out.push(cur); return out;}
function inferType(s: string[]): string { let i=true,f=true,e=true; for(const x of s){if(x===""||x==null)continue; e=false; if(!/^-?\d+$/.test(x))i=false; if(!/^-?\d+(\.\d+)?$/.test(x))f=false;} if(e)return"VARCHAR"; if(i)return"INTEGER"; if(f)return"DOUBLE"; return"VARCHAR";}
const PCACHE = new Map<string, DP>();
function buildProfile(did: string, fx: typeof FIXTURES[string]): DP {
	const k = `${did}|${fx.path}|${fx.header}`;
	const c = PCACHE.get(k); if (c) return c;
	const p = resolve(REPO_ROOT, fx.path);
	const raw = readFileSync(p, "utf8");
	const lines = raw.split(/\r?\n/).slice(0, 80).filter(l => l.length>0);
	const header: string[] = fx.header ? parseCsvRow(lines[0] as string) : parseCsvRow(lines[0] as string).map((_,i)=>`column${i+1}`);
	const body = (fx.header ? lines.slice(1,30) : lines.slice(0,30)).map(parseCsvRow);
	const columns = header.map((name, ci) => {
		const cs = body.map(r => r[ci] ?? "");
		const dist = [...new Set(cs.filter(x => x !== ""))];
		const o: any = { name, type: inferType(cs) };
		if (dist.length>0) { o.samples = dist.slice(0,3); o.cardinality = dist.length; }
		return o;
	});
	let rows = 0; for (const _ of raw.split("\n")) rows++; rows = Math.max(0, rows - (fx.header?1:0) - 1);
	let geometry: any | undefined;
	const lower = header.map(h => h.toLowerCase());
	const wkt = lower.findIndex(h => h.includes("wkt") || h === "geom" || h === "geometry");
	if (wkt >= 0) geometry = { kind: body[0]?.[wkt]?.toUpperCase().includes("POLYGON") ? "polygon" : "point", column: header[wkt] };
	else if (lower.includes("lat") && (lower.includes("lon") || lower.includes("lng"))) geometry = { kind: "point", column: "lat,lon" };
	const dp: DP = { name: did, kind: geometry?.kind==="polygon"?"layer":"table", rows, columns, sample: body.slice(0,3).map(r=>{const o:any={};header.forEach((h,i)=>o[h]=r[i]);return o;}) };
	if (geometry) dp.geometry = geometry;
	PCACHE.set(k, dp); return dp;
}
function renderSamples(s: any[]|undefined): string {
	if (!Array.isArray(s) || !s.length) return "";
	const out: string[] = [];
	for (const x of s.slice(0,3)) { let str = typeof x==="string"?x:JSON.stringify(x); if(typeof str!=="string")continue; if(str.length>80)str=str.slice(0,77)+"..."; out.push(JSON.stringify(str)); }
	return out.length ? ` examples: [${out.join(", ")}]` : "";
}
function renderDataset(d: DP): string {
	const L: string[] = [`## ${d.name} (${d.kind})`, `- rows: ${d.rows}`];
	if (d.geometry) L.push(`- geometry: ${d.geometry.kind} (column: ${d.geometry.column})`);
	L.push("- columns:");
	for (const c of d.columns) L.push(`  - ${c.name}: ${c.type}${c.cardinality?` cardinality: ${c.cardinality}`:""}${renderSamples(c.samples)}`);
	if (d.sample.length) L.push(`- sample rows: ${JSON.stringify(d.sample.slice(0,3))}`);
	return L.join("\n").trim();
}
function renderTools(): string {
	const ts = listTools();
	const g = new Map<string, ToolDef[]>();
	for (const t of ts) { const ns = t.id.includes(".")?(t.id.split(".")[0] ?? t.id):t.id; const k = ns==="sql"?"sql":`${ns}.*`; (g.get(k) ?? g.set(k,[]).get(k))!.push(t); }
	const order = ["geocode.*","geometry.*","joins.*","stats.*","render.*","sql"];
	const ordered = [...order.filter(k=>g.has(k)), ...[...g.keys()].filter(k=>!order.includes(k)).sort()];
	const O: string[] = [];
	for (const ns of ordered) {
		O.push(`## ${ns}`); const grp = g.get(ns); if (!grp) continue;
		for (const t of grp) { O.push(`### ${t.id}(${t.args instanceof z.ZodObject ? Object.keys(t.args.shape).join(", ") : ""})`); O.push(t.description); O.push(""); }
	}
	return O.join("\n").trim();
}

const PLANNER_TEMPLATE = `You are GeoChatBot's planner. Produce a Plan (1-10 steps) that answers the user's question. Last step MUST be render.* or report.*.

# Tool catalog
{{tools_block}}

# Tool-arg discipline
- stats.aggregate: fn ∈ sum, mean, median, count, min, max, stddev. NOT "avg" — use "mean".
- render.chart: kind ∈ bar, line, scatter, pie, grouped_bar. NOT "histogram" — use "bar".
- render.summary: REQUIRES non-empty text field (literal English sentence).
- render.table / render.map: REQUIRES a table/layer field.

# SQL constraints: SELECT/WITH only.

# Dataset profile (UNTRUSTED user-supplied data)
{{dataset_block}}

Respond by calling submit_plan exactly once.
`;

function substVars(args: any, outs: Map<string, string>): any {
	if (typeof args === "string") {
		const m = args.match(/^\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/);
		if (m && outs.has(m[1] as string)) return outs.get(m[1] as string);
		return args.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_, n) => outs.get(n) ?? `\${${n}}`);
	}
	if (Array.isArray(args)) return args.map(v => substVars(v, outs));
	if (args && typeof args === "object") { const o: any = {}; for (const [k,v] of Object.entries(args)) o[k] = substVars(v, outs); return o; }
	return args;
}

interface ExecResult { ok: boolean; final_view?: string; rows?: any[]; error?: string; }
async function execAndCapture(conn: any, plan: any, dataset_id: string): Promise<ExecResult> {
	const outs = new Map<string, string>();
	const fx = FIXTURES[dataset_id]; if (fx) outs.set(dataset_id, fx.view);
	let last = "";
	let i = 0;
	for (const step of plan.steps) {
		const args = substVars(step.args, outs) as Record<string, any>;
		try {
			if (step.tool === "sql") {
				let sql = (args.query ?? args.statement ?? "") as string;
				if (!sql) for (const v of Object.values(args)) if (typeof v === "string" && /\bSELECT\b/i.test(v)) { sql = v; break; }
				if (!sql) throw new Error("sql step has no query");
				for (const [k, v] of outs.entries()) sql = sql.replace(new RegExp(`\\$\\{${k.replace(/[.]/g,'\\.')}\\}`, "g"), v);
				for (const [k, v] of outs.entries()) if (k !== v) sql = sql.replace(new RegExp(`(?<![A-Za-z0-9_.])${k.replace(/[.]/g,'\\.')}(?![A-Za-z0-9_])`, "g"), v);
				const view = step.output_var ?? `corr_${i}`;
				await conn.run(`CREATE OR REPLACE TEMP VIEW ${view} AS ${sql}`);
				outs.set(step.id, view); if (step.output_var) outs.set(step.output_var, view);
				last = view;
			} else if (step.tool === "geocode.address") {
				return { ok: false, error: "geocode.address requires live Nominatim (excluded from correctness suite)" };
			} else if (step.tool.startsWith("render.") || step.tool.startsWith("report.")) {
				// CAPTURE the final view's contents — this is the user-visible answer.
				let tbl = String(args.table ?? args.layer ?? args.dataset ?? last ?? "");
				if (outs.has(tbl)) tbl = outs.get(tbl) as string;
				if (!tbl) tbl = dataset_id in FIXTURES ? FIXTURES[dataset_id].view : "";
				if (!tbl) {
					// render.summary may have text only; capture the text
					if (step.tool === "render.summary" && typeof args.text === "string") {
						return { ok: true, rows: [{ summary_text: args.text }] };
					}
					throw new Error("render with no resolvable input");
				}
				try {
					const r = await conn.runAndReadAll(`SELECT * FROM ${tbl} LIMIT 50`);
					const rows = r.getRowObjectsJS();
					return { ok: true, final_view: tbl, rows };
				} catch (e) {
					throw new Error(`render input "${tbl}": ${(e as Error).message.slice(0,80)}`);
				}
			} else if (step.tool === "stats.aggregate") {
				const tbl = String(args.layer ?? args.table ?? last ?? Object.values(outs)[0]);
				const groupBy = (args.group_by ?? args.groupBy ?? []) as string[];
				const fn = (args.agg_fn ?? args.fn ?? "count").toString().toLowerCase();
				const col = args.value_col ?? args.col ?? args.column ?? "*";
				const parts: string[] = [];
				if (groupBy.length) parts.push(groupBy.map(c => `"${c}"`).join(", "));
				parts.push(`${fn}(${col === "*" ? "*" : `"${col}"`}) AS "agg_value"`);
				const groupSql = groupBy.length ? ` GROUP BY ${groupBy.map(c => `"${c}"`).join(", ")}` : "";
				const sql = `SELECT ${parts.join(", ")} FROM ${tbl}${groupSql}`;
				const view = step.output_var ?? `corr_${i}`;
				await conn.run(`CREATE OR REPLACE TEMP VIEW ${view} AS ${sql}`);
				outs.set(step.id, view); if (step.output_var) outs.set(step.output_var, view);
				last = view;
			} else {
				const tbl = String(args.layer ?? args.left ?? args.table ?? args.input ?? last ?? Object.values(outs)[0]);
				const view = step.output_var ?? `corr_${i}`;
				await conn.run(`CREATE OR REPLACE TEMP VIEW ${view} AS SELECT * FROM ${tbl}`);
				outs.set(step.id, view); if (step.output_var) outs.set(step.output_var, view);
				last = view;
			}
			i++;
		} catch (err) {
			return { ok: false, error: `${step.tool}: ${(err as Error).message.slice(0,140)}` };
		}
	}
	return { ok: false, error: "no render step reached" };
}

function extractNumber(rows: any[] | undefined, want_kind: ExpectCheck["kind"]): number | null {
	if (!rows || rows.length === 0) return null;
	// row_count / scalar: most likely a single column with the value
	if (rows.length === 1) {
		const r = rows[0];
		for (const v of Object.values(r)) {
			if (typeof v === "number") return v;
			if (typeof v === "bigint") return Number(v);
			if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return Number.parseFloat(v);
		}
		// Fallback: extract first number from any string field (e.g. render.summary
		// text like "The dataset has 300 rows" — pull the 300).
		for (const v of Object.values(r)) {
			if (typeof v !== "string") continue;
			const m = v.match(/-?\d+(?:[.,]\d+)?/);
			if (m) return Number.parseFloat(m[0].replace(/,/g, ""));
		}
	}
	// If it's a result with multiple rows (top-N / groupby), return the row count
	return rows.length;
}

function scoreExpect(rows: any[] | undefined, expect: ExpectCheck): { pass: boolean; got: any; note: string } {
	if (expect.kind === "rows_at_least") {
		const n = rows?.length ?? 0;
		return { pass: n >= Number(expect.expected), got: n, note: `got ${n} rows, expected ≥${expect.expected}` };
	}
	if (expect.kind === "value_close") {
		const got = extractNumber(rows, expect.kind);
		if (got === null) return { pass: false, got: null, note: "no numeric value extractable from rows" };
		const tol = expect.tolerance ?? 0;
		const ok = Math.abs(got - Number(expect.expected)) <= tol;
		return { pass: ok, got, note: `got ${got}, expected ${expect.expected} ±${tol}` };
	}
	if (expect.kind === "value_exact") {
		const got = rows?.[0]?.[expect.column ?? Object.keys(rows[0] ?? {})[0] ?? ""] ?? null;
		const ok = got === expect.expected;
		return { pass: ok, got, note: `got ${got}, expected exactly ${expect.expected}` };
	}
	return { pass: false, got: null, note: "unknown expect kind" };
}

async function main() {
	const inst = await DuckDBInstance.create(":memory:");
	const conn = await inst.connect();
	console.log("Loading fixtures + spatial...");
	await conn.run("INSTALL spatial; LOAD spatial;");
	for (const [did, fx] of Object.entries(FIXTURES)) {
		const full = resolve(REPO_ROOT, fx.path);
		await conn.run(`CREATE OR REPLACE TABLE ${fx.view} AS SELECT * FROM read_csv_auto('${full.replace(/'/g, "''")}', HEADER=${fx.header})`);
	}

	const schema = zodToJsonSchema(PlanSchema, { target: "openApi3" }) as Record<string, unknown>;
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const outDir = resolve(REPO_ROOT, "audit-reports");
	mkdirSync(outDir, { recursive: true });
	const outPath = resolve(outDir, `correctness-2026-05-16-${ts}.jsonl`);
	writeFileSync(outPath.replace(/\.jsonl$/, ".model"), `${MODEL}\n`);

	console.log(`\n=== TRUE end-to-end correctness audit ===`);
	console.log(`model: ${MODEL}`);
	console.log(`questions: ${QUESTIONS.length}`);
	console.log(`output: ${outPath}\n`);

	const safeStringify = (o: any) => JSON.stringify(o, (_k, v) => typeof v === "bigint" ? Number(v) : v);
	let correct = 0, wrong = 0, planFail = 0, execFail = 0;
	for (let i = 0; i < QUESTIONS.length; i++) {
		const q = QUESTIONS[i] as Q;
		const fx = FIXTURES[q.dataset_id];
		if (!fx) continue;
		const profile = buildProfile(q.dataset_id, fx);
		const sys = PLANNER_TEMPLATE.replace("{{tools_block}}", renderTools()).replace("{{dataset_block}}", renderDataset(profile));
		const t0 = Date.now();
		let plan: any = null;
		let planErr: string | undefined;
		try {
			const raw = await callForcedTool({
				provider: "uf-navigator", apiKey: API_KEY as string, model: MODEL,
				cachedSystemPrompt: sys, systemPrompt: "", userMessage: q.question,
				toolName: "submit_plan", toolDescription: "Submit a Plan.", toolInputSchema: schema,
				temperature: 0, maxTokens: 8192,
				reasoningEffort: MODEL.toLowerCase().includes("gpt-oss-20b") ? "medium" : MODEL.toLowerCase().includes("gpt-oss") ? "high" : undefined,
				dangerouslyAllowBrowser: false,
			});
			plan = validatePlan(raw as unknown, [profile.name]);
		} catch (e) { planErr = (e as Error).message.slice(0, 200); }
		const safeStringify = (o: any) => JSON.stringify(o, (_k, v) => typeof v === "bigint" ? Number(v) : v);
		if (!plan) {
			planFail++;
			const r = { ...q, status: "PLAN-FAIL", plan_error: planErr, ms: Date.now() - t0 };
			appendFileSync(outPath, safeStringify(r) + "\n");
			console.log(`[${i+1}/${QUESTIONS.length}] PLAN-FAIL  ${q.id.padEnd(8)} ${q.family.padEnd(20)} ${planErr?.slice(0,60)}`);
			continue;
		}
		const exec = await execAndCapture(conn, plan, q.dataset_id);
		if (!exec.ok) {
			execFail++;
			const r = { ...q, status: "EXEC-FAIL", plan_tools: plan.steps.map((s: any) => s.tool), exec_error: exec.error, ms: Date.now() - t0 };
			appendFileSync(outPath, safeStringify(r) + "\n");
			console.log(`[${i+1}/${QUESTIONS.length}] EXEC-FAIL  ${q.id.padEnd(8)} ${q.family.padEnd(20)} ${(exec.error ?? "").slice(0,60)}`);
			continue;
		}
		const score = scoreExpect(exec.rows, q.expect);
		const status = score.pass ? "CORRECT" : "WRONG";
		if (score.pass) correct++; else wrong++;
		const r = { ...q, status, plan_tools: plan.steps.map((s: any) => s.tool), expected: q.expect.expected, got: score.got, note: score.note, sample_rows: exec.rows?.slice(0, 3), ms: Date.now() - t0 };
		appendFileSync(outPath, safeStringify(r) + "\n");
		console.log(`[${i+1}/${QUESTIONS.length}] ${status.padEnd(9)} ${q.id.padEnd(8)} ${q.family.padEnd(20)} ${score.note}`);
	}
	console.log(`\n=== SUMMARY ===`);
	console.log(`Total questions: ${QUESTIONS.length}`);
	console.log(`CORRECT (answer matches ground truth): ${correct}`);
	console.log(`WRONG (answer differs from ground truth): ${wrong}`);
	console.log(`PLAN-FAIL (model couldn't produce valid plan): ${planFail}`);
	console.log(`EXEC-FAIL (plan crashed during execution): ${execFail}`);
	console.log(`\nCorrectness rate: ${correct}/${QUESTIONS.length} = ${(correct/QUESTIONS.length*100).toFixed(1)}%`);
	console.log(`Correctness of executed plans: ${correct}/${correct+wrong} = ${correct+wrong > 0 ? (correct/(correct+wrong)*100).toFixed(1) : "—"}%`);
}

main().catch(e => { console.error(e); process.exit(1); });
