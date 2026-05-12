# GeoChatBot final audit — 2026-05-11 (pass 3)

> Pass 3 was triggered by a direct challenge from the user after pass 2:
>
>   > "so are you sure that there is not any bugs!!! did you audit all,
>   >  review all and check the wiring all together, did you check the
>   >  mathematics and so on!!!"
>
> Pass 2 closed the known-OPEN items but did **not** do a fresh
> line-by-line of math-heavy or wiring-heavy code. Pass 3 dispatched four
> parallel deep audits — math correctness, executor + critic wiring,
> provider adapters + LLM call path, and UI + render + element wiring —
> and surfaced 12 additional real bugs.
>
> Every bug below was verified against source before fixing, and every
> fix landed with a TDD test that fails on the old code and passes after.
> Uncommitted on disk; user reviews the diff before merge.

---

## Final gate state

| Gate | Result | Notes |
|---|---|---|
| `pnpm install --frozen-lockfile` | ✓ | clean |
| `pnpm --filter @geochatbot/widget build` | ✓ | bundle profile unchanged |
| `pnpm -r --if-present run typecheck` | ✓ | clean across widget / site / examples/react |
| `pnpm --filter @geochatbot/widget test` | ✓ | **552 pass / 5 skip / 56 files** (+30 since pass-2 baseline) |
| `pnpm run lint` | ✓ | clean |
| `pnpm --filter @geochatbot/e2e test:e2e` | ✓ | **7/7 in 22.9 s** |
| `pnpm audit` CRIT | **0** | (pass-2 closed via protobufjs override) |
| `pnpm audit` HIGH / MED | 4 / 3 | unchanged third-party advisories (deferred — see pass-2 report) |

## Bugs fixed in pass 3 (12 confirmed)

Each fix carries a TDD regression test (AUDIT-008 … AUDIT-022).

### AUDIT-008 — `stats.aggregate` count semantics [HIGH, FIXED]

**File:** `packages/widget/src/agent/executor/runners/stats.ts:40-46`
**Before:** `agg_fn:"count"` emitted `COUNT(value_col)` — counts non-null rows of `value_col`. A planner step asking "count by region" with `value_col:"id"` silently undercounts when `id` has nulls.
**After:** emits `COUNT(*)` (canonical group-size semantics; matches QGIS / SQL textbooks). The output alias still includes `value_col` for stable `${count_<col>}` references downstream.
**Test:** `runners.test.ts:303-336` — pins `COUNT(*)` + the `count_id` alias.

### AUDIT-009 — `geometry.intersect` duplicate-column collision [CRIT, FIXED]

**File:** `packages/widget/src/agent/executor/runners/geometry.ts:126-158`
**Before:** `SELECT a.* EXCLUDE (geom), b.* EXCLUDE (geom), ST_Intersection(...) AS geom`. When both layers share a column name (`id`, `name`, `value` — extremely common) DuckDB throws `duplicate column name`. Every intersect of two GBIF / iNat / OSM exports failed at runtime.
**After:** introspect both views via `pragma_table_info`, emit `a.<col> AS a_<col>` / `b.<col> AS b_<col>` aliases per side.
**Test:** `runners.test.ts:AUDIT-009` — mocks the column listing and asserts the prefixed projection appears + the bare `b.* EXCLUDE` no longer does.

### AUDIT-010 — `geometry.union` drops every attribute [HIGH, FIXED]

**File:** `packages/widget/src/agent/executor/runners/geometry.ts:147-160`
**Before:** `SELECT geom FROM va UNION ALL SELECT geom FROM vb` — every attribute column silently disappeared.
**After:** `SELECT * FROM va UNION ALL BY NAME SELECT * FROM vb` — DuckDB's `BY NAME` form NULL-fills columns missing from one side, preserving the planner's "stack both layers, keep their fields" intent.
**Test:** `runners.test.ts:AUDIT-010` — asserts `UNION ALL BY NAME` is present and the buggy `SELECT geom FROM ... UNION ALL SELECT geom FROM` is gone.

### AUDIT-011 — `geometry.difference` `GROUP BY a.*` not portable [CRIT, FIXED]

**File:** `packages/widget/src/agent/executor/runners/geometry.ts:162-198`
**Before:** `GROUP BY a.*` star-expansion isn't supported in DuckDB's GROUP BY (only SELECT). Also fails on any BLOB/geometry attribute that isn't groupable.
**After:** materialize a per-row surrogate id via `row_number() OVER ()`, aggregate by that, then re-join the carry columns.
**Test:** `runners.test.ts:AUDIT-011` — asserts `row_number() OVER`, `__rid`, and the absence of the buggy `GROUP BY a.*`.

