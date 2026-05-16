/**
 * Agentic-mode sweep — wires up DuckDB + InspectionRunCtx so the
 * agentic ReAct loop can call inspect tools live during planning.
 *
 * Tests the production "agentic" toggle in the settings drawer, which
 * runs the loop in agent/agentic/loop.ts. The loop:
 *   1. Reasons about the data via inspect.sample_rows / distinct_values / etc.
 *   2. Calls finalize_plan once it has enough context.
 *
 * Sample size: 50 tasks across all 8 datasets (limited by API budget).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";
import { tableFromJSON, Table as ArrowTable } from "apache-arrow";
import "../packages/widget/src/agent/tools/index.js";
import { runAgentLoop } from "../packages/widget/src/agent/agentic/loop.js";
import type { InspectionRunCtx } from "../packages/widget/src/agent/agentic/inspect-runners.js";
import type { DatasetEntry, ExecutorEngine } from "../packages/widget/src/agent/executor/types.js";
import { AGENTIC_PREAMBLE } from "../packages/widget/src/agent/prompts/agentic-preamble.js";
import { listTools } from "../packages/widget/src/agent/tools/registry.js";
import type { ToolDef } from "../packages/widget/src/agent/tools/types.js";
import { PlanValidationError, validatePlan } from "../packages/widget/src/agent/validate-plan.js";
import { z } from "zod";

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
const LIMIT = Number.parseInt(process.argv.find(a => a.startsWith("--limit="))?.split("=")[1] ?? "50", 10);
const ENDPOINT = "https://api.ai.it.ufl.edu/v1/chat/completions";

const FIXTURES: Record<string, { path: string; header: boolean; view: string }> = {
	"A":       { path: "e2e/fixtures/audit-2026-05-16/clean_urban_points.csv",    header: true,  view: "A" },
	"B":       { path: "e2e/fixtures/audit-2026-05-16/mixed_geometry_polygons.csv", header: true, view: "B" },
	"C":       { path: "e2e/fixtures/audit-2026-05-16/latlon_with_dates.csv",     header: true,  view: "C" },
	"D":       { path: "e2e/fixtures/audit-2026-05-16/messy_real_world.csv",      header: false, view: "D" },
	"E.one":   { path: "e2e/fixtures/audit-2026-05-16/tiny/one_row.csv",          header: true,  view: "E_one" },
	"E.empty": { path: "e2e/fixtures/audit-2026-05-16/tiny/header_only.csv",      header: true,  view: "E_empty" },
	"F":       { path: "e2e/fixtures/audit-2026-05-16/huge_performance.csv",      header: true,  view: "F" },
	"G":       { path: "e2e/fixtures/audit-2026-05-16/international_unicode.csv", header: true,  view: "G" },
	"H":       { path: "e2e/fixtures/audit-2026-05-16/timestamps_and_geom.csv",   header: true,  view: "H" },
};

interface TaskEntry {
	id: string; dataset_id: string; fixture: string; fixture_has_header: boolean;
	group: number; pattern: string; question: string; applies: boolean;
	acceptable_plan_shapes: Array<Array<{ tool: string }>>;
	sequence_id?: string;
}
const TASKS: TaskEntry[] = JSON.parse(
	readFileSync(resolve(REPO_ROOT, "packages/eval/tasks/audit-2026-05-16.json"), "utf8"),
) as TaskEntry[];

/** Wrap @duckdb/node-api as the widget's ExecutorEngine. */
function makeEngine(conn: Awaited<ReturnType<DuckDBInstance["connect"]>>): ExecutorEngine {
	return {
		hasSpatial: true,
		async query(sql: string): Promise<ArrowTable> {
			const reader = await conn.runAndReadAll(sql);
			const rows = reader.getRowObjectsJS();
			// Convert decimals + bigints to numbers for downstream consumers.
			const cleaned = rows.map((r: any) => {
				const o: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(r)) {
					if (typeof v === "bigint") o[k] = Number(v);
					else if (v && typeof v === "object" && (v as any).value !== undefined && (v as any).scale !== undefined) {
						o[k] = Number((v as any).value) / Math.pow(10, (v as any).scale);
					} else o[k] = v;
				}
				return o;
			});
			return tableFromJSON(cleaned.length ? cleaned : [{}]);
		},
	};
}

