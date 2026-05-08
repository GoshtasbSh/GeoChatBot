# GeoChatBot · Phase 4 Design — Planner, Tools, Plan UI

*Author: Goshtasb + Claude (Opus 4.7) · Drafted: 2026-05-08 · Status: Approved (sections 1–6) · Pending implementation plan*

---

## 0. Overview

This spec replaces and expands [`PLAN.md` §5 Phase 4](../../../PLAN.md). It defines:

1. The **expanded tool catalog** — 25 named tools (was 10) covering vector geometry, spatial joins, statistics, rendering, plus a `sql` escape hatch that exposes the full DuckDB Spatial extension.
2. The **agent architecture** — types, module layout, planner / executor / critic responsibilities.
3. The **planner prompt design** — system prompt structure, 20 worked few-shot examples, design rules, prompt caching.
4. The **Plan UI** — Studio Mono visual variant, edit affordances, headless contract, accessibility.
5. The **validation + security pipeline** — 5 defense-in-depth layers, SQL validator, Web Worker isolation, prompt-injection defenses, API-key safety.
6. The **testing strategy + Phase 4 deliverables** — ~70 tests across unit / integration / component / E2E, manual acceptance criteria, effort estimate.

### 0.1 Goal (revised vs `PLAN.md` §0)

The Phase 4 planner must produce inspectable, editable, executable Plans that decompose plain-English spatial questions into 1–10 typed tool calls, where:

- **The user retains control.** Every Plan goes through a human approval gate before any execution. No "agent loop runs first, asks questions later."
- **The catalog is broad enough to feel like the most capable spatial agent that runs in a browser** — covering ~80% of common QGIS vector workflows + signature ArcGIS spatial-statistics tools.
- **The system is honest about its limits.** A browser-embedded widget cannot replace QGIS (no raster pipelines, no DEM/hydrology, no LiDAR, no PostGIS drivers, no plugin ecosystem). We do not pretend otherwise.

### 0.2 Non-goals for Phase 4

- ❌ Implementing real tool executors → Phase 5
- ❌ Real Critic LLM error-recovery loop → Phase 6 (but the wiring point exists)
- ❌ Real renderers (MapLibre / ECharts / virtualized table) → Phase 5
- ❌ Eval harness with task suite → Phase 7
- ❌ Marketing site / standalone `/app` shell → Phase 8
- ❌ Raster operations, network analysis, kriging, viewshed, watershed → post-1.0

### 0.3 Cumulative ship-date impact

| | Original PLAN.md | This spec |
|---|---|---|
| Phase 4 effort | 1 week | 2.5 weeks |
| Phase 5 effort | 1.5 weeks | 2 weeks (more executors) |
| Phase 8 ships | week 8 | **week 10** |

The user has accepted this slip in exchange for the expanded scope.

---

## 1. Tool Catalog (25 Tools)

The planner sees 25 tools grouped into 4 namespaces in its system prompt. Each tool has a stable string ID, a zod arg schema (auto-derived to JSON Schema for the LLM), an `output_kind`, and at least one few-shot example.

### 1.1 `geometry.*` — vector operations (10)

| Tool ID | Args | Output | Backend |
|---|---|---|---|
| `geometry.buffer` | `layer, distance, units` | layer | DuckDB `ST_Buffer` |
| `geometry.intersect` | `a, b` | layer | DuckDB `ST_Intersection` |
| `geometry.union` | `a, b` | layer | DuckDB `ST_Union` |
| `geometry.difference` | `a, b` | layer | DuckDB `ST_Difference` |
| `geometry.dissolve` | `layer, by_field?` | layer | DuckDB `ST_Union_Agg` + GROUP BY |
| `geometry.centroid` | `layer` | layer | DuckDB `ST_Centroid` |
| `geometry.convex_hull` | `layer, mode: 'convex'\|'concave'` | layer | DuckDB `ST_ConvexHull` / Turf concaveman |
| `geometry.voronoi` | `points` | layer | Turf `voronoi` |
| `geometry.simplify` | `layer, tolerance` | layer | DuckDB `ST_Simplify` |
| `geometry.reproject` | `layer, to_crs` | layer | proj4js (lazy-loaded ~50 KB) |

### 1.2 `joins.*` — spatial relationships (3)

| Tool ID | Args | Output | Backend |
|---|---|---|---|
| `joins.spatial_join` | `a, b, predicate: 'within'\|'intersects'\|'contains'\|'touches'` | table | DuckDB spatial JOIN |
| `joins.nearest_neighbor` | `a, b, k` | table | DuckDB `ST_Distance` + window fn |
| `joins.point_in_polygon` | `points, polygons` | table | DuckDB `ST_Within` (kept as ergonomic alias) |

