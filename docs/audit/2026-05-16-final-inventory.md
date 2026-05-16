# Phase 0 — GeoChatBot Testable Surface Inventory (2026-05-16)

This file is the testable-surface map for the 2026-05-16 final audit. Every entry below MUST be exercised by Phase 2 / Phase 3.

> Cross-refs: detailed RAG-surface map at [`2026-05-16-rag-current.md`](./2026-05-16-rag-current.md); external research at [`2026-05-16-rag-research.md`](./2026-05-16-rag-research.md); fixtures at [`../../e2e/fixtures/audit-2026-05-16/`](../../e2e/fixtures/audit-2026-05-16/).

## 1. Terminal tools (27)

Source: `packages/widget/src/agent/tools/` — each file calls `registerTool({...})` exactly once per id.

| # | Tool id | File | Output kind |
|---|---|---|---|
| 1 | `geocode.address` | `tools/geocode.ts` | layer (points) |
| 2–11 | `geometry.{buffer,centroid,simplify,convex_hull,intersect,union,difference,dissolve,voronoi,reproject}` | `tools/geometry.ts` | layer |
| 12 | `joins.spatial_join` | `tools/joins.ts` | layer |
| 13 | `joins.nearest_neighbor` | `tools/joins.ts` | layer |
| 14 | `joins.point_in_polygon` | `tools/joins.ts` | layer |
| 15–21 | `stats.{aggregate,summary_stats,distance_matrix,hex_bin,density_grid,morans_i,getis_ord_gi}` | `tools/stats.ts` | layer / scalar |
| 22 | `render.map` | `tools/render.ts` | rendered map |
| 23 | `render.chart` | `tools/render.ts` | rendered chart |
| 24 | `render.table` | `tools/render.ts` | rendered table |
| 25 | `render.summary` | `tools/render.ts` | rendered markdown |
| 26 | `sql` | `tools/sql.ts` | layer (SELECT/WITH only) |
| 27 | `report.quickscan` | `tools/report.ts` | summary |

All args are typed with Zod (`tools/types.ts`). Plans validated by `agent/validate-plan.ts`.

## 2. Inspect tools (7) — pre-plan only

Source: `packages/widget/src/agent/agentic/inspect-tools.ts`

| id | Arg limits |
|---|---|
| `inspect.list_columns` | `dataset` |
| `inspect.sample_rows` | `dataset`, `n ∈ [1, 20]` (default 5) |
| `inspect.distinct_values` | `dataset`, `column`, `k ∈ [1, 100]` (default 20) |
| `inspect.column_pattern` | `dataset`, `column` |
| `inspect.probe_sql` | `query` (≤ 2000 chars; SELECT/WITH only) |
| `ask_user` | `question` (≤ 280 chars) |
| `finalize_plan` | full Plan: ≤ 10 steps, step ids `^s\d+$`, last step must be `render.*` |

Inspect tools are kept in a parallel registry (not in `tools/registry.ts`) so they cannot be emitted as plan steps.

## 3. Runners (8)

Source: `packages/widget/src/agent/executor/runners/`

| Runner | Responsibility |
|---|---|
| `geocode.ts` | Nominatim batch geocode with viewbox path (US), abort-aware sleeps |
| `geometry.ts` | DuckDB spatial extension ops |
| `joins.ts` | Spatial joins, nearest-neighbor |
| `stats.ts` | Aggregates, percentiles, hex/density binning, Moran's I, Getis-Ord |
| `sql.ts` | SELECT/WITH dispatch with DDL block |
| `render.ts` | layer / chart / table / summary emit + style processing |
| `report.ts` | Quickscan profile + data-quality report |
| `index.ts` | Runner dispatch map |

Runners NEVER touch the DOM; they go through `ExecutorEngine` (DuckDB-WASM-wrapped).

## 4. Render kinds (4) — full style enumeration

Source: `packages/widget/src/agent/executor/runners/render.ts`

**`render.map`** (map): `geojson` source, optional `style`:
- `colorBy`: column name (categorical or numeric)
- `colorMap`: explicit category → color mapping (categorical override)
- `palette`: named palette (`viridis`, `magma`, `turbo`, `category10`, `set2`, etc.)
- `classification`: `quantile` | `equal_interval` | `natural_breaks` | `manual` | `categorical`
- `bins`: number of classes (numeric only)
- `radiusBy`: column name (numeric)
- `radiusRange`: `[min_px, max_px]`
- `radiusDefault`: integer px
- `colorDefault`: hex string
- `strokeColor`, `strokeWidth`, `opacity`, `fillOpacity`
- `name`: layer label (string)

**`render.chart`**: `kind ∈ {bar, line, scatter, pie, grouped_bar, histogram}`, `data` (rows), `x` / `y` / `series` / `bins`, `title`.

**`render.table`**: `rows` (≤ 5000), `columns` (optional ordering), `title`.

**`render.summary`**: `markdown` (≤ 10000 chars) with `${var}` / `${var.field}` substitution support.

## 5. Events dispatched (7)

Source: `grep dispatch( packages/widget/src/element.ts`

