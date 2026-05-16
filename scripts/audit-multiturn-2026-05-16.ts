/**
 * Multi-turn (M1/M2/M3) harness. Runs each sequence's turns sequentially
 * against the single-shot planner with prior-turn context flattened into
 * the user message. Records per-turn plan + per-sequence success.
 *
 * Not "truly stateful" — the planner doesn't have a message-history
 * interface — but the flattened-prior-context approach is the standard
 * workaround and is what most real chat-style frontends do anyway when
 * the underlying tool-call API is single-shot.
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
import { PlanSchema } from "../packages/widget/src/agent/types.js";
import { PlanValidationError, validatePlan } from "../packages/widget/src/agent/validate-plan.js";

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

interface TaskEntry {
	id: string; dataset_id: string; fixture: string; fixture_has_header: boolean;
	group: number; pattern: string; question: string; applies: boolean;
	acceptable_plan_shapes: Array<Array<{ tool: string }>>;
	sequence_id?: string; turn_index?: number; annotation?: string;
}
const TASKS: TaskEntry[] = JSON.parse(
	readFileSync(resolve(REPO_ROOT, "packages/eval/tasks/audit-2026-05-16.json"), "utf8"),
) as TaskEntry[];

// Group multi-turn entries by sequence.
const SEQS = new Map<string, TaskEntry[]>();
for (const t of TASKS) {
	if (!t.sequence_id) continue;
	const key = `${t.sequence_id}|${t.dataset_id}`;
	const arr = SEQS.get(key) ?? []; arr.push(t); SEQS.set(key, arr);
}
for (const arr of SEQS.values()) arr.sort((a, b) => (a.turn_index ?? 0) - (b.turn_index ?? 0));

// Per-turn acceptable shapes for each sequence (manual, since the rubric file lists empty for these).
const TURN_RUBRIC: Record<string, Array<Array<{tool:string}>>> = {
	"M1.t1": [
		[{tool:"render.summary"}], // ask for clarification → graceful summary
		[{tool:"geocode.address"}, {tool:"render.map"}],
		[{tool:"geocode.address"}, {tool:"sql"}, {tool:"render.map"}],
	],
	"M1.t2": [
		// User answered region → expect geocode plan
		[{tool:"geocode.address"}, {tool:"render.map"}],
		[{tool:"geocode.address"}, {tool:"sql"}, {tool:"render.map"}],
		[{tool:"render.summary"}],
	],
	"M1.t3": [
		// "Now color those by category" — could replan from scratch
		[{tool:"geocode.address"}, {tool:"render.map"}],
		[{tool:"sql"}, {tool:"render.map"}],
		[{tool:"render.map"}],
		[{tool:"render.summary"}],
	],
	"M1.t4": [
		[{tool:"sql"}, {tool:"render.map"}],
		[{tool:"sql"}, {tool:"render.table"}],
		[{tool:"geocode.address"}, {tool:"sql"}, {tool:"render.map"}],
		[{tool:"render.summary"}],
	],
	"M2.t1": [
		[{tool:"report.quickscan"}],
		[{tool:"render.summary"}],
		[{tool:"report.quickscan"}, {tool:"render.summary"}],
	],
	"M2.t2": [
		[{tool:"render.map"}],
		[{tool:"sql"}, {tool:"render.map"}],
	],
	"M2.t3": [
		[{tool:"render.map"}],
		[{tool:"sql"}, {tool:"render.map"}],
	],
	"M2.t4": [
		[{tool:"sql"}, {tool:"render.map"}],
		[{tool:"render.map"}],
	],
	"M3.t1": [
		[{tool:"render.summary"}],
		[{tool:"geocode.address"}, {tool:"render.map"}],
	],
	"M3.t2": [
		// User says "I don't know" — model must NOT hang; render.summary
		// explaining limitation OR attempting with what's known.
		[{tool:"render.summary"}],
		[{tool:"geocode.address"}, {tool:"render.summary"}],
		[{tool:"geocode.address"}, {tool:"render.map"}],
	],
	"M3.t3": [
		[{tool:"render.summary"}],
		[{tool:"sql"}, {tool:"render.summary"}],
		[{tool:"render.table"}],
	],
};

/* ---- Profile + renderers (same as fixtures harness) ---- */
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
	let rows = 0; for (const _ of raw.split("\n")) rows++; rows = Math.max(0, rows - (task.fixture_has_header?1:0) - 1);
	let geometry: any | undefined;
	const lower = header.map(h => h.toLowerCase());
	const wktIdx = lower.findIndex(h => h.includes("wkt") || h === "geom" || h === "geometry");
	if (wktIdx >= 0) geometry = { kind: bodyRows[0]?.[wktIdx]?.toUpperCase().includes("POLYGON") ? "polygon" : "point", column: header[wktIdx] };
	else if (lower.includes("lat") && (lower.includes("lon") || lower.includes("lng"))) geometry = { kind: "point", column: "lat,lon" };
	const profile: DatasetProfile = { name: task.dataset_id, kind: geometry?.kind==="polygon"?"layer":"table", rows, columns, sample: bodyRows.slice(0,3).map(r=>{const o:any={};header.forEach((h,i)=>o[h]=r[i]);return o;}) };
	if (geometry) profile.geometry = geometry;
	PROFILE_CACHE.set(key, profile); return profile;
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

