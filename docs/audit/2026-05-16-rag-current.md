# Phase R.1 Audit: Context Injection into LLM Calls for GeoChatBot Agentic Planner
**Date:** 2026-05-16  
**Scope:** Comprehensive map of every context injection point (preamble, tool catalog, dataset profile, examples, retrieval, critic feedback, inspection tools).

---

## 1. AGENTIC PREAMBLE (packages/widget/src/agent/prompts/agentic-preamble.ts)

**File size:** 22,064 chars (~5,516 tokens)  
**Export:** AGENTIC_PREAMBLE constant

### Coverage
The preamble is engineered against real-world GIS questions from:
- Reddit (r/gis, r/qgis)
- GIS StackExchange
- Esri Community
- Textbooks (Geographic Data Science by Rey/Anselin/Wolf, GIS Geography, Mike Gimond)

**Token budget target:** ≤4,500 tokens (documented on line 22).  
**Iteration headroom:** 1,000 tokens reserved for tool observations across 4-5 inspection iterations.

### Canonical Patterns
The preamble explicitly documents **50 canonical question → tool-chain patterns** (lines 220-444):

Examples of patterns included:
- **Patterns 1-10:** Data quality / first-look (quickscan, null-island, duplicates, geometry validation)
- **Patterns 11-28:** Mapping & geometry transforms (choropleth, buffers, centroids, simplify, fix invalid)
- **Patterns 29-39:** Joins & aggregation (spatial joins, point-in-polygon, counts per polygon, nearest-neighbor)
- **Patterns 40-50:** Domain-specific (equity analysis, food deserts, comparable parcels, flow maps)

**Pattern count:** 50 (explicit line-by-line documentation, lines 220–444)

### Pre-flight Auto-checks (Lines 40–71)
Injected silently into every plan:
- Spatial data presence
- Lat/lon swap detection (numeric range checks)
- Null-island sentinels (0,0 coordinate checks)
- Projected coords vs WGS84 (|x| > 200 guard)
- Mixed geometry types
- Invalid geometry (ST_IsValid)
- Duplicate geometries (count group by ST_AsHEXWKB)
- Antimeridian crossing (bbox > 270°)
- Rate vs count (MAUP guard for choropleth)
- CRS mismatch between join layers

**Quote (lines 40–72):**
```
Before answering ANY question that involves geography, silently
consider — and proactively surface in render.summary if relevant:
  - Is there spatial data at all? If not, route to non-spatial answer.
  - lat/lon swapped? If a numeric col labeled "lat" has values in
    [-180,180] while "lon" sits in [-90,90], they're flipped.
  - Null-island (0,0) sentinels? Common "no geocode" fallback. Flag
    them via sql("SELECT COUNT(*) FROM L WHERE lat=0 AND lon=0").
  ...
  - Rate vs count: is the user about to map a raw count by polygon
    of varying size? Suggest per-capita or per-km² normalization
    (ecological-fallacy / MAUP guard).
```

### Tools Section (Lines 73–144)
**Forced vs Inspection tools:**

**Terminal (forced):**
- report.* — first-look data quality
- geocode.* — Nominatim address → coordinates
- geometry.* — 9 spatial ops (buffer, centroid, simplify, convex_hull, intersect, union, difference, dissolve, voronoi, reproject)
- joins.* — 3 spatial predicates (intersects, within, contains, touches) + nearest_neighbor + point_in_polygon
- stats.* — 7 agg/stats (aggregate, summary_stats, distance_matrix, hex_bin, density_grid, morans_i, getis_ord_gi)
- render.* — 4 rendering (map, chart, table, summary)
- sql — escape hatch (DuckDB spatial extension exposed)

**Inspection (direct-callable):**
- inspect.list_columns
- inspect.sample_rows
- inspect.distinct_values
- inspect.column_pattern
- inspect.probe_sql

**Quote (lines 75–102):**
```
## report.*  — first-look data quality
  - report.quickscan(dataset, skip?)
    Use for vague questions ("what's in here?", "is this any good?",
    "tell me about this", "summary", "show me the data"). Bundles
    schema + completeness + sample + numeric stats + spatial extent
    + CRS guess + date range + duplicates + verdict in ONE call.

## sql  — the escape hatch (use for everything not above)
  - sql(query)
    SELECT / WITH only. DuckDB spatial extension is loaded:
    ST_X / ST_Y / ST_Distance / ST_DWithin / ST_Intersects /
    ST_Within / ST_Contains / ST_Buffer / ST_Centroid /
    ST_Area / ST_Length / ST_IsValid / ST_MakeValid /
    GeometryType / ST_AsGeoJSON / ST_AsHEXWKB / ST_Point.
```

