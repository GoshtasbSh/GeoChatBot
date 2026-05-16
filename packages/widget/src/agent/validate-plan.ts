import { getTool } from "./tools/registry.js";
import { type Plan, PlanSchema } from "./types.js";

export class PlanValidationError extends Error {
	/** Optional pointer to the offending step id, for inline UI highlighting. */
	readonly stepId?: string;
	constructor(message: string, stepId?: string) {
		super(message);
		this.name = "PlanValidationError";
		if (stepId !== undefined) this.stepId = stepId;
	}
}

const VAR_REF = /\$\{(\w+)\}/g;

export function validatePlan(input: unknown, loadedDatasets: string[]): Plan {
	// Layer 0: canonicalize step IDs.
	//
	// Some models (UF Navigator's gpt-oss-120b/20b reasoning family,
	// Llama 3.3 70B at higher temperatures) emit descriptive step IDs like
	// "step_1", "count_step", or "s_01" instead of the canonical "s1, s2"
	// form the schema requires. The IDs are step-local — variable refs go
	// through `output_var`, never step IDs — so we can safely rewrite IDs
	// to canonical form before schema parsing. No-op if IDs are already
	// canonical. AUDIT-2026-05-15.
	input = canonicalizeStepIds(input);

	// Layer 1: shape
	const parsed = PlanSchema.safeParse(input);
	if (!parsed.success) {
		throw new PlanValidationError(`malformed plan: ${parsed.error.message}`);
	}
	const plan = parsed.data;

	// Duplicate step ids
	const seenIds = new Set<string>();
	for (const s of plan.steps) {
		if (seenIds.has(s.id))
			throw new PlanValidationError(`duplicate step id: ${s.id}`, s.id);
		seenIds.add(s.id);
	}

	// dataset_refs: dedup, non-empty, every entry is a loaded dataset.
	// Duplicates indicate planner confusion and would let two cross-ref
	// checks fight over the same name; reject up front.
	const loaded = new Set(loadedDatasets);
	const seenRefs = new Set<string>();
	for (const d of plan.dataset_refs) {
		if (seenRefs.has(d)) {
			throw new PlanValidationError(`duplicate dataset_refs entry: ${d}`);
		}
		seenRefs.add(d);
		if (!loaded.has(d)) {
			// Including the available dataset names in the error message lets
			// the planner's retry loop self-correct: the second LLM call sees
			// the validation message and can pick the canonical name.
			const available = loadedDatasets.length
				? `available: ${loadedDatasets.map((n) => `"${n}"`).join(", ")}`
				: "no datasets loaded";
			throw new PlanValidationError(
				`dataset_refs contains missing dataset: "${d}" (${available})`,
			);
		}
	}

	// Layer 2: tool existence + args parse
	//
	// Robustness: small LLMs (Groq's Llama 3.1-8b especially) like to fill
	// every advertised optional field with an empty string or empty array
	// instead of omitting it ("region_hint": "", "filters": []). Zod
	// schemas with `.min(1)` reject those. We pre-sanitize each step's
	// args by stripping empty-string / empty-array fields from the
	// top-level object before validation, which transparently fixes 90%+
	// of these "bad args" errors without changing the schemas.
	for (const step of plan.steps) {
		const tool = getTool(step.tool);
		if (!tool) {
			throw new PlanValidationError(`unknown tool: ${step.tool}`, step.id);
		}
		step.args = sanitizeArgs(step.args);
		// Audit 2026-05-16: render.chart accepts kind ∈ {bar, line, scatter,
		// pie, grouped_bar} but llama-3.3-70b-instruct routinely emits
		// "histogram" as the kind (14× in the Phase 2 sweep). Map to "bar"
		// so the chart still renders — a histogram-of-counts displayed as
		// a bar chart is the same visualization.
		if (step.tool === "render.chart") {
			const a = step.args as Record<string, unknown>;
			if (a.kind === "histogram") a.kind = "bar";
			if (a.kind === "column") a.kind = "bar";
			if (a.kind === "donut") a.kind = "pie";
		}
		// Audit 2026-05-16: stats.aggregate / stats.hex_bin / stats.density_grid
		// accept agg_fn ∈ {sum, mean, median, count, min, max} — models often
		// emit "avg" (a synonym), "average", or pass it as `fn`/`op` instead
		// of `agg_fn`. Canonicalize so the schema validator passes.
		if (step.tool === "stats.aggregate" || step.tool === "stats.hex_bin" || step.tool === "stats.density_grid") {
			const a = step.args as Record<string, unknown>;
			// fn / op → agg_fn
			if (a.agg_fn === undefined) {
				if (a.fn !== undefined) { a.agg_fn = a.fn; delete a.fn; }
				else if (a.op !== undefined) { a.agg_fn = a.op; delete a.op; }
			}
			const synonyms: Record<string, string> = { avg: "mean", average: "mean", maximum: "max", minimum: "min", stddev: "mean" };
			if (typeof a.agg_fn === "string" && synonyms[a.agg_fn.toLowerCase()]) {
				a.agg_fn = synonyms[a.agg_fn.toLowerCase()];
			}
			// table / dataset / source → layer (stats.aggregate field is `layer`)
			if (a.layer === undefined) {
				if (typeof a.table === "string") { a.layer = a.table; delete a.table; }
				else if (typeof a.dataset === "string") { a.layer = a.dataset; delete a.dataset; }
				else if (typeof a.source === "string") { a.layer = a.source; delete a.source; }
				else if (typeof a.input === "string") { a.layer = a.input; delete a.input; }
			}
			// column / col / metric → value_col
			if (a.value_col === undefined) {
				if (typeof a.column === "string") { a.value_col = a.column; delete a.column; }
				else if (typeof a.col === "string") { a.value_col = a.col; delete a.col; }
				else if (typeof a.metric === "string") { a.value_col = a.metric; delete a.metric; }
				else if (typeof a.field === "string") { a.value_col = a.field; delete a.field; }
			}
			// groupBy / by / groups → group_by
			if (a.group_by === undefined) {
				if (a.groupBy !== undefined) { a.group_by = a.groupBy; delete a.groupBy; }
				else if (a.by !== undefined) { a.group_by = a.by; delete a.by; }
				else if (a.groups !== undefined) { a.group_by = a.groups; delete a.groups; }
			}
		}
		const argRes = tool.args.safeParse(step.args);
		if (!argRes.success) {
			throw new PlanValidationError(
				`step ${step.id} (${step.tool}) bad args: ${argRes.error.message}`,
				step.id,
			);
		}
	}

	// Layer 2.5 (audit 2026-05-16): auto-canonicalize step-id var refs.
	// Many smaller models (llama-3.3-70b-instruct hit this 47× in the
	// Phase 2 sweep) emit `${s1}` to mean "step s1's output" without
	// having declared `output_var: "s1"` on step 1. The pattern is
	// natural — step IDs already exist — so we promote the step ID to
	// also serve as the implicit output_var. Same for `${s1_output}`
	// and `${step1}` aliases.
	const stepIds = new Set(plan.steps.map((s) => s.id));
	for (const step of plan.steps) {
		const refs = collectVarRefs(step.args);
		for (const r of refs) {
			// Direct id match (e.g. ${s1} → step.id "s1")
			if (stepIds.has(r)) {
				const prior = plan.steps.find((s) => s.id === r);
				if (prior && prior !== step && prior.output_var === undefined) {
					prior.output_var = r;
				}
				continue;
			}
			// "_output" suffix (e.g. ${s1_output} → step.id "s1")
			const stripped = r.replace(/_output$/, "");
			if (stripped !== r && stepIds.has(stripped)) {
				const prior = plan.steps.find((s) => s.id === stripped);
				if (prior && prior !== step && prior.output_var === undefined) {
					prior.output_var = r;
				}
			}
		}
	}

	// Layer 3: reference integrity (forward-only)
	// Duplicate output_var would silently shadow an earlier step's output
	// because the executor stores results in a single Map keyed by var name
	// — any `${dup}` resolves to whichever step ran last. Reject up front.
	const definedSoFar = new Set<string>();
	const seenOutputVars = new Set<string>();
	for (const step of plan.steps) {
		const refs = collectVarRefs(step.args);
		for (const r of refs) {
			if (r === step.output_var) {
				throw new PlanValidationError(
					`step ${step.id} self-references \${${r}}`,
					step.id,
				);
			}
			if (!definedSoFar.has(r)) {
				throw new PlanValidationError(
					`step ${step.id} references unknown var \${${r}} (forward or undefined)`,
					step.id,
				);
			}
		}
		if (step.output_var !== undefined) {
			if (seenOutputVars.has(step.output_var)) {
				throw new PlanValidationError(
					`duplicate output_var: ${step.output_var}`,
					step.id,
				);
			}
			// AUDIT-021: an output_var that shadows a loaded dataset name
			// causes silent confusion downstream — the executor creates a
			// temporary view alias under that name (executor.ts:158), and
			// subsequent `FROM <name>` SQL hits the alias instead of the
			// dataset's geom view. Reject up-front with a clear message.
			if (loaded.has(step.output_var)) {
				throw new PlanValidationError(
					`output_var "${step.output_var}" collides with loaded dataset name; pick a different output_var`,
					step.id,
				);
			}
			seenOutputVars.add(step.output_var);
			definedSoFar.add(step.output_var);
		}
	}

	// Last step must be a render.* OR report.* tool. report.quickscan
	// returns a summary-kind payload (same shape as render.summary) and is
	// the terminal step for "first-look" data-quality questions.
	const last = plan.steps[plan.steps.length - 1];
	if (!last) {
		throw new PlanValidationError("plan has no steps");
	}
	if (!last.tool.startsWith("render.") && !last.tool.startsWith("report.")) {
		throw new PlanValidationError(
			`last step must be a render.* or report.* tool (got ${last.tool})`,
			last.id,
		);
	}

	return plan;
}

