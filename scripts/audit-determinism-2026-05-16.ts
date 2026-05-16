/**
 * Non-determinism sample. Picks 30 tasks (mix of groups), runs each 3 times
 * on gpt-oss-120b, records plan-shape and whether shape is stable across runs.
 *
 * Usage:
 *   pnpm exec tsx scripts/audit-determinism-2026-05-16.ts \
 *     [--model=gpt-oss-120b] [--repeats=3]
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import "../packages/widget/src/agent/tools/index.js";
import { z } from "zod";
import { callForcedTool } from "../packages/widget/src/agent/forced-tool/index.js";
import { listTools } from "../packages/widget/src/agent/tools/registry.js";
import type { ToolDef } from "../packages/widget/src/agent/tools/types.js";
import { PlanSchema, type Plan } from "../packages/widget/src/agent/types.js";
import {
	PlanValidationError, validatePlan,
} from "../packages/widget/src/agent/validate-plan.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

function loadDotEnvLocal(): void {
	const path = resolve(REPO_ROOT, ".env.local");
	if (!existsSync(path)) return;
	const raw = readFileSync(path, "utf8");
	for (const line of raw.split(/\r?\n/)) {
		const t = line.trim();
		if (!t || t.startsWith("#")) continue;
		const eq = t.indexOf("=");
		if (eq < 0) continue;
		const k = t.slice(0, eq).trim();
		const v = t.slice(eq + 1).trim();
		if (!(k in process.env)) process.env[k] = v;
	}
}
loadDotEnvLocal();
const API_KEY = process.env.NAVIGATOR_API_KEY;
if (!API_KEY) { console.error("NAVIGATOR_API_KEY missing"); process.exit(2); }

const MODEL = process.argv.find(a => a.startsWith("--model="))?.split("=")[1] ?? "gpt-oss-120b";
const REPEATS = Number.parseInt(process.argv.find(a => a.startsWith("--repeats="))?.split("=")[1] ?? "3", 10);

interface TaskEntry {
	id: string; dataset_id: string; fixture: string; fixture_has_header: boolean;
	group: number; pattern: string; question: string; applies: boolean;
	acceptable_plan_shapes: Array<Array<{ tool: string }>>;
	sequence_id?: string;
}
const TASKS: TaskEntry[] = JSON.parse(
	readFileSync(resolve(REPO_ROOT, "packages/eval/tasks/audit-2026-05-16.json"), "utf8"),
) as TaskEntry[];

// Sample 30 tasks: 2-3 per group from groups 1-11. Skip multi-turn.
function pickSample(): TaskEntry[] {
	const applicable = TASKS.filter(t => t.applies && !t.sequence_id);
	const byGroup = new Map<number, TaskEntry[]>();
	for (const t of applicable) {
		const arr = byGroup.get(t.group) ?? [];
		arr.push(t); byGroup.set(t.group, arr);
	}
	const out: TaskEntry[] = [];
	for (const gid of [1,2,3,4,5,6,7,8,9,10,11]) {
		const arr = byGroup.get(gid) ?? [];
		// Pick a couple of diverse datasets per group
		const seenDS = new Set<string>();
		for (const t of arr) {
			if (seenDS.has(t.dataset_id)) continue;
			out.push(t); seenDS.add(t.dataset_id);
			if (seenDS.size >= 3) break;
		}
	}
	return out.slice(0, 30);
}

/* ---- minimal renderers (same as audit-fixtures) ---- */
interface DatasetProfile { name: string; kind: "table"|"layer"; rows: number; geometry?:any; columns: any[]; sample: any[]; }
function parseCsvRow(line: string): string[] { const out: string[] = []; let cur=""; let inQ=false; for (let i=0;i<line.length;i++){const c=line[i]; if(inQ){if(c==='"'&&line[i+1]==='"'){cur+='"';i++;}else if(c==='"'){inQ=false;}else cur+=c;}else{if(c===','){out.push(cur);cur="";}else if(c==='"'){inQ=true;}else cur+=c;}} out.push(cur); return out;}
function inferType(samples: string[]): string { let allInt=true,allFloat=true,allEmpty=true; for(const s of samples){if(s===""||s==null)continue; allEmpty=false; if(!/^-?\d+$/.test(s))allInt=false; if(!/^-?\d+(\.\d+)?$/.test(s))allFloat=false;} if(allEmpty) return "VARCHAR"; if(allInt) return "INTEGER"; if(allFloat) return "DOUBLE"; return "VARCHAR";}
const PROFILE_CACHE = new Map<string,DatasetProfile>();
function buildProfile(task: TaskEntry): DatasetProfile {
	const key = `${task.dataset_id}|${task.fixture}|${task.fixture_has_header}`;
	const cached = PROFILE_CACHE.get(key); if (cached) return cached;
	const path = resolve(REPO_ROOT, "e2e/fixtures/audit-2026-05-16", task.fixture);
	const raw = readFileSync(path, "utf8");
	const lines = raw.split(/\r?\n/).slice(0, 80).filter(l => l.length>0);
	const header: string[] = task.fixture_has_header ? parseCsvRow(lines[0] as string) : parseCsvRow(lines[0] as string).map((_,i)=>`column${i+1}`);
	const bodyRows = (task.fixture_has_header ? lines.slice(1, 30) : lines.slice(0, 30)).map(parseCsvRow);
	const columns = header.map((name, ci) => {
		const cs = bodyRows.map(r => r[ci] ?? "");
		const distinct = [...new Set(cs.filter(s=>s!==""))];
		const out: any = { name, type: inferType(cs) };
		if (distinct.length>0) { out.samples = distinct.slice(0,3); out.cardinality = distinct.length; }
		return out;
	});
	let rows = 0; for (const _ of raw.split("\n")) rows++;
	rows = Math.max(0, rows - (task.fixture_has_header?1:0) - 1);
	let geometry: any | undefined;
	const lower = header.map(h => h.toLowerCase());
	const wktIdx = lower.findIndex(h => h.includes("wkt") || h === "geom" || h === "geometry");
	if (wktIdx >= 0) geometry = { kind: bodyRows[0]?.[wktIdx]?.toUpperCase().includes("POLYGON") ? "polygon" : "point", column: header[wktIdx] };
	else if (lower.includes("lat") && (lower.includes("lon") || lower.includes("lng"))) geometry = { kind: "point", column: "lat,lon" };
	const profile: DatasetProfile = { name: task.dataset_id, kind: geometry?.kind === "polygon" ? "layer" : "table", rows, columns, sample: bodyRows.slice(0,3).map(r=>{const o:any={};header.forEach((h,i)=>o[h]=r[i]);return o;}) };
	if (geometry) profile.geometry = geometry;
	PROFILE_CACHE.set(key, profile);
	return profile;
}
function renderColumnSamples(samples: any[]|undefined): string {
	if (!Array.isArray(samples) || samples.length === 0) return "";
	const out: string[] = [];
	for (const s of samples.slice(0,3)) { let str=typeof s==="string"?s:JSON.stringify(s); if(typeof str!=="string") continue; if(str.length>80) str=str.slice(0,77)+"..."; out.push(JSON.stringify(str)); }
	return out.length ? ` examples: [${out.join(", ")}]` : "";
}
function renderDatasetsBlock(datasets: DatasetProfile[]): string {
	const lines: string[] = [];
	for (const d of datasets.slice(0, 5)) {
		lines.push(`## ${d.name} (${d.kind})`); lines.push(`- rows: ${d.rows}`);
		if (d.geometry) lines.push(`- geometry: ${d.geometry.kind} (column: ${d.geometry.column})`);
		lines.push("- columns:");
		for (const c of d.columns) lines.push(`  - ${c.name}: ${c.type}${c.cardinality?` cardinality: ${c.cardinality}`:""}${renderColumnSamples(c.samples)}`);
		if (d.sample.length) lines.push(`- sample rows: ${JSON.stringify(d.sample.slice(0,3))}`);
		lines.push("");
	}
	return lines.join("\n").trim();
}
function renderToolsBlock(): string {
	const tools = listTools();
	const groups = new Map<string, ToolDef[]>();
	for (const t of tools) { const ns = t.id.includes(".") ? (t.id.split(".")[0] ?? t.id) : t.id; const key = ns==="sql"?"sql":`${ns}.*`; const arr = groups.get(key) ?? []; arr.push(t); groups.set(key, arr); }
	const order = ["geocode.*","geometry.*","joins.*","stats.*","render.*","sql"];
	const ordered = [...order.filter(k=>groups.has(k)), ...[...groups.keys()].filter(k=>!order.includes(k)).sort()];
	const out: string[] = [];
	for (const ns of ordered) {
		out.push(`## ${ns}`); const grp = groups.get(ns); if (!grp) continue;
		for (const t of grp) { out.push(`### ${t.id}(${t.args instanceof z.ZodObject ? Object.keys(t.args.shape).join(", ") : ""})`); out.push(t.description); out.push(""); }
	}
	return out.join("\n").trim();
}