### 1.3 `stats.*` — aggregation + spatial statistics (7)

| Tool ID | Args | Output | Backend |
|---|---|---|---|
| `stats.aggregate` | `layer, group_by, agg_fn, value_col` | table | DuckDB SQL |
| `stats.summary_stats` | `layer, columns` | table | DuckDB SQL |
| `stats.distance_matrix` | `a, b, k?` | table | DuckDB SQL |
| `stats.hex_bin` | `layer, h3_resolution` | layer | h3-js (lazy-loaded ~50 KB) |
| `stats.density_grid` | `layer, cell_size, agg_fn` | layer | DuckDB CTE-based fishnet |
| `stats.morans_i` | `layer, value_col, weights?: 'queen'\|'knn'` | scalar+table | custom JS (~100 LOC) |
| `stats.getis_ord_gi` | `layer, value_col, distance` | layer | custom JS (~150 LOC) |

### 1.4 `render.*` + escape hatch (5)

| Tool ID | Args | Output | Backend |
|---|---|---|---|
| `sql` | `query` | table or layer | DuckDB; SELECT/WITH only (Layer 5 validator) |
| `render.map` | `layer, style?` | rendered | MapLibre |
| `render.chart` | `table, kind, x, y` | rendered | ECharts |
| `render.table` | `table` | rendered | virtualized grid |
| `render.summary` | `text` | rendered | markdown |

### 1.5 Deferred to later phases

- `stats.idw` — interpolation. Produces a raster grid which forces raster rendering. Defer to Phase 5 expansion.
- Network routing (shortest path, isochrone) — needs OSM extracts + graph engine. Defer to post-1.0.
- Kriging — heavy compute, edge case for browser. Defer to post-1.0.
- Raster operations (zonal stats, NDVI, slope) — different paradigm. Defer to post-1.0.

### 1.6 Bundle impact

| Library | Size (gz) | Lazy-loaded? |
|---|---|---|
| proj4js | ~50 KB | yes — only on first `geometry.reproject` |
| h3-js | ~50 KB | yes — only on first `stats.hex_bin` |
| concaveman | ~10 KB | yes — only on first concave hull |
| All others | — | already in baseline (DuckDB Spatial, Turf subset, MapLibre, ECharts) |

Total max additional bundle for Phase 4 + 5: ~110 KB gz, all lazy-loaded. Within `PLAN.md §3` budget.

### 1.7 Why this set

Covers the QGIS toolboxes most users invoke: *Vector → Geometry Tools*, *Vector → Geoprocessing*, *Vector → Analysis*, *Spatial Statistics*. Excludes raster, network, hydrology, 3D — those are out of scope for a browser widget.

---

## 2. Architecture

### 2.1 File layout — `packages/widget/src/agent/`

```
src/agent/
├── types.ts                 # Plan, Step, ToolDef zod schemas + TS types
├── tools/
│   ├── registry.ts          # Map<string, ToolDef>; register / get / list
│   ├── types.ts             # ToolDef interface
│   ├── geometry.ts          # 10 geometry.* tools
│   ├── joins.ts             # 3 joins.* tools
│   ├── stats.ts             # 7 stats.* tools
│   ├── render.ts            # 4 render.* tools
│   └── sql.ts               # sql escape hatch
├── prompts/
│   ├── planner.system.md    # System prompt template (tool list injected at runtime)
│   └── examples.ts          # 20 worked few-shot Plans
├── planner.ts               # Planner.plan(question, profile, history) → Plan
├── substitute.ts            # ${var} resolver
├── validate.ts              # SQL + Plan validators (Layers 1–3, 5)
├── executor.ts              # Phase 5 placeholder; Phase 4 wires the hook
└── critic.ts                # Phase 6 placeholder; Phase 4 wires the hook
```

### 2.2 Type system

```ts
import { z } from 'zod';

export const StepSchema = z.object({
  id: z.string().regex(/^s\d+$/),                  // 's1', 's2', ...
  tool: z.string(),                                // 'geometry.buffer'
  args: z.record(z.unknown()),                     // validated per-tool at exec time
  output_var: z.string().regex(/^[a-z_][a-z0-9_]*$/).optional(),
  why: z.string().min(1).max(280),
});

export const PlanSchema = z.object({
  goal: z.string().min(1),
  assumptions: z.array(z.string()).default([]),
  dataset_refs: z.array(z.string()).min(1),
  steps: z.array(StepSchema).min(1).max(10),
});

export type Plan = z.infer<typeof PlanSchema>;
export type Step = z.infer<typeof StepSchema>;

export type ToolOutputKind = 'layer' | 'table' | 'scalar' | 'rendered';

export interface ToolDef<A extends z.ZodTypeAny = z.ZodTypeAny> {
  id: string;
  description: string;
  args: A;
  output_kind: ToolOutputKind;
  examples?: Array<{ when: string; args: z.infer<A> }>;
}
```