| Event | Payload (shape) |
|---|---|
| `dataset-loaded` | `{ name, rowCount, columns, geometry? }` |
| `plan` | `{ planId, plan, datasets }` |
| `progress` | `{ stepId, tool, status: running|success|fail|rejected|cancelled, message? }` |
| `result` | `{ kind: map|chart|table|summary, payload, title? }` |
| `error` | `{ message, code }` (sanitized; no raw Error) |
| `critic` | `{ stepId, decision: patch|retry|abort, reason }` |
| `agentic-step` | `{ iteration, reason: reason|tool|finalize|budget-exhausted|rate-limit-wait|clarify-needed, detail }` |

## 6. The 50 canonical patterns

Source: `packages/widget/src/agent/prompts/agentic-preamble.ts` lines 220–443. Each pattern in the preamble carries a 1-line description and an expected tool-chain. Grouping (per file):

1–10: Data quality / first-look (`report.quickscan`, `inspect.*`, `render.summary`)
11–20: Mapping (lat/lon points, polygons, geocoded points, choropleth, heatmap)
21–28: Geometry transforms (buffer, centroid, simplify, fix-invalid, holes)
29–33: Joins & overlay (point-in-polygon, change detection)
34–38: Distance & nearest (k-NN, within-radius, Voronoi)
39–44: Aggregation (histogram, time series, percentiles, top-K)
45–46: Spatial pattern (Moran's I, Getis-Ord)
47–50: Domain-specific (equity, deserts, comparables, OD flows)

Full per-pattern tool chains are visible inline in the file. The agentic loop SKIPS the per-pattern worked-example block; only the canonical descriptions remain.

## 7. CLI / eval scripts

| Path | Purpose |
|---|---|
| `scripts/audit-live-groq.ts` | Live API audit against Groq (legacy) |
| `scripts/audit-live-navigator.ts` | Live API audit against UF Navigator (current) |
| `packages/eval/tasks/*.json` | Eval task fixtures (including new `comprehensive_v1.json`) |
| `packages/eval/runner.py` | Python eval runner |
| `packages/eval/scorer.py` | Scoring functions |
| `packages/eval/leaderboard.py` | Leaderboard output |
| `packages/eval/cli.py` | Eval CLI entry |

## 8. Dataset profile pipeline

- Built in `profileDataset()` (DuckDB-WASM-side).
- Shape: `{ name, rowCount, columns[{ name, type, nullCount, distinctTopK?, numericStats?, sampleValues? }], geometry?: { column, encoding, crsGuess, bbox } }`.
- Injected by `Planner` into the dynamic suffix; **fenced** as `<<<UNTRUSTED_DATASET_PROFILE>>> ... <<</UNTRUSTED_DATASET_PROFILE>>>` to discourage prompt injection.
- Sample-values are capped at 80 chars each.

## 9. Settings drawer fields (7)

Source: `packages/widget/src/ui/settings-drawer.ts`

| Field | Type | Notes |
|---|---|---|
| `provider` | select | Anthropic / OpenAI / Groq / Gemini / UF Navigator |
| `model` | select | Auto-populated per provider; UF Navigator highlights `gpt-oss-120b` first |
| `apiKey` | masked input | Persisted in localStorage (key: `geochatbot:keys:v1`) |
| `dangerouslyAllowBrowser` | checkbox | Opt-in for browser API calls |
| `agenticMode` | toggle | Disabled for Anthropic/Gemini (single-shot only) |
| `retrievalMode` | toggle | RAG on/off; downloads ~22 MB embedding model |
| `memoryEnabled` | toggle | IndexedDB persistence; has "Forget my history" button |

## 10. Headless mode

When `<geo-chat-bot mode="headless">` is set:
- No DOM rendering of the canvas.
- All 7 events still fire identically.
- Host drives via `ask(question)` Promise + `approvePlan(planId)` / `rejectPlan()` / `cancelPlan()`.
- `clear()` works without UI.
- `result` event payload is identical to full-mode render input.

## 11. Saved results / recall

- localStorage key: `geochatbot:saves:v1`
- Schema: `SavedResultV1 = { id, version: 1, createdAt, title, origin, kind, payload }`
- CRUD via `SavesStore`; max 200 entries (FIFO eviction).
- Recall re-emits the saved `result` payload — does not re-run the plan.

## 12. Plan-approval modal

- Manual: user sees steps + assumptions + `why` per step; "Approve & run" / "Reject & rephrase".
- Auto-approve hook for tests: host listens to `plan` event, calls `approvePlan(planId)` immediately.
- Critic decisions on step failure: `patch` (with patchedStep) / `retry` / `abort`.

## Testable surface summary

| Item | Count |
|---|---|
| Tools | 27 |
| Inspect tools | 7 |
| Runners | 8 |
| Render kinds | 4 |
| Canonical patterns | 50 |
| Events | 7 |
| CLI/eval scripts | 4 + Python harness |
| Settings fields | 7 |
| Render-layer style options | 13 |
| Sample/probe limits | `n∈[1,20]`, `k∈[1,100]`, query ≤ 2000 chars, plan ≤ 10 steps |

— end Phase 0 inventory.