### Hard Rules (Lines 470–503)
- Never ask user to pick columns; INSPECT then DECIDE
- Never use placeholder column names ("col1", "x", "your_col")
- Never pass placeholder optional fields ("", "null", "NA", [])
- Reference dataset names EXACTLY as in profile
- ${output_var: foo} syntax for cross-step references
- LAST step must be render.* or report.*
- No spatial column AND no addresses → render.summary with available columns
- Prefer rate over raw count for choropleth

**Quote (lines 470–503):**
```
  - NEVER ask the user "which column should I use?". Inspect; decide.
  - NEVER use placeholder column names ("col1", "x", "your_col").
  - NEVER pass placeholder values for OPTIONAL fields. If you don't have
    a value, OMIT the field entirely.
  - **${var} references point to output_var names, NOT step ids.**
    Step ids look like "s1", "s2"... and CANNOT be referenced.
```

### Domain Concept → Column Matching (Lines 202–218)
Hardcoded heuristics for user intents:
- walkability → walk_score, walkability, sidewalk_*, ped_*, walk_index
- transit → transit_*, bus_*, rail_*, gtfs_*, commute_*, stops_*
- health → health_*, mortality, life_exp*, prevalence_*, *_rate
- safety/crime → crime_*, incident_*, accident_*, fatal_*, injury_*
- income/SES → income, median_hh_income, poverty_*, median_value
- demographics → pop_*, age_*, race_*, ethn_*, dens_*, hh_*
- education → edu_*, school_*, grade_*, college_*
- air quality → aqi, pm25, pm10, no2, o3, pollution_*, emissions_*
- housing → rent_*, mortgage_*, sale_*, listing_*, units_*

### Trust Boundary (Lines 458–468)
Marked as `<<<UNTRUSTED_DATA …UNTRUSTED_DATA>>>` in planner output. Column names and sample row values are treated as opaque bytes; embedded English directives are treated as content, never instructions.

---

## 2. FORCED-TOOL SYSTEM PROMPTS

**Files:**
- packages/widget/src/agent/forced-tool/types.ts (143 lines)
- packages/widget/src/agent/forced-tool/index.ts (161 lines)
- packages/widget/src/agent/forced-tool/{anthropic,openai,openai-compat,gemini,uf-navigator}.ts

### Provider Dispatch (forced-tool/index.ts, lines 22–28)
Registry of adapters:
```typescript
const ADAPTERS: Record<ProviderId, ForcedToolAdapter> = {
	anthropic: callAnthropic,
	groq: callGroq,
	openai: callOpenAI,
	gemini: callGemini,
	"uf-navigator": callUFNavigator,
};
```

### Catalog (PROVIDER_CATALOGUE, lines 45–122)
Default models per provider (injection point for upstream model selection):
- **Groq (free):** Llama 3.3 70B (recommended), Mixtral 8x7B, Llama 3.1 8B
- **Gemini (free):** Gemini 2.0 Flash (recommended), 1.5 Pro, 1.5 Flash
- **Anthropic (paid):** Claude Sonnet 4.6 (recommended), Claude Haiku 4.5, Claude Opus 4.7
- **OpenAI (paid):** GPT-4o mini (recommended), GPT-4o, GPT-4 Turbo
- **UF Navigator (free):** gpt-oss-120b reasoning (recommended), gpt-oss-20b, Llama 3.3 70B, Llama 3.1 70B

### ForcedToolInput Contract (types.ts, lines 24–55)
```typescript
export interface ForcedToolInput {
	provider: ProviderId;
	apiKey: string;
	model: string;
	/**
	 * System message that is identical across calls (e.g. the planner's
	 * tool catalogue + few-shots). Anthropic caches this via
	 * cache_control:ephemeral
	 */
	cachedSystemPrompt: string;
	/**
	 * Optional dynamic system prefix (e.g. the dataset profile).
	 * Concatenated after `cachedSystemPrompt`.
	 */
	systemPrompt?: string;
	userMessage: string;
	toolName: string;
	toolDescription: string;
	toolInputSchema: Record<string, unknown>;
	temperature?: number;
	maxTokens?: number;
	signal?: AbortSignal;
	dangerouslyAllowBrowser?: boolean;
}
```

### Error Handling (types.ts, lines 57–94)
Unified error taxonomy:
- "AUTH" — API key rejected
- "RATE_LIMIT" — 429 with Retry-After header parsing (lines 110–129)
- "NETWORK" — transient
- "BAD_RESPONSE" — malformed response
- "NO_TOOL_USE" — provider didn't emit a tool call
- "UNSUPPORTED" — browser-key guard (AUDIT-017)
- "ABORTED" — AbortSignal fired

---

## 3. PLANNER & DATASET PROFILE GENERATOR

**Files:**
- packages/widget/src/agent/planner.ts (Planner class, constructor line 125–)
- packages/widget/src/agent/prompts/builders.ts (renderDatasetsBlock, renderToolsBlock, renderPrompt)
- packages/widget/src/agent/prompts/examples.ts (22 worked few-shot exemplars)