function renderToolsBlock(): string {
	const tools = listTools();
	const groups = new Map<string, ToolDef[]>();
	for (const t of tools) { const ns = t.id.includes(".") ? (t.id.split(".")[0] ?? t.id) : t.id; const key = ns==="sql"?"sql":`${ns}.*`; (groups.get(key) ?? groups.set(key,[]).get(key))!.push(t); }
	const order = ["geocode.*","geometry.*","joins.*","stats.*","render.*","sql"];
	const ordered = [...order.filter(k=>groups.has(k)), ...[...groups.keys()].filter(k=>!order.includes(k)).sort()];
	const out: string[] = [];
	for (const ns of ordered) {
		out.push(`## ${ns}`); const grp = groups.get(ns); if (!grp) continue;
		for (const t of grp) { out.push(`### ${t.id}(${t.args instanceof z.ZodObject ? Object.keys(t.args.shape).join(", ") : ""})`); out.push(t.description); out.push(""); }
	}
	return out.join("\n").trim();
}

interface DP { name: string; rowCount: number; columnHints: string; }
function buildDatasetHint(fx: { path: string; header: boolean; view: string }): DP {
	const raw = readFileSync(resolve(REPO_ROOT, fx.path), "utf8");
	const lines = raw.split(/\r?\n/).slice(0, 30).filter(l => l.length > 0);
	const header: string[] = fx.header
		? (lines[0]?.split(",") ?? []).map(c => c.replace(/^"|"$/g, ""))
		: (lines[0]?.split(",") ?? []).map((_, i) => `column${i + 1}`);
	let rc = 0;
	for (const _ of raw.split("\n")) rc++;
	rc = Math.max(0, rc - (fx.header ? 1 : 0) - 1);
	return { name: fx.view, rowCount: rc, columnHints: header.slice(0, 10).join(", ") };
}

async function loadAll(conn: Awaited<ReturnType<DuckDBInstance["connect"]>>): Promise<Map<string, DatasetEntry>> {
	await conn.run("INSTALL spatial; LOAD spatial;");
	const entries = new Map<string, DatasetEntry>();
	for (const [did, fx] of Object.entries(FIXTURES)) {
		const full = resolve(REPO_ROOT, fx.path);
		try {
			await conn.run(`CREATE OR REPLACE TABLE ${fx.view} AS SELECT * FROM read_csv_auto('${full.replace(/'/g, "''")}', HEADER=${fx.header})`);
			// Build a geom view if lat/lon columns exist.
			const cols = await (await conn.runAndReadAll(`PRAGMA table_info(${fx.view})`)).getRowObjectsJS();
			const names = cols.map((c: any) => String(c.name).toLowerCase());
			const hasLatLon = names.includes("lat") && (names.includes("lon") || names.includes("lng"));
			const hasWkt = names.some(n => n.includes("wkt") || n === "geom" || n === "geometry");
			if (hasLatLon) {
				const lonCol = names.includes("lon") ? "lon" : "lng";
				await conn.run(`CREATE OR REPLACE VIEW ${fx.view}_geom AS SELECT *, ST_Point(${lonCol}, lat) AS geom FROM ${fx.view}`);
				entries.set(did, { name: did, tableName: fx.view, geomView: `${fx.view}_geom`, hasGeometry: true });
			} else if (hasWkt) {
				const wkt = cols.find((c: any) => /wkt|geom/i.test(String(c.name))) as any;
				await conn.run(`CREATE OR REPLACE VIEW ${fx.view}_geom AS SELECT *, ST_GeomFromText(${wkt.name}) AS geom FROM ${fx.view}`);
				entries.set(did, { name: did, tableName: fx.view, geomView: `${fx.view}_geom`, hasGeometry: true });
			} else {
				entries.set(did, { name: did, tableName: fx.view, hasGeometry: false });
			}
		} catch (e) {
			console.log(`  fixture ${did} load failed: ${(e as Error).message.slice(0, 80)}`);
			entries.set(did, { name: did, tableName: fx.view, hasGeometry: false });
		}
	}
	return entries;
}