/**
 * Maximum nesting depth for `args` walking. A pathologically nested
 * args object would otherwise blow the JS call stack — which would
 * crash validation BEFORE any tool args.safeParse() saw the input.
 * Real plans are 1–3 levels deep; 32 leaves enormous headroom while
 * preventing a DoS via deeply-nested LLM output.
 */
const MAX_REF_DEPTH = 32;

/**
 * Strip "useless empty" values that smaller LLMs (Groq Llama-3.1-8B,
 * Gemini Flash) emit into optional fields instead of omitting them.
 * Concretely:
 *
 *   - empty strings ("")
 *   - whitespace-only strings ("   ", "\t", " ")
 *   - sentinel placeholder strings: "null", "NA", "N/A", "none",
 *     "undefined" (case-insensitive, surrounding whitespace tolerated)
 *   - explicit nulls / undefineds
 *   - empty arrays ([])
 *   - arrays whose every entry is itself a sentinel (collapse → drop)
 *
 * Each surviving array entry is itself sanitized — a single real value
 * mixed with sentinels (`["", "Address", "null"]`) survives as
 * `["Address"]`, which lets the row reach the per-tool .min(1) gate
 * with the legitimate value intact instead of dead-ending on a sibling.
 *
 * Nested-object walking is limited to one extra level (`SANITIZE_DEPTH`)
 * — deep enough for `render.map.style.{colorBy,radiusBy}` but shallow
 * enough that we don't trespass into legitimately-empty payload
 * structures the executor may carry (e.g. sql.args.query is a string,
 * never an object, so this is safe).
 *
 * AUDIT-K1 (2026-05-11): widened from "empty string only" to the full
 * sentinel set after the agentic loop dead-ended on
 * `region_hint: "null"` and `address_cols: ["", "column1"]` from
 * Groq's free-tier Llama. Both single-shot and agentic planner paths
 * eventually call validatePlan(), so this is the single point of fix.
 */