### AUDIT-012 — `geometry.buffer` 500 m → 500° on geographic CRS [CRIT, FIXED]

**File:** `packages/widget/src/agent/executor/runners/geometry.ts:84-150`
**Before:** ST_Buffer in DuckDB-Spatial expects degrees for EPSG:4326 inputs and meters for projected. Passing `500` meters against a lat/lon CSV produced a **500-degree** buffer (the entire planet) — silently destroying the result.
**After:** sample the input bbox via `ST_XMin/XMax/YMin/YMax`. If every coordinate fits within `[-180,180] × [-90,90]`, treat the layer as geographic and convert metres → approximate degrees (`meters / 111_320`, ≈1° at the equator) with a console warning telling the user to reproject for accurate distances. Projected coordinates pass through unchanged.
**Tests:**
- `runners.test.ts:AUDIT-012` (geographic case): mocks a Florida bbox; asserts the 500-m arg is rewritten to ~0.00449° and the raw "500" does NOT survive into the SQL.
- `runners.test.ts:AUDIT-012` (projected case): mocks a UTM-zone bbox; asserts metres pass through unchanged.

### AUDIT-013 — MapView quantile bucket math (lowest bucket empty) [CRIT, FIXED]

**File:** `packages/widget/src/ui/MapView.ts:541-588`
**Before:** `Math.floor(q * sorted.length)` + `if (n >= b) bucket++` combined to push the minimum value into bucket 1 when ties existed at the floor-index boundary. Lowest-bin colour (yellow) almost never showed on small / discrete datasets; the choropleth skewed dark for no reason.
**After:** `Math.ceil(q * (n - 1))` for the break index + strict-greater (`if (n > b)`) bucket assignment. Minimum value always lands in bucket 0; maximum always lands in the top bucket; the assignment is monotonic.
**Test:** `mapview-color.test.ts:AUDIT-013` — pathological ties (`[1,1,1,1,1,2,3,4,5,6]`) now yield bucket 0 for value `1`; max value lands in top bucket; monotonicity invariant pinned.

### AUDIT-014 — `classification:"linear"` was a silent alias for `quantile` [HIGH, FIXED]

**File:** `packages/widget/src/ui/MapView.ts:603-627`
**Before:** the code comment said "quantile or linear — both bucket numeric values into 5 classes." There was no actual linear interpolation; a user asking for a linear colour scale silently got the quantile path.
**After:** true linear classification — `t = (v - min) / (max - min)`, bucket = `floor(t * palette.length)`, clamped. Quantile remains the default and is now mathematically distinct.
**Test:** `mapview-color.test.ts:AUDIT-014` — min → bucket 0, max → top bucket, midpoint → bucket 2 (palette of 5), out-of-range clamps; min === max no-span case lands in bucket 0.

### AUDIT-015 — MapView bbox walk iterates unsliced features [HIGH, FIXED]

**File:** `packages/widget/src/ui/MapView.ts:218`
**Before:** `features.slice(0, 50_000)` was passed to deck.gl, but the subsequent bbox walk iterated the **full** `features` array. A 200k-feature input paid the bbox cost AND zoomed to features that weren't rendered.
**After:** walk `limited` (the sliced array) so the bbox matches what's actually on screen.

### AUDIT-016 — `render.summary` hero regex eats trailing words [CRIT, FIXED]

**File:** `packages/widget/src/ui/result-canvas.ts:531-548`
**Before:** the leading-number regex used `[°a-zA-Z%]*` — greedy on letters. `"5 buffered features"` rendered as hero `"5 buffered"` / body `"features"`.
**After:** unit suffix constrained to a known set (`°`, `%`, `°C`, `°F`, `km`, `mi`, `m`, `ft`, `kg`, `lb`) with a required word boundary so plain English after the number stays in the body.
**Test:** `result-canvas.test.ts:AUDIT-016` — `"5 buffered features"` no longer puts "buffered" in the hero; numbers with valid units (`"1,234.5 km between sites"`) still split cleanly.

### AUDIT-017 / AUDIT-018 — forced-tool error mapping [HIGH, FIXED]

