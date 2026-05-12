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
		const argRes = tool.args.safeParse(step.args);
		if (!argRes.success) {
			throw new PlanValidationError(
				`step ${step.id} (${step.tool}) bad args: ${argRes.error.message}`,
				step.id,
			);
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