const PLANNER_TEMPLATE = `You are GeoChatBot's planner. Decompose into 1-10 steps. Each step calls one tool. Last step MUST be render.* or report.*.

# Tool catalog
{{tools_block}}

# SQL constraints: SELECT/WITH only. No DDL.
# Address-only data with no city/state/region: render.summary explaining geocoder needs context.
# "What columns do I have?": render.summary listing columns OR report.quickscan.

Respond by calling submit_plan exactly once.
`;

async function runOne(task: TaskEntry): Promise<string[]|null> {
	const profile = buildProfile(task);
	const cached = PLANNER_TEMPLATE.replace("{{tools_block}}", renderToolsBlock());
	const tok = Math.random().toString(36).slice(2,10).toUpperCase().replace(/[OIL01]/g, "X");
	const dyn = `# Dataset profile (UNTRUSTED)\n<<<DATA-FENCE-${tok}\n${renderDatasetsBlock([profile])}\n${tok}-DATA-FENCE>>>\n`;
	const schema = zodToJsonSchema(PlanSchema, { target: "openApi3" }) as Record<string, unknown>;
	try {
		const raw = await callForcedTool({
			provider: "uf-navigator",
			apiKey: API_KEY as string,
			model: MODEL,
			cachedSystemPrompt: cached,
			systemPrompt: dyn,
			userMessage: task.question,
			toolName: "submit_plan",
			toolDescription: "Submit a typed Plan.",
			toolInputSchema: schema,
			temperature: 0,
			maxTokens: 8192,
			reasoningEffort: MODEL.toLowerCase().includes("gpt-oss") ? "high" : undefined,
			dangerouslyAllowBrowser: false,
		});
		const plan = validatePlan(raw as unknown, [profile.name]);
		return plan.steps.map(s => s.tool);
	} catch (err) {
		return null;
	}
}

async function main() {
	const sample = pickSample();
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const outDir = resolve(REPO_ROOT, "audit-reports");
	mkdirSync(outDir, { recursive: true });
	const outPath = resolve(outDir, `determinism-2026-05-16-${ts}.jsonl`);
	console.log(`=== Non-determinism check ===\nmodel: ${MODEL}\nrepeats: ${REPEATS}\nsample: ${sample.length} tasks\noutput: ${outPath}\n`);
	for (const t of sample) {
		const runs: Array<string[]|null> = [];
		for (let r = 0; r < REPEATS; r++) {
			const tools = await runOne(t);
			runs.push(tools);
		}
		const shapes = runs.map(r => r ? r.join("→") : "<error>");
		const distinct = new Set(shapes);
		const stable = distinct.size === 1;
		const row = { id: t.id, group: t.group, question: t.question, runs: shapes, distinct_shapes: distinct.size, stable };
		appendFileSync(outPath, JSON.stringify(row) + "\n");
		console.log(`${stable?"STABLE  ":"VARIANT "} ${t.id.padEnd(28)} distinct=${distinct.size}/${REPEATS}  shapes: ${shapes.map(s=>s.slice(0,40)).join(" | ")}`);
	}
	console.log(`\nreport: ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