const PLANNER_TEMPLATE = `You are GeoChatBot's planner in a multi-turn conversation. Decompose the CURRENT TURN into a 1-10 step Plan. Each step calls one tool. Last step MUST be render.* or report.*. Use prior-turn context when relevant.

# Tool catalog
{{tools_block}}

# SQL constraints: SELECT/WITH only. No DDL.

Respond by calling submit_plan exactly once.
`;

function scoreShape(produced: string[], shapes: Array<Array<{tool:string}>>): boolean {
	if (!shapes.length) return false;
	for (const shape of shapes) {
		let cursor = 0; let ok = true;
		for (const exp of shape) {
			const idx = produced.indexOf(exp.tool, cursor);
			if (idx < 0) { ok = false; break; }
			cursor = idx + 1;
		}
		if (ok) return true;
	}
	return false;
}

async function runSeq(seqKey: string, turns: TaskEntry[]) {
	const profile = buildProfile(turns[0] as TaskEntry);
	const cached = PLANNER_TEMPLATE.replace("{{tools_block}}", renderToolsBlock());
	const tok = Math.random().toString(36).slice(2,10).toUpperCase().replace(/[OIL01]/g, "X");
	const dyn = `# Dataset profile (UNTRUSTED)\n<<<DATA-FENCE-${tok}\n${renderDatasetsBlock([profile])}\n${tok}-DATA-FENCE>>>\n`;
	const schema = zodToJsonSchema(PlanSchema, { target: "openApi3" }) as Record<string, unknown>;

	const history: Array<{ turn: number; user: string; plan_tools: string[] | null; error?: string }> = [];
	for (const t of turns) {
		// Compose flattened-prior-context user message.
		let userMsg = "";
		if (history.length > 0) {
			userMsg += "PRIOR TURNS IN THIS CONVERSATION:\n";
			for (const h of history) {
				userMsg += `- Turn ${h.turn}: User asked "${h.user}". `;
				if (h.plan_tools) userMsg += `You produced: [${h.plan_tools.join(" → ")}].\n`;
				else userMsg += `You ${h.error ? "errored: " + h.error.slice(0,60) : "did not produce a plan"}.\n`;
			}
			userMsg += "\n";
		}
		const annot = t.annotation === "user_answer"
			? `CURRENT TURN ${t.turn_index} (USER'S CLARIFICATION ANSWER TO YOUR PRIOR QUESTION): "${t.question}". Use this answer to produce a plan that fulfills the ORIGINAL request from Turn 1.`
			: `CURRENT TURN ${t.turn_index}: "${t.question}"`;
		userMsg += annot;

		try {
			const raw = await callForcedTool({
				provider: "uf-navigator",
				apiKey: API_KEY as string,
				model: MODEL,
				cachedSystemPrompt: cached,
				systemPrompt: dyn,
				userMessage: userMsg,
				toolName: "submit_plan",
				toolDescription: "Submit a typed Plan.",
				toolInputSchema: schema,
				temperature: 0,
				maxTokens: 8192,
				reasoningEffort: MODEL.toLowerCase().includes("gpt-oss") ? "high" : undefined,
				dangerouslyAllowBrowser: false,
			});
			const plan = validatePlan(raw as unknown, [profile.name]);
			const tools = plan.steps.map(s => s.tool);
			history.push({ turn: t.turn_index as number, user: t.question, plan_tools: tools });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			history.push({ turn: t.turn_index as number, user: t.question, plan_tools: null, error: msg });
		}
	}
	// Score each turn.
	const turnResults = history.map((h, i) => {
		const turn = turns[i] as TaskEntry;
		const rubricKey = `${turn.sequence_id}.t${turn.turn_index}`;
		const acceptable = TURN_RUBRIC[rubricKey] ?? [];
		const matched = h.plan_tools ? scoreShape(h.plan_tools, acceptable) : false;
		// For t2 of M1 (user answer) it's always PASS if no error.
		const isUserAnswerTurn = turn.annotation === "user_answer";
		const pass = matched || (isUserAnswerTurn && h.plan_tools !== null);
		return { id: turn.id, turn: turn.turn_index, question: turn.question, plan: h.plan_tools, error: h.error, pass };
	});
	const seqPass = turnResults.every(r => r.pass);
	return { sequence: seqKey, turns: turnResults, sequence_pass: seqPass };
}

async function main() {
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const outDir = resolve(REPO_ROOT, "audit-reports");
	mkdirSync(outDir, { recursive: true });
	const outPath = resolve(outDir, `multiturn-2026-05-16-${ts}.jsonl`);
	writeFileSync(outPath.replace(/\.jsonl$/, ".model"), `${MODEL}\n`);
	console.log(`=== Multi-turn audit ===\nmodel: ${MODEL}\nsequences: ${SEQS.size}\noutput: ${outPath}\n`);

	let seqPass = 0; let seqTotal = 0;
	for (const [key, turns] of SEQS) {
		const r = await runSeq(key, turns);
		appendFileSync(outPath, JSON.stringify(r) + "\n");
		seqTotal++; if (r.sequence_pass) seqPass++;
		const ind = r.sequence_pass ? "SEQ-PASS" : "SEQ-FAIL";
		console.log(`${ind} ${key}`);
		for (const t of r.turns) console.log(`   T${t.turn} ${t.pass?"✓":"✗"} ${(t.plan??["<no-plan>"]).join("→").slice(0,70)}${t.error?"   ← "+t.error.slice(0,60):""}`);
		console.log("");
	}
	console.log(`SUMMARY: ${seqPass}/${seqTotal} sequences PASS`);
}

main().catch(e => { console.error(e); process.exit(1); });