### 2.3 Tool registry pattern

```ts
const tools = new Map<string, ToolDef>();
export const registerTool = (t: ToolDef) => {
  if (tools.has(t.id)) throw new Error(`Duplicate tool id: ${t.id}`);
  tools.set(t.id, t);
};
export const getTool = (id: string) => tools.get(id);
export const listTools = () => [...tools.values()];
```

Each tool file (`tools/geometry.ts`, etc.) calls `registerTool(...)` at module import time.

### 2.4 LLM tool registration strategy

**Decision: Anthropic only sees ONE tool — `submit_plan`.** Its `input_schema` is the JSON Schema of `PlanSchema`. The 25 spatial tools are described in the system prompt as a structured catalog, **not** registered with the Anthropic API.

Rationale:
- ✅ One `tool_use` round-trip → cheaper, faster, deterministic
- ✅ Tool descriptions can be richer (multi-line markdown, examples)
- ✅ Plan validates against `PlanSchema`; per-step args validate against each tool's zod schema **after** the plan returns
- ❌ Risk: LLM might emit a step with a non-existent tool name. Mitigation: Layer 2 validation rejects, retry once with the validation error in the prompt.

### 2.5 Substitution (`${var}`)

```ts
export function substitute(args: unknown, vars: Map<string, OutputRef>): unknown {
  if (typeof args === 'string') {
    const m = args.match(/^\$\{(\w+)\}$/);
    return m ? (vars.get(m[1]) ?? args) : args;
  }
  if (Array.isArray(args)) return args.map(a => substitute(a, vars));
  if (args && typeof args === 'object') {
    return Object.fromEntries(
      Object.entries(args).map(([k, v]) => [k, substitute(v, vars)]),
    );
  }
  return args;
}
```

**Whole-string `${var}` only** — no string interpolation inside text. This rule keeps validation simple and prevents prompt-injection-via-substitution.

### 2.6 Public surface

```ts
// from agent/index.ts (exported by element.ts)
export { Planner } from './planner';
export type { Plan, Step } from './types';
export { listTools, getTool } from './tools/registry';
```

`Executor` and `Critic` are internal in Phase 4; exposed in Phase 5 / 6.

---

## 3. Planner Prompt Design

### 3.1 System prompt template

```
You are GeoChatBot's planner. You decompose a user's spatial question into a 1-10
step Plan. Each step calls one tool from the catalog below. Steps run sequentially;
later steps can reference earlier outputs via ${var_name}.

# Dataset profile
{{datasets_block}}

# Tool catalog
{{tools_block}}

# How to plan
1. Identify the answer type the user wants (map | chart | table | number | sentence).
2. Trace data flow backward from that answer: what join / aggregation / geometry op
   produces it? What inputs does that need?
3. Emit steps in execution order. The LAST step MUST be a render.* tool.
4. For every step, write a 1-2 sentence "why" a non-coder will understand.
5. List CRS / column-meaning assumptions in plan.assumptions.

# Reference syntax
- Use the dataset name (e.g., `sales`) to reference a loaded dataset.
- Use `${output_var}` to reference a previous step's output. Whole-string only.
- `output_var` should be a snake_case noun (e.g., `sales_with_hood`, `hot_spots`).

# SQL constraints
The `sql` tool accepts ONLY SELECT and WITH. No INSERT/UPDATE/DELETE/CREATE/DROP/
ATTACH/COPY/PRAGMA/INSTALL/LOAD/SET. The validator rejects any other keyword.

# Design rules
- "Don't over-decompose" — If the question is purely attribute filtering on one
  dataset, prefer one `sql` step over multiple narrow tools.
- "Reproject before distance" — If the data CRS is geographic (lat/lon, EPSG:4326)
  and the user asks about distances in meters/miles/km, insert a `geometry.reproject`
  step first to a metric CRS.
- "Time grouping uses SQL" — For monthly/yearly/hourly grouping, use a `sql` step
  with `date_trunc(...)`. There's no dedicated time-series tool.
- "Hex vs fishnet" — Prefer `stats.hex_bin` for global cells / unspecified size.
  Use `stats.density_grid` when the user specifies a cell size in meters/km/feet.
- "Concave vs convex hull" — Concave for organic point clusters (default).
  Convex only when explicitly requested or when simplest enclosing shape is wanted.

# Examples
{{examples_block}}

Respond by calling submit_plan exactly once with a valid Plan.
```

### 3.2 Datasets block (auto-rendered from `DatasetProfile`)

For each loaded dataset (cap at 5; truncate sample rows at 3 each):