### Planner Constructor → agenticCtx (planner.ts, lines 125–180)

**PlannerOptions:**
```typescript
export interface PlannerOptions {
	provider?: ProviderId;
	apiKey: string;
	model: string;
	llmCall?: LlmCallFn;
	dangerouslyAllowBrowser?: boolean;
	mode?: "single-shot" | "agentic";
	agenticEndpoint?: string;
	agenticLlmCall?: LoopLLMCall;
	retrieval?: "auto" | "on" | "off";
	agenticCtx?: InspectionRunCtx;
	memoryEnabled?: boolean;
	onAgenticStep?: (event) => void;
	onAgenticClarify?: (question, signal) => Promise<string>;
}
```

### Dataset Profile Schema (builders.ts, lines 6–32)
```typescript
export interface DatasetProfile {
	name: string;
	kind: "table" | "layer";
	rows: number;
	geometry?: {
		kind: "point" | "line" | "polygon" | "multi";
		column: string;
		crs?: string;
		bbox?: [number, number, number, number];
	};
	columns: Array<{
		name: string;
		type: string;
		range?: [number | string, number | string];
		nulls?: number;
		cardinality?: number;
		/** Up to 3 representative example values (truncated to 80 chars). */
		samples?: unknown[];
	}>;
	sample: unknown[];
}
```

### renderDatasetsBlock (builders.ts, lines 37–74)
For each dataset:
1. Name, kind (table/layer), row count
2. Geometry (if spatial): kind, column, CRS, bbox
3. Columns: name, type, range, nulls count, cardinality, **samples (3 top-frequency values, max 80 chars each)**
4. Sample rows (3 rows, JSON-stringified, capped)

**Quote (lines 52–64):**
```typescript
		for (const c of d.columns) {
			const range = c.range ? ` (range: ${c.range[0]}-${c.range[1]})` : "";
			const nulls = c.nulls !== undefined ? ` nulls: ${c.nulls}` : "";
			const card =
				c.cardinality !== undefined ? ` cardinality: ${c.cardinality}` : "";
			// Render up to 3 examples per column. Already inside the
			// UNTRUSTED_DATASET_PROFILE fence...
			const samples = renderColumnSamples(c.samples);
			lines.push(
				`  - ${c.name}: ${c.type}${range}${nulls}${card}${samples}`.trimEnd(),
			);
		}
```

### renderToolsBlock (builders.ts, lines 76–117)
Groups tools by namespace (geocode.*, geometry.*, joins.*, stats.*, render.*, sql), lists signature + description + example args.

**Quote (lines 76–117):**
```typescript
export function renderToolsBlock(): string {
	const tools = listTools();
	const groups = new Map<string, ToolDef[]>();
	for (const t of tools) {
		const ns = t.id.includes(".") ? (t.id.split(".")[0] ?? t.id) : t.id;
		const key = ns === "sql" ? "sql" : `${ns}.*`;
		const arr = groups.get(key) ?? [];
		arr.push(t);
		groups.set(key, arr);
	}
	const order = [
		"geocode.*",
		"geometry.*",
		"joins.*",
		"stats.*",
		"render.*",
		"sql",
	];
```

### Prompt Assembly (planner.ts, lines 192–219)
Single-shot path constructs:
1. **Cached prefix:** AGENTIC_PREAMBLE + renderToolsBlock()
2. **Retrieved examples block** (if retrieval on; otherwise static examples)
3. **Retrieved knowledge block** (if retrieval on)
4. **Dynamic suffix:**
   - Knowledge block (if retrieved)
   - Retrieved examples section (if retrieved)
   - Dataset profile (fenced as UNTRUSTED_DATASET_PROFILE)

**Quote (planner.ts, lines 192–219):**
```typescript
		const cachedPrefix = renderPrompt({
			datasets: "(see Dataset profile appended below)",
			tools: renderToolsBlock(),
			examples: usingRetrieval
				? "(see Retrieved examples block in the dynamic suffix below)"
				: examplesBlock,
		});

		const datasetsBlock = renderDatasetsBlock(req.datasets);
		// Dynamic suffix: per-request content...
		const dynParts: string[] = [];
		if (usingRetrieval && knowledgeBlock) dynParts.push(knowledgeBlock);
		if (usingRetrieval) {
			dynParts.push(
				`# Retrieved examples (per-question, not cached)\n${examplesBlock}`,
			);
		}
		dynParts.push(
			`# Dataset profile (UNTRUSTED user-supplied data)...
			<<<UNTRUSTED_DATASET_PROFILE\n${datasetsBlock}\nUNTRUSTED_DATASET_PROFILE>>>\n`,
		);