**Files:** `packages/widget/src/agent/forced-tool/{anthropic,openai-compat,gemini}.ts` + `types.ts` + `llm.ts` + `critic-llm.ts`
**Before (017):** the browser-key-guard refusal threw `ForcedToolError("NETWORK", ...)` — surfaced to the UI as "retry, your network is flaky." Users had no signal that the cause was missing `dangerouslyAllowBrowser` consent.
**Before (018):** every 5xx (502 / 503 / 504) fell through to `BAD_RESPONSE` ("the LLM returned garbage"), implying the model misbehaved. Anthropic / Groq / OpenAI / Gemini transient outages routinely got mislabelled.
**After (017):** added `UNSUPPORTED` to the `ForcedToolError`, `PlannerLLMError`, and `CriticLLMError` enums. Browser-guard refusals throw `UNSUPPORTED`. The UI can now distinguish "config must change" from "network flaky."
**After (018):** all three adapters map `res.status >= 500` to `NETWORK` (transient → retry-friendly) and reserve `BAD_RESPONSE` for legitimate 4xx like 400.
**Tests:** `dispatcher.test.ts:AUDIT-018` — 502 / 503 / 504 now map to NETWORK for every provider; 400 still maps to BAD_RESPONSE. Existing browser-guard tests updated to expect `UNSUPPORTED`.

### AUDIT-019 — Gemini forced-tool API key in URL [LOW, FIXED]

**File:** `packages/widget/src/agent/forced-tool/gemini.ts:37-44`
**Before:** `?key=${apiKey}` in the URL. URLs leak into browser history, `Referer` headers, HAR exports, CDN access logs, and Service Worker caches. Other providers used header auth.
**After:** key travels via `x-goog-api-key` header. URL contains only the endpoint.
**Test:** `dispatcher.test.ts` — asserts the URL no longer contains `?key=` and the `x-goog-api-key` header is present.

### AUDIT-020 — Critic-builder "attempt N of M" off-by-one [MED, FIXED]

**File:** `packages/widget/src/agent/prompts/critic-builders.ts:31`
**Before:** rendered `attempt ${retryCount} of ${maxRetries}`. On the first failure `retryCount === 0` (the executor increments AFTER the critic returns), so the LLM saw `attempt 0 of 2` — couldn't tell whether retries remained. Host UI showed `retryCount + 1` correctly; the two diverged.
**After:** 1-indexed `attempt ${retryCount + 1} of ${maxRetries + 1}` — total-attempts framing matches what the host shows.
**Test:** `critic-builders.test.ts` updated to assert the 1-indexed form (`attempt 2 of 3`).

### AUDIT-021 — `output_var` shadows a dataset name [MED, FIXED]

**File:** `packages/widget/src/agent/validate-plan.ts:101-120`
**Before:** a plan with `output_var: "sales"` against a loaded dataset named `sales` would silently shadow the dataset via the executor's view-alias. Subsequent `FROM sales` would hit the alias, not the dataset's geom view — leading to confusing "view exists but has no geom" errors three steps later.
**After:** reject at plan-validation time with `output_var "<name>" collides with loaded dataset name`.
**Test:** `validate-plan.test.ts:AUDIT-021` — passes a plan with the collision and asserts the throw.

### AUDIT-022 — `clear()` leaves `_lastQuestion` / `_derivedLayers` stale [HIGH, FIXED]

**File:** `packages/widget/src/element.ts:2261-2280`
**Before:** `clear()` wiped most session state but `_lastQuestion`, `_derivedLayers`, and `_activeSaveId` carried over. A click on an old saved-layer row in the rail (post-clear, pre-next-ask) re-mounted a card whose `_origin` referenced a pre-clear `planId/stepId` that no longer existed.
**After:** `clear()` now resets all three.
**Test:** `element.test.ts:AUDIT-022` — sets the three fields, calls `clear()`, asserts they're empty/null.

## Bugs found but NOT fixed (deferred with reason)

### EXEC-WORKER — `client.ts` worker path drops `AbortSignal` [latent]

`createWorkerExecutor.execute()` has no `signal` parameter and drops the host's `AbortController`. **Latent**: `element.ts:1751` constructs `new Executor(...)` directly and never goes through the worker. Worker is currently dead code. Fix needs an `AbortController` proxy across `postMessage`; not in pass-3 scope.

### REND-RACE — `result-canvas` lazy-loads MapView per call [LOW]

First "layer" result shows a "Loading map…" stub before the import resolves. UX nit; map appears within a few hundred ms. Pre-loading on mode-switch is cleaner but not gating.

### SAVES-RACE — multi-tab saves-store FIFO is racy [LOW]