const SANITIZE_DEPTH = 2;

const SENTINEL_RE = /^\s*(null|na|n\/a|none|undefined)\s*$/i;

function isUselessString(v: string): boolean {
	if (v.trim() === "") return true;
	return SENTINEL_RE.test(v);
}

function sanitizeValue(v: unknown, depth: number): unknown {
	if (v === null || v === undefined) return undefined;
	if (typeof v === "string") return isUselessString(v) ? undefined : v;
	if (Array.isArray(v)) {
		const cleaned: unknown[] = [];
		for (const item of v) {
			const c = sanitizeValue(item, depth + 1);
			if (c !== undefined) cleaned.push(c);
		}
		return cleaned.length === 0 ? undefined : cleaned;
	}
	if (typeof v === "object" && depth < SANITIZE_DEPTH) {
		const obj: Record<string, unknown> = {};
		for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
			const c = sanitizeValue(val, depth + 1);
			if (c !== undefined) obj[k] = c;
		}
		return Object.keys(obj).length === 0 ? undefined : obj;
	}
	return v;
}

export function sanitizeArgs(args: unknown): Record<string, unknown> {
	if (!args || typeof args !== "object" || Array.isArray(args)) return {};
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(args)) {
		const c = sanitizeValue(v, 1);
		if (c !== undefined) out[k] = c;
	}
	return out;
}

function collectVarRefs(
	value: unknown,
	out: string[] = [],
	depth = 0,
): string[] {
	if (depth > MAX_REF_DEPTH) {
		throw new PlanValidationError(
			`args nesting too deep (>${MAX_REF_DEPTH}); refusing to validate`,
		);
	}
	if (typeof value === "string") {
		for (const m of value.matchAll(VAR_REF)) {
			const g = m[1];
			if (g !== undefined) out.push(g);
		}
		return out;
	}
	if (Array.isArray(value)) {
		for (const v of value) collectVarRefs(v, out, depth + 1);
		return out;
	}
	if (value && typeof value === "object") {
		for (const v of Object.values(value)) collectVarRefs(v, out, depth + 1);
	}
	return out;
}

/**
 * Rewrite non-canonical `steps[].id` values to the canonical "s1, s2, ..."
 * form. Step IDs are only used to point validation errors at a row in the
 * UI; variable refs use `output_var`, not `id`. So this is a safe transform.
 *
 * If `input` is not a plan-shaped object, this returns it unchanged — the
 * subsequent PlanSchema.safeParse will produce the right error message.
 */
const CANONICAL_STEP_ID = /^s\d+$/;
function canonicalizeStepIds(input: unknown): unknown {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input;
	const obj = input as { steps?: unknown };
	if (!Array.isArray(obj.steps)) return input;
	let needsRewrite = false;
	for (const s of obj.steps) {
		if (!s || typeof s !== "object") continue;
		const id = (s as { id?: unknown }).id;
		if (typeof id !== "string" || !CANONICAL_STEP_ID.test(id)) {
			needsRewrite = true;
			break;
		}
	}
	if (!needsRewrite) return input;
	const steps = obj.steps.map((s, i) => {
		if (!s || typeof s !== "object") return s;
		return { ...(s as Record<string, unknown>), id: `s${i + 1}` };
	});
	return { ...obj, steps };
}