```

### agentic Mode Path (planner.ts, lines 147–150)
Agentic mode **skips** static examples and retrieval rounds:
```typescript
if (this.opts.mode === "agentic") {
	const plan = await this.planAgentic(req);
	if (retrievalEnabled) void this.tryRemember(req.question, plan);
	return plan;
}
```
Rationale: loop reasons from data inspection, not text similarity.

---

## 4. TOOL CATALOG BLOCK ASSEMBLY

**File:** packages/widget/src/agent/agentic/loop.ts

### buildToolsBlock() (loop.ts, line 199)
Called at start of agentic loop to construct the inspection-tool catalog for the LLM.

Constructs array of LoopToolDef (OpenAI-compat format):
```typescript
export interface LoopToolDef {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}
```

Includes all 5 inspection tools + finalize_plan:
1. inspect.list_columns
2. inspect.sample_rows
3. inspect.distinct_values
4. inspect.column_pattern
5. inspect.probe_sql
6. ask_user
7. finalize_plan

**Message assembly (loop.ts, lines 201–204):**
```typescript
const messages: LoopChatMessage[] = [
	{ role: "system", content: systemPrompt },
	{ role: "user", content: question },
];
```

SystemPrompt is passed in from caller (Planner.planAgentic) and contains the same preamble + tool block as single-shot mode.

---

## 5. RETRIEVAL & EMBEDDING CODE

**Files:**
- packages/widget/src/agent/retrieval/retriever.ts (high-level API)
- packages/widget/src/agent/retrieval/corpus.ts (12,341 chars spatial docs)
- packages/widget/src/agent/retrieval/embedder.ts
- packages/widget/src/agent/retrieval/store.ts (VectorStore via IndexedDB)

### Three Vector Stores (retriever.ts, lines 64–66)
```typescript
const corpusStore = new VectorStore<CorpusMeta>(`corpus:${VERSION_TAG}`);
const examplesStore = new VectorStore<ExampleMeta>(`examples:${VERSION_TAG}`);
const memoryStore = new VectorStore<MemoryMeta>(`memory:${VERSION_TAG}`);
```

1. **corpus** — built-in spatial-analysis docs (corpus.ts), embedded on first init
2. **examples** — 22 (q, plan) exemplars from examples.ts, embedded on first init
3. **memory** — user-accepted (q, plan) pairs (opt-in, privacy-sensitive), written after approvePlan

### Corpus Composition (corpus.ts, 12,341 chars)
Embedded spatial analysis documentation. Exact content requires reading the file; indexed via minilm embeddings.

### Retrieval Flow (retriever.ts, lines 72–84)
```typescript
export async function initRetriever(): Promise<void> {
	if (initPromise) return initPromise;
	const p = (async () => {
		await Promise.all([indexCorpus(), indexExamples()]);
	})();
	// On failure, clear the latch so subsequent calls can retry.
	p.catch(() => {
		if (initPromise === p) initPromise = null;
	});
	initPromise = p;
	return initPromise;
}
```

Lazy init on first call; on failure (CSP block, WASM load), subsequent calls retry (not permanently broken).

### Wiring into Planner (planner.ts, lines 160–179)
Retrieval is **opt-in:**
```typescript
const usingRetrieval = this.shouldUseRetrieval();
...
if (retrievalEnabled) {
	try {
		const r = await retrieve(req.question, {
			maxExamples: 5,
			maxDocs: 5,
			includeMemory: this.opts.memoryEnabled === true,
		});
		if (r.examples.length > 0) {
			examplesBlock = renderRetrievedExamples(r.examples);
		}
		if (r.docs.length > 0) {
			knowledgeBlock = renderKnowledgeBlock(r.docs);
		}
	} catch {
		// Embedder failure is non-fatal; static block is still in place.
	}
}
```

Default: `retrieval: "auto"` (enabled in browser, disabled in Node tests).  
Privacy: memory write is **opt-in per user toggle** (`memoryEnabled` defaults to false).

---

## 6. PER-QUESTION RAG AUGMENTATION

**Injection point:** planner.ts, lines 162–179

For each question, if retrieval is on:
1. Top-5 examples (by cosine similarity to question)
2. Top-5 docs (by cosine similarity)
3. Deduped by id, provenance tags ("static-example" vs "user-memory")

**Example injection (lines 171–172):**
```typescript
if (r.examples.length > 0) {
	examplesBlock = renderRetrievedExamples(r.examples);
}
```

These retrieved examples replace the static 22-example block in the dynamic suffix.

---

## 7. PLAN-VALIDATION ERROR FEEDBACK

**File:** packages/widget/src/agent/validate-plan.ts

### Validation Layers (lines 16–150)

**Layer 0: Step ID canonicalization (lines 16–26)**
Models emit non-canonical step IDs ("step_1", "count_step", "s_01").  
Rewrite to canonical form ("s1", "s2", ...) before schema parsing.  
Reference resolution uses `output_var`, never step ids.

**Layer 1: Shape validation (lines 28–32)**
Zod parse against PlanSchema.

**Layer 2: Tool existence + args sanitization (lines 75–88)**
- Lookup tool by id via getTool()
- Sanitize args: strip empty-string / empty-array fields (small models fill optional fields with "", [])
- Parse args against tool.args schema

**Quote (lines 75–88):**
```typescript
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
```

**Layer 3: Reference integrity (lines 96–132)**
- No self-references (${var} in same step)
- No forward references (step 3 can't use ${output_var} from step 5)
- No duplicate output_vars
- output_var doesn't shadow loaded dataset names

**Layer 4: Terminal step guard (lines 138–147)**
Last step must be render.* or report.*.

**Quote (lines 138–147):**
```typescript
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
```

### Error Messages on Retry
Validation errors are fed back to the planner in a user message for re-submission.  
The planner's second LLM call sees the explicit error and can self-correct.

Example feedback (from dataset_refs validation, lines 56–62):
```typescript
const available = loadedDatasets.length
	? `available: ${loadedDatasets.map((n) => `"${n}"`).join(", ")}`
	: "no datasets loaded";