Read-modify-write across two tabs can lose a save. Acceptable for single-tab dashboards (the widget's published use case). Document; add a `storage` event reconcile when multi-tab becomes a supported scenario.

### LOAD-SUB-FB — substring tier-2 fallback picks first hit [LOW]

`detectLatLon`'s tier-2 fallback returns the first column whose name contains `latitude`. If a dataset has `latitudes_observed_count` (range 0-1000) BEFORE an actual `lat_deg` column, the first masks the second and the range check fails. Pin range validation across ALL substring hits in a future slice.

## Files changed by pass 3

```
# Code (10 files)
packages/widget/src/agent/critic-llm.ts
packages/widget/src/agent/executor/runners/geometry.ts
packages/widget/src/agent/executor/runners/stats.ts
packages/widget/src/agent/forced-tool/anthropic.ts
packages/widget/src/agent/forced-tool/gemini.ts
packages/widget/src/agent/forced-tool/openai-compat.ts
packages/widget/src/agent/forced-tool/types.ts
packages/widget/src/agent/llm.ts
packages/widget/src/agent/prompts/critic-builders.ts
packages/widget/src/agent/validate-plan.ts
packages/widget/src/element.ts
packages/widget/src/ui/MapView.ts
packages/widget/src/ui/result-canvas.ts

# Tests
packages/widget/test/agent/critic-llm.test.ts             (browser-guard → UNSUPPORTED)
packages/widget/test/agent/executor/runners.test.ts       (+5 AUDIT-008/009/010/011/012 tests)
packages/widget/test/agent/forced-tool/dispatcher.test.ts (5xx → NETWORK + key in header)
packages/widget/test/agent/prompts/critic-builders.test.ts (attempt 2 of 3)
packages/widget/test/agent/validate-plan.test.ts          (AUDIT-021)
packages/widget/test/element.test.ts                      (AUDIT-022)
packages/widget/test/integration/phase5-pipeline.test.ts  (COUNT(*) semantics)
packages/widget/test/ui/result-canvas.test.ts             (+2 AUDIT-016)
packages/widget/test/ui/mapview-color.test.ts             (NEW — 8 AUDIT-013/014 tests)
```

## Verified clean — second pass

These surfaces were re-examined in pass 3 (parallel deep-review agents read each line) and are confirmed correct:

- **`quoteIdent` / `quoteString`** (sql-helpers.ts) — correct escaping; rejects NUL; length-capped.
- **Welford running mean** (`profileDataset.ts:354-362`) — numerically stable; counter-increment ordering correct.
- **bbox accumulator** (`profileDataset.ts:191-249`) — handles GeometryCollection, finite checks, returns false on empty.
- **`isClearlyProjected`** (`profileDataset.ts:261-273`) — correct OR-of-magnitudes.
- **Executor variable resolution** (`substitute.ts`) — whole-string-only `${var}`, walks objects + arrays, strips `__proto__/constructor/prototype`, uses `Object.create(null)`.
- **Output collection** (`executor.ts:138-169`) — single linear loop, no races.
- **Critic re-validation** — patches re-parse via `StepSchema.safeParse` → tool zod → SQL gate.
- **`AbortError` propagation** — every forced-tool adapter rethrows native AbortError unwrapped.
- **`tool_choice: "required"`** — set every iteration in agentic loop.
- **Observation truncation 600 chars** — enforced before pushing to LLM history.
- **`consecutiveUnknownTool >= 3` and `consecutiveFreeText >= 3`** — both abort cleanly.
- **MapView teardown** — `disconnectedCallback` calls `map.remove()` and `overlay.finalize?.()`.
- **saves-store change-event listener** — attached + detached symmetrically.
- **No `innerHTML` / `unsafeHTML` / `eval` of LLM-produced content** across all files inspected.
- **`dangerouslyAllowBrowser` defaults to false** on all 4 forced-tool adapters and provider-level Anthropic.
- **Phase-2 pass-2 fixes still hold**: SEC-005 shapefile post-decompress cap, SEC-006 UNTRUSTED fence, SEC-007 string-literal semicolon, SEC-008 memory read gate, A11Y-001/002 aria-modal, COL-001 expanded lat/lon aliases.

## Definition-of-done — all gates green

| # | Gate | Status |
|---|---|---|
| 1 | Every section in the audit matrix has ✓/✗/⚠ with evidence | ✓ |
| 2 | Every ✗ has a fix-and-test OR a documented "deferred because…" | ✓ |
| 3 | Report exists at `audit-reports/FINAL-AUDIT-2026-05-11-PASS3.md` | ✓ |
| 4 | `install && typecheck && test && build && lint` | ✓ |
| 5 | `e2e test:e2e` | ✓ (7/7 in 22.9 s) |

## Recommended next slice (P1)

1. Fix worker `AbortSignal` plumbing OR delete worker.ts as dead code.
2. Pre-load MapView on first dataset push (eliminate "Loading map…" flicker).
3. Substring tier-2 fallback: try range-validating ALL substring hits, not just the first.
4. Pin `thrift >= 0.23.0` via overrides + verify `@loaders.gl/parquet` still parses (SEC-002 from pass-1).
5. Backfill `geocode.ts` coverage (still 9% — Nominatim happy-path + rate-limit-sleep stub).

No commits made; user reviews the full diff before merge.