async function runOne(task: TaskEntry, fullCtx: InspectionRunCtx): Promise<{
	id: string; dataset_id: string; group: number; pattern: string;
	status: "PASS" | "FAIL" | "ERR"; plan_tools?: string[]; iterations?: number; error?: string; latency_ms: number;
}> {
	const t0 = Date.now();
	try {
		// Isolate per-task: only the task's dataset is in scope so the model
		// can't accidentally cross-reference another fixture loaded in the
		// same DuckDB instance.
		const taskEntry = fullCtx.datasets.get(task.dataset_id);
		const isolatedDatasets = new Map<string, DatasetEntry>();
		if (taskEntry) isolatedDatasets.set(task.dataset_id, taskEntry);
		const ctx: InspectionRunCtx = { engine: fullCtx.engine, datasets: isolatedDatasets };
		const sys = `${AGENTIC_PREAMBLE}\n\n# Tool catalog\n${renderToolsBlock()}\n\n# Loaded datasets\n- ${task.dataset_id} (use this name in dataset_refs)`;
		let iterations = 0;
		const plan = await runAgentLoop({
			endpoint: ENDPOINT,
			apiKey: API_KEY as string,
			model: MODEL,
			systemPrompt: sys,
			question: task.question,
			ctx,
			maxIterations: 12,
			maxTokensPerCall: 8192,
			dangerouslyAllowBrowser: false,
			onStep: (e) => { iterations = e.iteration; },
		});
		const validated = validatePlan(plan as unknown, [task.dataset_id]);
		const tools = validated.steps.map(s => s.tool);
		// Score against the same plan-shape rubric.
		const acceptable = task.acceptable_plan_shapes ?? [];
		const matched = acceptable.some((sh: Array<{tool:string}>) => {
			let cur = 0;
			for (const e of sh) {
				const idx = tools.indexOf(e.tool, cur);
				if (idx < 0) return false;
				cur = idx + 1;
			}
			return true;
		});
		return {
			id: task.id, dataset_id: task.dataset_id, group: task.group, pattern: task.pattern,
			status: matched ? "PASS" : "FAIL",
			plan_tools: tools, iterations, latency_ms: Date.now() - t0,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			id: task.id, dataset_id: task.dataset_id, group: task.group, pattern: task.pattern,
			status: "ERR", error: msg.slice(0, 180), latency_ms: Date.now() - t0,
		};
	}
}

async function main() {
	const inst = await DuckDBInstance.create(":memory:");
	const conn = await inst.connect();
	console.log("Loading fixtures into DuckDB + building inspection ctx...");
	const datasets = await loadAll(conn);
	const engine = makeEngine(conn);
	const ctx: InspectionRunCtx = { engine, datasets };

	// Pick a balanced sample across groups + datasets.
	const candidates = TASKS.filter(t => t.applies && !t.sequence_id && t.group !== 6 && t.group !== 7);
	const sample: TaskEntry[] = [];
	const seen = new Set<string>();
	for (const t of candidates) {
		const key = `${t.dataset_id}-${t.group}`;
		if (seen.has(key)) continue;
		seen.add(key);
		sample.push(t);
		if (sample.length >= LIMIT) break;
	}

	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const outDir = resolve(REPO_ROOT, "audit-reports");
	mkdirSync(outDir, { recursive: true });
	const outPath = resolve(outDir, `agentic-2026-05-16-${ts}.jsonl`);
	writeFileSync(outPath.replace(/\.jsonl$/, ".model"), `${MODEL}\n`);
	console.log(`=== Agentic-mode sweep ===\nmodel: ${MODEL}\nsample: ${sample.length}\noutput: ${outPath}\n`);

	let pass = 0, fail = 0, err = 0;
	for (let i = 0; i < sample.length; i++) {
		const t = sample[i] as TaskEntry;
		const r = await runOne(t, ctx);
		appendFileSync(outPath, JSON.stringify(r) + "\n");
		if (r.status === "PASS") pass++;
		else if (r.status === "FAIL") fail++;
		else err++;
		const tag = r.status === "PASS" ? "PASS" : r.status === "FAIL" ? "FAIL" : "ERR ";
		const tools = r.plan_tools ? r.plan_tools.join("→").slice(0, 50) : "";
		const iter = r.iterations ? `[${r.iterations}it]` : "";
		console.log(`[${i+1}/${sample.length}] ${tag} ${r.id.padEnd(28)} ${String(r.latency_ms).padStart(6)}ms ${iter.padEnd(8)} ${tools}${r.error ? "  ← " + r.error.slice(0, 60) : ""}`);
	}
	console.log(`\nSUMMARY: total=${sample.length} pass=${pass} fail=${fail} err=${err}  pass_rate=${(pass/sample.length*100).toFixed(1)}%`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