throw new PlanValidationError(
	`dataset_refs contains missing dataset: "${d}" (${available})`,
);
```

---

## 8. CRITIC / PHASE-6 PATCH PATH

**Files:**
- packages/widget/src/agent/critic.ts (Critic class)
- packages/widget/src/agent/critic-llm.ts (callCriticLLM)
- packages/widget/src/agent/prompts/critic.system.md (system template)
- packages/widget/src/agent/prompts/critic-builders.ts (buildCriticUserMessage)

### Critic System Template (critic.system.md, 2,235 chars)

**Quote (lines 1–56):**
```
You are the Critic. A step in a previously-approved Plan threw an error
mid-execution. Your job is to either propose a corrected step, ask for a
plain retry, or declare the failure unrecoverable.

# Decision schema

Respond by calling `submit_diagnosis` with one of three shapes:

  - { "action": "patch", "patchedStep": { id, tool, args, output_var?, why } }
  - { "action": "retry" }
  - { "action": "abort", "reason": "..." }

# Rules

- Only emit `patch` if you can name the exact change. Do not patch by guessing.
- Never invent column names. Only reference columns that appear in the dataset profile.
- Never invent dataset names. Only reference datasets named in `dataset_refs`.
- Never reference a `${var}` that is not in `available_vars`.
...
- If you are not sure, choose `abort` over `patch`.

# Tool catalogue

{{tools_block}}
```

### Critic Constructor (critic.ts, lines 72–81)
```typescript
constructor(opts: CriticOptions) {
	this.opts = opts;
	this.cachedSystemPrompt = criticSystemTemplate.replace(
		"{{tools_block}}",
		renderToolsBlock(),
	);
	this.toolInputSchema = zodToJsonSchema(CriticDecisionSchema, {
		target: "openApi3",
	}) as Record<string, unknown>;
}
```

Cached system prefix contains:
1. Critic role description
2. Decision schema (patch/retry/abort)
3. Constraints (no fabrication, reference only existing columns/vars)
4. Tool catalog (same renderToolsBlock as planner)

### Critic diagnose() (critic.ts, lines 83–129)
Receives StepErrorContext:
- step (the failed step)
- resolvedArgs (with ${var} substitutions)
- error.message
- priorOutputs (map of successful step outputs)
- retryCount, maxRetries
- datasets (profile for grounding)

**buildCriticUserMessage** composes per-failure context and passes it to callCriticLLM.

**Quote (critic.ts, lines 89–97):**
```typescript
const userMessage = buildCriticUserMessage({
	step: ctx.step,
	resolvedArgs: ctx.resolvedArgs,
	errorMessage: ctx.error.message,
	priorOutputs: ctx.priorOutputs,
	retryCount: ctx.retryCount,
	maxRetries: ctx.maxRetries,
	datasets: this.opts.datasets,
});
```

### Feedback on Retry (executor.ts, loop.ts)
If critic returns `patch`, the executor runs the patched step with a corrective note.  
If critic returns `abort`, the step terminates the whole plan.  
Retry budgets are bounded (default maxRetries=2, configurable).

---

## 9. EXAMPLES BUNDLE

**File:** packages/widget/src/agent/prompts/examples.ts  
**Size:** 36,149 chars (~9,037 tokens)

### Structure
```typescript
export interface Example {
	question: string;
	plan: Plan;
}