```
## sales (table)
- rows: 412,309
- geometry: point (column: geom, CRS: EPSG:4326, bbox: [-74.05, 40.55, -73.70, 40.92])
- columns:
  - price: number (range: 50000-8500000, nulls: 0)
  - bedrooms: integer (range: 0-12, nulls: 23)
  - sale_date: date (range: 2018-01-01 to 2024-12-31)
  - neighborhood_id: string (cardinality: 195)
- sample rows (3): { ... }
```

### 3.3 Tools block (rendered from registry)

```
## geometry.*
### geometry.buffer(layer, distance, units)
Expand a layer's geometries by a distance. Use for "within X meters", "draw a radius",
"service area" type questions. Output: layer with buffered polygons.
  e.g. { layer: "hospitals", distance: 500, units: "meters" }

### geometry.intersect(a, b)
Return geometries where layers a AND b overlap. Use for "areas where X and Y both
apply" — e.g., flood zones inside school districts. Output: layer.
  e.g. { a: "flood_zones", b: "school_districts" }

... (all 25, grouped by namespace)
```

Token budget per tool: ~80 tokens × 25 = ~2000 tokens.

### 3.4 Twenty worked few-shot examples

Each example is a `{ question, plan }` pair, ~250–350 tokens. They teach distinct planning patterns:

| # | Pattern taught | Tool combo |
|---|---|---|
| 1 | Aggregate-by-region | `sql → joins.spatial_join → stats.aggregate → render.chart` |
| 2 | Buffer-then-overlay | `geometry.buffer → joins.spatial_join → render.map` |
| 3 | Hot-spot analysis | `sql → stats.getis_ord_gi → render.map` |
| 4 | Hex-bin density | `sql → stats.hex_bin → render.map` |
| 5 | Reproject for distance | `geometry.reproject (×2) → joins.nearest_neighbor → stats.summary_stats → render.summary` |
| 6 | Voronoi service areas | `geometry.voronoi → geometry.intersect → render.map` |
| 7 | Dissolve polygons | `geometry.dissolve → render.map` |
| 8 | Difference / clip-out | `geometry.difference → stats.summary_stats → render.map + render.summary` |
| 9 | Multi-dataset comparison | `joins.spatial_join → sql → stats.aggregate → render.chart (grouped bar)` |
| 10 | Moran's I (scalar output) | `joins.spatial_join → stats.aggregate → stats.morans_i → render.summary` |
| 11 | Pure-SQL escape hatch (don't over-decompose) | `sql → render.map` (counter-example) |
| 12 | Concave hull for cluster delineation | `sql → geometry.convex_hull(mode='concave') → render.map` |
| 13 | Time-aware aggregation | `joins.spatial_join → sql (date_trunc) → render.chart (line)` |
| 14 | Fishnet density grid | `geometry.reproject → stats.density_grid → render.map` |
| 15 | kNN with k>1 + summary | `joins.nearest_neighbor → stats.aggregate → stats.summary_stats → render.summary` |
| 16 | Composite multi-step compute | `geometry.reproject → sql (arithmetic) → stats.aggregate → render.map + render.summary` |
| 17 | Multi-CRS dataset alignment | `geometry.reproject → joins.nearest_neighbor → stats.aggregate → render.map` |
| 18 | Lat/lon → synthesized point geom | `sql (ST_Point) → render.map` |
| 19 | Distance matrix + ranking | `stats.distance_matrix → stats.aggregate → render.chart + render.summary` |
| 20 | Composite Moran's I + Getis-Ord | `joins.spatial_join → stats.aggregate → stats.morans_i → stats.getis_ord_gi → render.map + render.summary` |

Full JSON for each example lives in `src/agent/prompts/examples.ts`.

### 3.5 Prompt caching

Anthropic prompt caching (5-min TTL, ~10× cost reduction on hits). Cache prefix includes everything **before** `{{datasets_block}}`:

```
[CACHED — written once per session, reused across questions]
- Static system instructions    (~500 tokens)
- Tool catalog                  (~2000 tokens)
- Few-shot examples             (~3300 tokens) → 6300 tokens for 20 examples
─────────────────────────────────────────────────
[NOT CACHED — varies per request]
- Dataset profile               (~500 tokens)
- User question                 (~50 tokens)
```

Concretely: pass the static block with `cache_control: { type: 'ephemeral' }`.

### 3.6 Model + sampling settings

| Setting | Value | Rationale |
|---|---|---|
| Default model | `claude-sonnet-4-6` | Best multi-step reasoning + tool selection |
| Cheap option | `claude-haiku-4-5-20251001` | Eval target per Phase 7; user-toggleable |
| Temperature | `0.0` | Deterministic plans; same question → same plan |
| Max tokens | `2048` | Plans are small; cap protects against runaways |
| Tools | `[submit_plan]` | The 25 spatial tools live in the system prompt |
| `tool_choice` | `{ type: 'tool', name: 'submit_plan' }` | Force exactly one tool call |

### 3.7 Cost summary

- First call (uncached): ~$0.034 Sonnet · ~$0.005 Haiku
- Subsequent calls (cached): ~$0.008 Sonnet · ~$0.001 Haiku
- Budget impact for a 50-question session: ~$0.04 cumulative on Sonnet

### 3.8 Eval coverage gap (forwarded to Phase 7)

Phase 7's task suite (15 tasks per `PLAN.md §5 Phase 7`) **must include ~5 task patterns NOT in these 20 examples** (e.g., "find everything that doesn't intersect X", elevation-based queries, polygon-on-polygon density). Otherwise the eval measures memorization, not generalization. This constraint is forwarded to the Phase 7 spec.

---

## 4. Plan UI (Studio Mono variant)

### 4.1 Visual identity

- **Variant:** Studio Mono — sober dark, dense, Linear/Raycast/Vercel-dashboard lineage.
- **Background:** near-black (`#0a0d12`) with subtle teal vignette; no multi-color hotspots.
- **Glass material:** semi-translucent panels, 24 px backdrop blur + 130% saturation. Less ethereal than iOS Aurora; matte surface.
- **Accents:** emerald (`#4ade80`) + sky (`#38bdf8`); warn amber + bad red.
- **Typography:** Inter (system) + JetBrains Mono (tool names).
- **Border radius:** 12 px (sharper than iOS).
- **Density:** ~92% of standard (compact, power-user).
- **Personality marker:** terminal `$` prefix on tool names; dashed step dividers.

Live mockup file (design artifact, not implementation): `/tmp/geochatbot-plan-ui-mockup.html`.

### 4.2 Component placement (Shadow DOM, inside `<geo-chatbot>`)

```
<geo-chatbot>
  ├── <chat-shell>           — message list + input (always visible)
  ├── <plan-review>          — appears when a Plan event fires
  └── <result-canvas>        — appears after Approve; map / chart / table / summary
```

In `mode="headless"`, `<plan-review>` is suppressed entirely; the host page receives a `plan` event with the full Plan payload.

### 4.3 `<plan-review>` layout (5 states)

1. **Plan (default)** — numbered steps, args visible, Approve/Reject/Edit footer.
2. **Edit step** — inline arg editing; enums become `<select>`; `${var}` args become dropdowns; SQL gets CodeMirror lazy-load.
3. **Running** — same numbered list, status orbs flip ○ → ◐ → ✓ / ⚠ / ✕; Critic patches surface inline as warning panels.
4. **Headless** — component renders nothing; events fire on the host element.
5. **Mobile (<480 px)** — args collapse, sticky CTA at bottom, edit opens full-screen sheet.

### 4.4 Edit affordances by arg type

| Arg type | UI |
|---|---|
| `string` (free text) | `<input type="text">` |
| `string` matching `${var}` pattern | dropdown of available `output_var`s + dataset names |
| `enum` (predicate, units, agg_fn) | `<select>` |
| `number` | `<input type="number" step="any">` |
| SQL string | CodeMirror lazy-loaded ~80 KB only when first SQL edit opens |
| `string[]` (e.g., `columns`) | tag-input with autocomplete from dataset profile |

### 4.5 Approve / Reject / Edit semantics

- **Run** — dispatches `'plan:approve'`; executor begins; button disables during run.
- **Edit Plan** — opens free-form JSON edit mode; re-validates on save.
- **Reject** — dispatches `'plan:reject'`; planner re-runs with optional feedback string; old plan archived in chat.
- **Regenerate step N** — dispatches `'plan:regenerate-step'`; planner returns just steps from N onward.

### 4.6 Headless event contract

```ts
// 1. Planner returns
bot.dispatchEvent(new CustomEvent('plan', {
  detail: { planId, plan, datasets: [...] }
}));

// 2. Host approves
bot.approvePlan(planId);
// OR
bot.rejectPlan(planId, optionalFeedback);

// 3. During execution
bot.dispatchEvent(new CustomEvent('progress', {
  detail: { planId, stepId, status: 'running'|'success'|'retry'|'fail',
            durationMs?: number, error?: string, criticPatch?: Step }
}));

// 4. Final result (per render.* step)
bot.dispatchEvent(new CustomEvent('result', {
  detail: { planId, stepId, kind: 'layer'|'chart'|'table'|'summary', payload: ... }
}));
```

### 4.7 Accessibility

- All interactive elements keyboard-reachable; `Run = Enter`, `Reject = Esc`.
- Step numbers announced as "Step 1 of 4: SQL filter" via `aria-label`.
- Status indicators distinguished by **shape AND color** (✓ ⚠ ◐ ✕) — never color alone.
- Editable args have proper `<label for>` associations.
- All text ≥ 4.5:1 contrast ratio against the glass tone (verified).
- All touch targets ≥ 44 × 44 pt; primary CTA 40 px tall.
- 8 px minimum gap between adjacent interactive elements.
- Respects `prefers-reduced-motion: reduce`.
- Runs animations within 150–300 ms with spring/ease-out timing curves.

---

## 5. Validation, Error Handling, Security

### 5.1 Five validation layers

```
LLM produces Plan
  → ① Plan-shape validation (PlanSchema.parse)
  → ② Tool existence + args shape (per-tool zod parse)
  → ③ Reference integrity + ordering (DAG check, last-step-render)
[user approves]
  → ④ Substitution + per-step revalidation (executor-time)
  → ⑤ SQL statement validation (only for sql tool)
```

### 5.2 Layer 5 — SQL validator

**Approach:** tiny SQL lexer (~80 LOC). Strip comments first (`--` and `/* */`). Tokenize. Validate.

**Allow exactly one statement.** Allow only:
- First non-comment token: `SELECT` or `WITH`
- Inside the statement: `FROM`, `WHERE`, `GROUP BY`, `ORDER BY`, `HAVING`, `LIMIT`, `OFFSET`, `JOIN` (all forms), `UNION`, `INTERSECT`, `EXCEPT`, `CASE`/`WHEN`/`THEN`/`ELSE`/`END`, `OVER`, `PARTITION BY`

**Hard blocklist** (case-insensitive): `INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, RENAME, ATTACH, DETACH, COPY, EXPORT, IMPORT, INSTALL, LOAD, PRAGMA, SET, RESET, TRUNCATE, GRANT, REVOKE, VACUUM, CALL, EXEC, EXECUTE`

**Failure:** throw `SqlValidationError(reason)`; surface inline in Plan UI; never sent to DuckDB.

### 5.3 Web Worker isolation

Executors run in a dedicated `Worker` via Comlink. The worker has its own DuckDB-WASM, Turf, h3, proj4. The worker has **no access to** `localStorage` (where the API key lives), `fetch` (no exfiltration), or postMessage to anything outside its parent.

**CSP recommendation in README:**
```
connect-src 'self' https://api.anthropic.com
            https://*.tile.openstreetmap.org
            https://demotiles.maplibre.org;
worker-src blob:;
script-src 'self';
```

### 5.4 Prompt-injection defenses

1. Dataset profile rendered with `JSON.stringify` and strict escaping. Column names/sample rows are data, not instructions.
2. Layer 5 SQL validator rejects malicious SQL no matter how it got into the plan.
3. `${var}` substitution is whole-string only — no `SELECT ... ${danger}` interpolation possible.
4. Critic prompt also uses structured tool-use (`submit_patch(step: Step)`) — same validation pipeline applies.

### 5.5 API-key safety

| Concern | Mitigation |
|---|---|
| Storage | `localStorage['geochatbot_api_key']` only |
| Transmission | Only to `https://api.anthropic.com/*` (provider URL hardcoded) |
| Display | Masked: `sk-ant-…XYZW` (last 4 chars) |
| Logging | Stripped from console errors via `sk-` regex |
| Worker isolation | Worker never sees the key |

### 5.6 Cost / abuse caps

- Max 1 planner call + 2 critic retries = **4 LLM calls per user-question** (hard cap).
- `max_tokens`: 2048 planner, 1024 critic.
- Warning toast if > 50 LLM calls per session.

### 5.7 Failure modes table

| Failure | UI | Recovery |
|---|---|---|
| Planner returns malformed JSON | Toast: "Couldn't generate a plan. Try rephrasing." | User retries |
| Plan references missing var | Inline red on the broken step | User edits to fix |
| Plan refs missing dataset | Inline red on the dataset chip | User loads OR rephrases |
| SQL contains forbidden keyword | Inline red + reason | User edits OR regenerates |
| Step throws at runtime | Status flips to ⚠; Critic patches | If 2 retries fail → original error shown |
| API key invalid (401) | Modal: "API key rejected. Update key?" | Settings panel reopens |
| Network down | Toast: "Can't reach Anthropic. Check connection." | Retry button |
| Worker crashes | Toast: "Engine crashed. Reload to recover." | Reload button |

### 5.8 Output guarantees (the embedder's contract)

- Every `'result'` event payload validates against a published TS type.
- Every `'progress'` event includes `planId` and `stepId` for correlation.
- `bot.exportLayer(name)` returns a typed GeoJSON `FeatureCollection`.
- All public methods documented with TSDoc.
- Breaking changes require a major version bump.

---

## 6. Testing + Phase 4 Deliverables

### 6.1 Test pyramid

```
                    ┌────────────────┐
                    │  E2E (3 tests) │  Playwright, real browser, fixture data
                    └────────────────┘
                  ┌──────────────────────┐
                  │  Component (5 tests) │  Vitest + happy-dom, Lit
                  └──────────────────────┘
              ┌─────────────────────────────┐
              │  Integration (~12 tests)    │  Pipeline flow, mocked LLM + DuckDB
              └─────────────────────────────┘
        ┌──────────────────────────────────────────┐
        │  Unit (~50 tests, pure logic)            │  Vitest, no DOM
        └──────────────────────────────────────────┘
```

### 6.2 Unit tests (~50)

| File | Coverage target | Key cases |
|---|---|---|
| `types.test.ts` | 100% | PlanSchema accepts valid; rejects empty/oversized steps, bad ID format, why too long |
| `substitute.test.ts` | 100% | `${var}` resolution; nested objects/arrays; ignores partial-string `"${x}_suffix"` |
| `validate-plan.test.ts` | 100% | Tool existence; forward-only refs; cycle detection; last step is render.\* |
| `validate-sql.test.ts` | 100% | All blocked keywords (each in own test); multi-statement; comment-hidden DROP; case-insensitivity |
| `tools/*.test.ts` | 90% | Each tool: valid args parse; invalid rejected with descriptive error; defaults applied |
| `planner.test.ts` | 80% | Mock SDK; verify request shape, tool_choice forced, retry-once on malformed plan, prompt caching |

### 6.3 Integration tests (~12)

Mocked LLM + mocked DuckDB:

1. `pipeline-happy.test.ts` — full pipeline → events fire in order
2. `pipeline-bad-sql.test.ts` — Layer 5 blocks; no execution
3. `pipeline-bad-ref.test.ts` — Layer 3 blocks; inline error
4. `pipeline-substitution.test.ts` — chained `${var}`s resolve correctly
5. `headless-contract.test.ts` — full event sequence in headless mode
6. `critic-retry-stub.test.ts` — Phase 6 wiring point exists
7. `cache-prefix.test.ts` — cache_control set on static prefix only
8. `dataset-profile-render.test.ts` — profile renders into prompt as expected
9. `examples-block-render.test.ts` — 20 examples render under token budget
10. `plan-id-correlation.test.ts` — every event includes planId/stepId
11. `multi-question-session.test.ts` — second question reuses cached prefix
12. `output-kind-mismatch.test.ts` — Layer 4 rejects when step expects layer but gets table

### 6.4 Component tests (5)

happy-dom + Lit:

1. `plan-review.test.ts` — renders 4 step cards in order
2. `plan-review-edit.test.ts` — edit reveals inputs; invalid disables save
3. `plan-review-actions.test.ts` — Approve/Reject events fire with correct payload
4. `plan-review-keyboard.test.ts` — Tab traversal, Enter/Esc shortcuts
5. `plan-review-headless.test.ts` — component renders nothing in headless mode

### 6.5 E2E tests (3)

Playwright + Anthropic stubbed via `route.fulfill`:

1. `e2e-plan-happy.spec.ts` — drop fixture, ask, see plan, approve, see stubbed result
2. `e2e-plan-edit.spec.ts` — edit step 3 inline, save, approve, executor receives edited args
3. `e2e-headless.spec.ts` — host page drives widget via events; widget Shadow DOM stays empty

### 6.6 Coverage thresholds (CI gate)

```toml
[coverage.thresholds]
statements = 85
branches   = 80
functions  = 90
lines      = 85
```

### 6.7 Phase 4 deliverables checklist

**Code (15 files):**
- ☐ `src/agent/types.ts`
- ☐ `src/agent/substitute.ts`
- ☐ `src/agent/validate.ts`
- ☐ `src/agent/planner.ts`
- ☐ `src/agent/prompts/planner.system.md`
- ☐ `src/agent/prompts/examples.ts`
- ☐ `src/agent/tools/registry.ts`
- ☐ `src/agent/tools/types.ts`
- ☐ `src/agent/tools/geometry.ts` (10 tools, executors stubbed)
- ☐ `src/agent/tools/joins.ts` (3 tools, stubbed)
- ☐ `src/agent/tools/stats.ts` (7 tools, stubbed)
- ☐ `src/agent/tools/render.ts` (4 tools, stubbed)
- ☐ `src/agent/tools/sql.ts` (1 tool, stubbed)
- ☐ `src/ui/plan-review.ts` (Lit component, Studio Mono CSS)
- ☐ `src/element.ts` updated to wire `ask()` → planner → `'plan'` event → approval gate

**Tests (~70):**
- ☐ ~50 unit tests
- ☐ ~12 integration tests
- ☐ 5 component tests
- ☐ 3 E2E tests
- ☐ Coverage thresholds met

**Docs:**
- ☐ `PLAN.md §5 Phase 4` updated (10 → 25 tools, ship date adjusted)
- ☐ Inline TSDoc on all public agent API
- ☐ `examples/react/src/GeoChatBotReact.tsx` demos one question end-to-end
- ☐ `README.md` Phase 4 status badge

### 6.8 Manual acceptance criteria

A human walks through this script before sign-off:

1. Open the demo page; drop `examples/fixtures/nyc-sales-2024.geojson`.
2. Type *"Which NYC neighborhoods sold the most homes in 2024?"* → Enter.
3. Within 4 seconds, see Studio Mono Plan UI with exactly 4 numbered steps.
4. Hover step 3 — specular highlight tracks the cursor.
5. Click `edit` on step 3, change `agg_fn` from sum to mean, see green "valid" indicator, click save.
6. Click **Approve & run** — status orbs flip ○ → ◐ → ✓ for each step (stubbed executors).
7. See a stubbed bar-chart placeholder render below the Plan card.
8. Click **Reject & rephrase**, type *"do it for 2023 instead"*, see new Plan with `2024` swapped.
9. Open `examples/dashboard/index.html` — host page receives `plan` event, calls `approvePlan()`, receives `progress` + `result` events; widget Shadow DOM stays empty.
10. Try SQL injection: edit step 1 to `SELECT * FROM sales; DROP TABLE sales;` — see inline red rejection, save disabled.

### 6.9 Effort estimate

| Subtask | Days |
|---|---|
| Tool definitions, registry, zod schemas (25 × ~30 min) | 2.0 |
| Planner + system prompt + 20 examples + Anthropic integration | 3.0 |
| Validation pipeline (5 layers + SQL lexer) | 2.0 |
| Plan UI Lit component (Studio Mono + edit + status) | 3.0 |
| Headless event contract wired into element.ts | 1.0 |
| Tests (unit + integration + component + 3 E2E) | 2.0 |
| Polish, edge cases, accessibility audit | 1.5 |
| **Total** | **14.5 working days ≈ 2.5 weeks** |

### 6.10 Out of scope (deferred)

| Item | Phase |
|---|---|
| Real tool executors | 5 |
| Real Critic LLM loop | 6 |
| Real renderers (MapLibre / ECharts / virtualized table) | 5 |
| Eval harness with 15 tasks | 7 |
| Marketing site / standalone `/app` | 8 |
| `stats.idw` (raster-producing interpolation) | 5 expansion |
| Network analysis (shortest path, isochrone) | post-1.0 |
| Kriging, viewshed, watershed, raster ops | post-1.0 |

---

## Appendix A — Model strings

| Model | ID |
|---|---|
| Claude Sonnet 4.6 (default planner) | `claude-sonnet-4-6` |
| Claude Haiku 4.5 (cheap option) | `claude-haiku-4-5-20251001` |

## Appendix B — References

- `PLAN.md` — North-star spec; this document expands its §5 Phase 4.
- Mockup file (design-only): `/tmp/geochatbot-plan-ui-mockup.html` — three variants A/B/C; **B (Studio Mono) is locked**.
- Anthropic prompt caching: 5-min TTL ephemeral, applied to the static prefix.
- DuckDB Spatial: provides ~80 ST_\* functions; exposed via the `sql` escape hatch.

## Appendix C — Decisions made during brainstorm (audit trail)

| Decision | Date | Rationale |
|---|---|---|
| Expand catalog 10 → 25 tools | 2026-05-08 | User goal: most-capable browser-native spatial agent |
| Keep 1 LLM tool (`submit_plan`) — catalog in prompt | 2026-05-08 | Cheaper, richer descriptions, single round-trip |
| 20 few-shot examples (capped) | 2026-05-08 | Diminishing returns past 20; overfitting risk |
| Studio Mono visual variant locked | 2026-05-08 | Project ships as developer-embedded widget; "tool not demo" energy fits |
| Pure planning + approval (no agent loop) | 2026-05-08 | Differentiator vs ChatGPT Code Interpreter; user retains control |
| Critic does NOT auto-patch validation errors | 2026-05-08 | Security smell to let LLM bypass validation; user must approve fixes |
| Defer `stats.idw` to Phase 5 | 2026-05-08 | Forces raster rendering pipeline; not needed in Phase 4 scope |
| Browser cannot fully replace QGIS — explicitly out of scope | 2026-05-08 | Reframe to "most capable spatial agent in a browser" — winnable goal |