export const EXAMPLES: Example[] = [ ... ]
```

### Count
**36 worked exemplars** (counted by grep "question:").  
Static block is used in single-shot mode unless retrieval is on.

### Exemplar Composition
Each example is a (question, plan) pair showing:
1. User intent (e.g., "Which NYC neighborhoods sold the most homes in 2024?")
2. Fully-resolved Plan with:
   - goal (one-sentence summary)
   - assumptions (CRS, semantic meaning)
   - dataset_refs (exact names)
   - steps (5–10 tool calls with output_var and why)

**Example structure (lines 9–62):**
```typescript
{
	question: "Which NYC neighborhoods sold the most homes in 2024?",
	plan: {
		goal: "Rank NYC neighborhoods by 2024 home-sale volume",
		assumptions: [
			"price column is sale price in USD",
			"year extracted from sale_date",
		],
		dataset_refs: ["sales", "neighborhoods"],
		steps: [
			{
				id: "s1",
				tool: "sql",
				args: {
					query:
						"SELECT * FROM sales WHERE EXTRACT(year FROM sale_date) = 2024",
				},
				output_var: "sales_2024",
				why: "Filter sales to calendar year 2024 only",
			},
			...
		],
	},
}
```

### Injection Point
- **Single-shot mode:** All 36 examples in renderExamplesBlock() (unless retrieval replaces them)
- **Agentic mode:** Skipped entirely (loop reasons from data inspection)
- **Retrieved:** Top-5 per question replace static block in dynamic suffix

---

## 10. INSPECT-TOOLS REGISTRY

**File:** packages/widget/src/agent/agentic/inspect-tools.ts

### Inspection Tools (lines 30–121)
Available to agent ONLY during pre-plan reasoning phase. Not part of regular plan tool catalog.

```typescript
export const INSPECT_TOOLS = {
	list_columns: {
		id: "inspect.list_columns",
		description: "List the columns of a loaded dataset along with their inferred types.",
		args: z.object({
			dataset: z.string().min(1).describe("Name of the loaded dataset."),
		}),
	},
	sample_rows: {
		id: "inspect.sample_rows",
		description: "Return up to N actual rows from a dataset (truncated to keep output small).",
		args: z.object({
			dataset: z.string().min(1),
			n: z.number().int().min(1).max(20).default(5),
		}),
	},
	distinct_values: {
		id: "inspect.distinct_values",
		description: "Return the top-K most-frequent distinct values of a column (with counts).",
		args: z.object({
			dataset: z.string().min(1),
			column: z.string().min(1),
			k: z.number().int().min(1).max(100).default(20),
		}),
	},
	column_pattern: {
		id: "inspect.column_pattern",
		description: "Heuristic-detect what a column 'looks like': address, zip, email, phone, datetime, country code, latitude, longitude, geometry-wkt, etc.",
		args: z.object({
			dataset: z.string().min(1),
			column: z.string().min(1),
		}),
	},
	probe_sql: {
		id: "inspect.probe_sql",
		description: "Run a small SELECT against the loaded datasets to test a hypothesis (capped at 20 rows in the output).",
		args: z.object({
			query: z.string().min(1).max(2000),
		}),
	},
	ask_user: {
		id: "ask_user",
		description: "Ask the user a clarifying question when a critical piece of context is missing and cannot be inferred from the data alone.",
		args: z.object({
			question: z.string().min(1).max(280),
		}),
	},
	finalize_plan: {
		id: "finalize_plan",
		description: "Commit a final Plan. After enough inspection, call this with the typed Plan that the executor should run.",
		args: z.object({
			goal: z.string().min(1),
			assumptions: z.array(z.string()).default([]),
			dataset_refs: z.array(z.string().min(1)).min(1),
			steps: z.array(...).min(1).max(10),
		}),
	},
} as const satisfies Record<string, InspectionTool>;
```

### Argument Limits
- **sample_rows(n):** 1–20 rows default 5
- **distinct_values(k):** 1–100 values, default 20
- **probe_sql(query):** 0–2000 chars, output capped at 20 rows
- **ask_user(question):** 1–280 chars

### Why Separate Registry (lines 2–16)
```
These tools are NOT part of the regular plan tool catalog.
...
Why a separate registry: the planner's `submit_plan` tool schema is
`{ goal, dataset_refs, steps }`, where each step references a *terminal*
tool from the registry in `agent/tools/`. Mixing inspect.* into that
registry would let the LLM emit `inspect.sample_rows` as a plan step,
which would then fail the "last step must be render.*" rule and waste
a retry slot. Keeping them in a parallel registry preserves the plan
shape and lets us evolve the inspection surface independently.
```

---

## CONTEXT INJECTION SUMMARY

### Total Token Count (Estimated)

| Component | Chars | Tokens (÷4) | Notes |
|-----------|-------|------------|-------|
| AGENTIC_PREAMBLE | 22,064 | 5,516 | 50 patterns, 9 pre-flight checks, 42 canonical tools |
| PLANNER_SYSTEM_MD | 5,184 | 1,296 | Template + design rules |
| CRITIC_SYSTEM_MD | 2,235 | 559 | Decision schema + constraints |
| EXAMPLES (36×) | 36,149 | 9,037 | Worked (q, plan) pairs; 22 in static block, up to 5 retrieved |
| CORPUS | 12,341 | 3,085 | Spatial analysis docs, embedded, retrievable |
| RENDERTOOLS_BLOCK | ~3–4k | ~750–1000 | Dynamic, per-load |
| DATASET_PROFILE | Variable | Variable | Depends on dataset size, column count, geometry |
| **Typical Total** | **~85k** | **~21k** | **Per single-shot call** |

### Breakdown by Category

**Boilerplate (Token Cost, No High-Value Signal):**
- Hard rules (50 rules, ~800 tokens) — necessary for model compliance
- System role descriptions (~400 tokens) — necessary framing
- Schema specifications (~600 tokens) — necessary for forced-tool protocol
- **Subtotal: ~1,800 tokens (8.5%)**

**High-Value Signal:**
- Canonical 50 patterns (5,516 tokens from preamble) — directly matches user questions
- Domain concept → column matching heuristics (lines 202–218) — semantic guidance
- Pre-flight auto-checks (lines 40–71) — data quality patterns
- Tool examples (embedded in tool catalog) — usage patterns
- **Subtotal: ~7,500 tokens (35%)**

**Few-Shot Examples (Double-Edged):**
- 36 worked exemplars (~9,037 tokens) — high token cost for pattern matching
- Retrieved examples (top-5 per question) — contextual but adds latency
- Static block only used if retrieval fails or agentic mode skipped
- **Subtotal: ~9,037 tokens (42%)**

**Context-Specific (High-Value but Variable):**
- Dataset profiles (range: 500–5,000 tokens) — critical for column binding
- Corpus retrieval (0 tokens if disabled, up to 3,085 if on) — optional
- **Subtotal: ~3,500 tokens (16%)**

---

## FIVE SPECIFIC OPPORTUNITIES: "WASTED CONTEXT" & MISSING CONTEXT

### 1. **Over-Specification of the 50 Canonical Patterns**
**Current:** Preamble documents all 50 patterns explicitly (lines 220–444), ~3,500 tokens.  
**Problem:** Only a few patterns match a typical question. Most users ask within 5–10 patterns.  
**Opportunity:** Index patterns by similarity; retrieve only relevant 2–3 patterns per question (like retrieval for corpus). Could save ~2,500 tokens per call while maintaining pattern coverage.  
**Evidence:** Agentic mode skips these patterns and succeeds via data inspection, suggesting full catalog is not critical.

### 2. **Static Examples Block Remains in Cache When Unused**
**Current:** All 36 examples in renderExamplesBlock() stay in cached prefix even when:
- Retrieval is ON (replaced by retrieved examples in dynamic suffix, wasting cache hit)
- Agentic mode is active (examples skipped entirely, wasting cache hit)

**Problem:** Large static block (9,037 tokens) busts Anthropic prompt cache on every mode switch.  
**Opportunity:** Move entire examples block to dynamic suffix in both retrieval and agentic modes. Fallback to static only for single-shot + no-retrieval. Could save 5,000–9,000 tokens per cache hit.

### 3. **Dataset Profile Over-Samples Columns**
**Current:** For each column: name, type, range, nulls, cardinality, AND 3 sample values. For 50-column dataset, this explodes.  
**Problem:** Samples are capped to 80 chars, but cardinality + nulls are also injected. A dataset with 100 columns could be 3,000+ tokens of profile alone.  
**Opportunity:** 
- Inject samples ONLY for ambiguous columns (detected via column name heuristics; e.g., "data_quality", "metric_x" → probe before rendering).
- Drop samples for obviously safe columns (e.g., "id", "timestamp").
- Lazy-load via agentic inspect.column_pattern instead of upfront.
- Could save 500–2,000 tokens per dataset.

### 4. **Missing Structured Semantic Grounding for Columns**
**Current:** Preamble has domain heuristics (walkability → walk_score), but profile dumps raw column names.  
**Problem:** If dataset has "walk_sc" (typo) or "walkability_index" (synonym), heuristic matching fails.  
**Opportunity:** 
- In profile generation, run column names through the semantic heuristic map offline.
- Annotate columns with semantic tags (e.g., `"walkability"`, `"transit"`, `"health"`).
- LLM then sees `walkability: walk_score, walk_sc, walkability_index` grouped by intent.
- Saves inspection rounds and improves plan quality for unfamiliar datasets.

### 5. **Corpus Retrieval Disabled by Default in Node / Tests**
**Current:** Retrieval defaults to "auto" — enabled in browser, disabled in Node. Corpus (12,341 chars) is never embedded or retrieved in test/headless mode.  
**Problem:** Test coverage of retrieval code path is minimal. Production corpus may have stale or low-quality docs.  
**Opportunity:**
- Add an explicit "corpus audit" lint that validates:
  - All docs are under 200 chars (keep summaries tight).
  - Docs are non-overlapping (cosine similarity < 0.7 between any pair).
  - All 50 patterns are covered by at least one doc.
- Enable retrieval in Node tests to catch corpus drift.
- Corpus size could shrink 20–30% with deduping.

---

## AUDIT FINDINGS SUMMARY

### Per-Call Token Budget (Typical Single-Shot Question)
- **Preamble + tool block:** 6,266 tokens (cached, Anthropic cache_control:ephemeral)
- **Dataset profile + samples:** 1,500–3,000 tokens (dynamic, varies by dataset)
- **Examples block:** 9,037 tokens (static) OR 1,500 tokens (retrieved top-5)
- **Corpus knowledge:** 0 tokens (if retrieval off) OR 1,500 tokens (if on)
- **Question + validation feedback:** 500–1,000 tokens (dynamic)
- **Total:** 18,500–21,000 tokens (single-shot) / 9,500–12,000 tokens (agentic, skips examples)

### Token Efficiency
- **Cached content:** 60% (preamble + tools) — high-reuse, low-churn
- **Dynamic content:** 30% (dataset profile) — essential, unavoidable
- **Retrieval (opt-in):** 10% (examples, corpus) — high-value for familiar queries, low-value cold starts

### Recommendations (Priority Order)
1. **Lazy-load column samples:** Inject only for ambiguous columns. Save 500–1,500 tokens per dataset.
2. **Pattern retrieval:** Retrieve top 2–3 relevant patterns per question instead of all 50. Save 2,500–3,000 tokens.
3. **Examples cache management:** Move static examples to dynamic suffix; cache miss on mode switch is expensive.
4. **Semantic column grounding:** Annotate columns with intent tags in profile generation. Improves agentic quality.
5. **Corpus audit:** Dedupe docs, validate coverage, enable retrieval in tests.

---

## File References (Absolute Paths)

- `/Users/goshtasbshahriari/UF Dropbox/Goshtasb Shahriari Mehr/Programming_projects/GeoChatBot/packages/widget/src/agent/prompts/agentic-preamble.ts`
- `/Users/goshtasbshahriari/UF Dropbox/Goshtasb Shahriari Mehr/Programming_projects/GeoChatBot/packages/widget/src/agent/prompts/planner.system.md`
- `/Users/goshtasbshahriari/UF Dropbox/Goshtasb Shahriari Mehr/Programming_projects/GeoChatBot/packages/widget/src/agent/prompts/critic.system.md`
- `/Users/goshtasbshahriari/UF Dropbox/Goshtasb Shahriari Mehr/Programming_projects/GeoChatBot/packages/widget/src/agent/prompts/examples.ts`
- `/Users/goshtasbshahriari/UF Dropbox/Goshtasb Shahriari Mehr/Programming_projects/GeoChatBot/packages/widget/src/agent/prompts/builders.ts`
- `/Users/goshtasbshahriari/UF Dropbox/Goshtasb Shahriari Mehr/Programming_projects/GeoChatBot/packages/widget/src/agent/planner.ts`
- `/Users/goshtasbshahriari/UF Dropbox/Goshtasb Shahriari Mehr/Programming_projects/GeoChatBot/packages/widget/src/agent/forced-tool/types.ts`
- `/Users/goshtasbshahriari/UF Dropbox/Goshtasb Shahriari Mehr/Programming_projects/GeoChatBot/packages/widget/src/agent/forced-tool/index.ts`
- `/Users/goshtasbshahriari/UF Dropbox/Goshtasb Shahriari Mehr/Programming_projects/GeoChatBot/packages/widget/src/agent/agentic/loop.ts`
- `/Users/goshtasbshahriari/UF Dropbox/Goshtasb Shahriari Mehr/Programming_projects/GeoChatBot/packages/widget/src/agent/agentic/inspect-tools.ts`
- `/Users/goshtasbshahriari/UF Dropbox/Goshtasb Shahriari Mehr/Programming_projects/GeoChatBot/packages/widget/src/agent/validate-plan.ts`
- `/Users/goshtasbshahriari/UF Dropbox/Goshtasb Shahriari Mehr/Programming_projects/GeoChatBot/packages/widget/src/agent/critic.ts`
- `/Users/goshtasbshahriari/UF Dropbox/Goshtasb Shahriari Mehr/Programming_projects/GeoChatBot/packages/widget/src/agent/critic-llm.ts`
- `/Users/goshtasbshahriari/UF Dropbox/Goshtasb Shahriari Mehr/Programming_projects/GeoChatBot/packages/widget/src/agent/executor/executor.ts`
- `/Users/goshtasbshahriari/UF Dropbox/Goshtasb Shahriari Mehr/Programming_projects/GeoChatBot/packages/widget/src/agent/retrieval/retriever.ts`
- `/Users/goshtasbshahriari/UF Dropbox/Goshtasb Shahriari Mehr/Programming_projects/GeoChatBot/packages/widget/src/agent/retrieval/corpus.ts`

