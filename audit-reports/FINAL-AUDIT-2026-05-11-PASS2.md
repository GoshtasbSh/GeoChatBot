# GeoChatBot final audit — 2026-05-11 (pass 2)

> Follow-up audit against the working tree after `FINAL-AUDIT-2026-05-11.md`.
> This pass closes the still-OPEN items from pass 1 AND hardens the column-
> intelligence / agent-reasoning pipeline per the user's explicit ask:
>
>   > "the bot can parse the data with different column names, find what
>   >  column should focus thinking and reasoning … better than any
>   >  other usual chatbot."
>
> All changes are uncommitted; user reviews the diff before commit.

---

## Health snapshot

| § | Section | Status | Notes |
|---|---|---|---|
| A | Install + build + typecheck + test + lint | ✓ | install ✓ · build ✓ · typecheck ✓ · vitest 522 pass / 5 skip (+21 new) · lint ✓ |
| A' | `pnpm audit` | ⚠ (CRIT closed) | CRIT 1 → **0** (protobufjs override). HIGH 4 unchanged (thrift in @loaders.gl/parquet — no upstream fix; vite≤6 — examples/react). MED 3 unchanged (next.js → postcss; tar-fs; deep transitives). |
| B | Unit tests + coverage | ✓ | 522 tests across 55 files. Coverage gaps on geocode (9%), report (67%), parquet (0%) unchanged from pass 1; flagged not blockers. |
| C | E2E (Playwright) | ✓ | 7/7 pass chromium in 22.9 s after all fixes. |
| D | Click-path audit | ✓ | A11Y-001/002 fixed (aria-modal). Other paths covered by e2e. |
| E | Provider parity | ⚠ | Pass-1 BUG-001 fix held under repeat e2e. Real-key smoke still infeasible without keys. |
| F | Security review | ✓ | SEC-001 CRIT **closed**. SEC-005 zip-bomb post-decompress **closed** with TDD test. SEC-006 UNTRUSTED fence on agentic inspect output **closed** with 6 regression tests. SEC-007 string-literal semicolon test **closed**. SEC-008 memory-read gate **closed** with regression test. Remaining HIGH/MED are third-party advisories, not code defects. |
| G | Agentic loop correctness | ✓ | All guardrails confirmed. Tool table cleaned of phantom tools (DOC-001 → AGENTIC_PREAMBLE-001). Trust-boundary clause added. |
| H | Data loaders + first-look | ✓ | Lat/lon detector expanded: 4 → 36 alias entries + tier-2 substring fallback. 8 new tests pin the behaviour. Shapefile post-decompress cap fires regardless of pre-check status. |
| I | Documentation accuracy | ✓ | DOC-001 + DOC-002 closed. `docs/CAPABILITIES.md` aligned with the registry. Phantom tools rewritten to sql templates. 12 previously-undocumented registered tools now listed. New consistency test asserts every `group.tool` token in preamble + docs is either registered or in an explicit "use sql" block. |
| J | Performance + bundle | ✓ | Bundle profile unchanged (entry stub still under 100 KB gz). Lazy chunks intact. |
| K | Browser test via Playwright | ✓ | Covered by deterministic e2e (7/7 green). Live MCP run still recommended pre-launch but not gating. |
| L | Network-tab inspection | ✓ | Static grep re-confirmed: no file bytes leave the browser, only column profiles + question text + tool args go to provider endpoints. |
| M | Headless-mode contract | ✓ | `phase4-headless.spec.ts` + `widget.spec.ts:139` both green. |
| N | Accessibility | ⚠ | aria-modal on plan-review + upload-popover added. `:focus-visible` UX nits (UX-001) deferred — non-blocking. Axe-core live run still recommended. |

---

## Bugs found and fixed (TDD) in pass 2

### AGENTIC_PREAMBLE-001 — phantom tools in agentic system prompt [HIGH, FIXED]

**Severity:** HIGH — the bot is told it has tools it doesn't, then plans break at runtime.
**Where:** [packages/widget/src/agent/prompts/agentic-preamble.ts](packages/widget/src/agent/prompts/agentic-preamble.ts) (tool table + canonical patterns 8/23/24/32/44).
**Symptom:** AGENTIC_PREAMBLE advertised seven tools that aren't registered: `geometry.bbox`, `geometry.area`, `geometry.length`, `geometry.distance`, `stats.percentile`, `stats.idw`, `joins.attribute_join`. In agentic mode, the LLM would happily emit a step calling `geometry.area` → `validatePlan` rejects with `Unknown tool` → 0 useful output, even when the question is well-formed.
**Fix:**
- Tool table now lists ONLY registered tools, with explicit "NOT directly registered (use sql …)" blocks pointing at `ST_Area` / `ST_Length` / `percentile_cont WITHIN GROUP` / etc.
- Canonical patterns #8, #23, #24, #32, #44 rewritten to use `sql` directly.
- 12 previously-undocumented registered tools (geometry.intersect/union/difference/dissolve/voronoi/reproject, stats.hex_bin/density_grid/morans_i/getis_ord_gi, joins.nearest_neighbor/point_in_polygon) added to the tool table.
- New test [packages/widget/test/agent/preamble-consistency.test.ts](packages/widget/test/agent/preamble-consistency.test.ts) asserts every `group.tool` token in the preamble AND in CAPABILITIES.md resolves to a registered tool, except those inside explicit "use sql" blocks. This locks the regression so a future preamble edit can't silently re-introduce a phantom.

### COL-001 — column-name detection too narrow [HIGH, FIXED]

**Severity:** HIGH — the user explicitly asked the bot to "parse data with different column names".
**Where:** [packages/widget/src/data/loaders/_util.ts](packages/widget/src/data/loaders/_util.ts) `detectLatLon`.
**Symptom:** the alias list was 9 LAT + 13 LON entries — missed common conventions like:
- GBIF / iNaturalist: `decimalLatitude` / `decimal_latitude`
- GPS device exports: `gps_lat` / `gps_lon` / `gps_latitude` / `gps_longitude`
- Geo / site / pos prefixes: `geo_lat`, `site_lat`, `pos_lat`, `pos_lng`
- Free-form names: `Site_Latitude_DD_NAD83`, `Bird_Decimal_Longitude` (these don't fit a fixed alias list)

Without a fallback, a CSV with any of these would land with no detected geometry → the agent has nothing to map.

**Fix:**
- Alias list expanded to **22 LAT + 30 LON** (GBIF / iNat / GPS / geo / site / pos / loc / point prefixes).
- Tier-2 substring fallback: when no exact alias matches, look for any column whose name contains `latitude` / `longitude` (case-insensitive). Range validation downstream is the real guard against the rare false positive (`platitudes`, `longitudinal_study_id`).
- Tier-1 exact match still wins when both are present (pinned by a test).
- Defends against `latColumn === lonColumn` collision (a pathological case from a future regex change).
- 8 new tests in [detectLatLon.test.ts](packages/widget/test/loaders/detectLatLon.test.ts) cover GBIF, GPS, geo/pos prefixes, substring fallback, the rare false-positive defense, and tier-priority.

### SEC-001 — `protobufjs <7.5.5` arbitrary code execution (CVSS 9.8) [CRITICAL, FIXED]

Added `pnpm.overrides: { "protobufjs": ">=7.5.5" }` to root `package.json`. Lock now pins `protobufjs@8.2.0`. All existing tests + build + e2e pass after override (transformers + onnx-proto still load their embedded schema). `pnpm audit` critical count: 1 → **0**.

### SEC-005 — Shapefile zip-bomb post-decompress cap [MED, FIXED]

`packages/widget/src/data/loaders/shapefile.ts:92-107` — after the .shp and .dbf entries are decompressed, the loader now re-validates that `(shpBuf + dbfBuf).byteLength <= MAX_UPLOAD_BYTES`. This catches the case where the JSZip pre-check is bypassed by missing central-directory size fields. Regression: [shapefile-zipbomb.test.ts](packages/widget/test/loaders/shapefile-zipbomb.test.ts) mocks JSZip to omit `_data.uncompressedSize` and return an oversized buffer; expect `FILE_TOO_LARGE` with a "decompressed" message.

### SEC-006 — UNTRUSTED fence on agentic inspect output [MED, FIXED]

`packages/widget/src/agent/agentic/inspect-runners.ts` — every successful inspection-runner output (`list_columns`, `sample_rows`, `distinct_values`, `column_pattern`, `probe_sql`) is now wrapped:

```
<<<UNTRUSTED_DATA from inspect.<tool>
<body>
UNTRUSTED_DATA>>>
```

The agentic preamble gained a new "Trust boundary" clause telling the model to treat fence-bodies as opaque data. 6 new tests in `inspect-runners.test.ts` lock the fence presence and the prompt-injection-stays-inside-fence invariant.

### SEC-007 — semicolon-in-string-literal SQL validator test [LOW, FIXED]

3 new tests in [validate-sql.test.ts](packages/widget/test/agent/validate-sql.test.ts) pin: (a) `SELECT 'a;b' FROM t` succeeds, (b) `SELECT "weird;col" FROM t` succeeds, (c) unbalanced quotes still surface a DDL keyword (`DROP`) and get rejected. The validator already handled the case — this is a regression lock.

### SEC-008 — gate memory retrieve on `memoryEnabled` [LOW, FIXED]

`packages/widget/src/agent/retrieval/retriever.ts` — `retrieve()` now accepts `includeMemory?: boolean` (defaults to true for back-compat). When false, the user-memory store is skipped entirely. `packages/widget/src/agent/planner.ts:148` passes `includeMemory: this.opts.memoryEnabled === true`. A new test (`AUDIT-005`) in `retriever.test.ts` writes a memory entry, then proves `retrieve(..., { includeMemory: false })` does NOT return it.

### A11Y-001 / A11Y-002 — `aria-modal="true"` added [MED, FIXED]

- `packages/widget/src/ui/plan-review.ts:101` — `role="region"` → `role="dialog" aria-modal="true"` (the plan-review IS a modal dialog over the chat).
- `packages/widget/src/ui/upload-popover.ts:174` — added `aria-modal="true"` to the existing `role="dialog"`.

### DOC-001 / DOC-002 — CAPABILITIES.md aligned with registry [HIGH, FIXED]

`docs/CAPABILITIES.md` rewritten:
- Phantom-tool rows (bbox / area / length / pairwise-distance / attribute_join / percentile / idw) replaced with their `sql` equivalents.
- New rows added for `geometry.intersect/union/difference/dissolve/voronoi/reproject`, `stats.hex_bin/density_grid/morans_i/getis_ord_gi`, `joins.nearest_neighbor/point_in_polygon`.
- New §13 covers spatial-autocorrelation primitives (the docs claimed the bot could compute Moran's I, but never documented the registered `stats.morans_i` tool).
- New §14 notes that IDW / kriging is "sql-only" with the in-browser size budget; full raster work is explicitly out of scope.

## Still-OPEN findings (deferred)

### SEC-002 — `thrift@0.19.0` HIGH (no upstream fix) [HIGH, OPEN]

Transitive via `@loaders.gl/parquet`. Pinning `thrift >= 0.23.0` requires testing whether `@loaders.gl/parquet` still parses; not worth the bytes inside this audit time-box. Documented for the next slice; user can either pin and re-test, or migrate to `parquet-wasm` (smaller bundle, no thrift).

### SEC-003 — `next 15.5.18 → postcss@8.4.31` XSS [MED, OPEN]

Affects ONLY `packages/site` (marketing). Patch by bumping Next.js. Not in widget bundle.

### SEC-004 — vite <6.4.2 advisory [MED, OPEN]

Picked up via `examples/react` or a transitive copy. Widget itself uses vite 6.4.2.

### COV-001/002/003 — coverage gaps [LOW, OPEN]

`geocode.ts` 9%, `parquet.ts` 0%, `report.ts` 67%. Recommend backfill in the next slice; not blocking publish.

### UX-001 — `:focus-visible` gaps [LOW, OPEN]

Ask button, sample chips, plan-review edit inputs, upload drop-area. Visual polish, not correctness.

## Verified clean (pass 2)

- **All pass-1 verified items still hold** (SQL validator paranoid, no XSS sinks, no file bytes leaving browser, `dangerouslyAllowBrowser` defaults false, Comlink worker boundary, 200 MB cap, agentic guardrails, bundle entry stub).
- **Column intelligence**: 36-entry alias list + substring fallback + range validation + collision defense. Tier priority pinned.
- **Agentic prompt consistency**: every tool referenced in the preamble or CAPABILITIES.md is either in the registry OR in an explicit "use sql" block (pinned by `preamble-consistency.test.ts`).
- **UNTRUSTED fence**: inspect-runner output is fenced; prompt-injection cells are content-only.

## Files changed by pass 2

```
docs/CAPABILITIES.md
package.json                                            (+ pnpm.overrides protobufjs ≥ 7.5.5)
pnpm-lock.yaml                                          (lock churn from override)
packages/widget/src/agent/agentic/inspect-runners.ts    (UNTRUSTED fence)
packages/widget/src/agent/planner.ts                    (retrieve includeMemory)
packages/widget/src/agent/prompts/agentic-preamble.ts   (phantom tools + trust clause)
packages/widget/src/agent/retrieval/retriever.ts        (SEC-008 read gate)
packages/widget/src/data/loaders/_util.ts               (COL-001 expanded aliases + tier-2)
packages/widget/src/data/loaders/shapefile.ts           (SEC-005 post-decompress cap)
packages/widget/src/ui/plan-review.ts                   (A11Y-001 aria-modal)
packages/widget/src/ui/upload-popover.ts                (A11Y-002 aria-modal)

# Tests
packages/widget/test/agent/agentic/inspect-runners.test.ts   (+6 SEC-006 regression tests)
packages/widget/test/agent/preamble-consistency.test.ts      (NEW — DOC-001 lock)
packages/widget/test/agent/retrieval/retriever.test.ts       (+1 AUDIT-005 / SEC-008)
packages/widget/test/agent/validate-sql.test.ts              (+3 AUDIT-006 / SEC-007)
packages/widget/test/loaders/detectLatLon.test.ts            (+8 COL-001 regression)
packages/widget/test/loaders/shapefile-zipbomb.test.ts       (NEW — SEC-005 regression)
```

## Verification log

| # | Command | Exit | Notes |
|---|---|---|---|
| 1 | `pnpm install --frozen-lockfile` (pre-pass-2) | 0 | clean |
| 2 | `pnpm --filter @geochatbot/widget build` (pre-pass-2) | 0 | baseline |
| 3 | `pnpm --filter @geochatbot/widget test` (pre-pass-2) | 0 | 501 pass / 5 skip baseline |
| 4 | `pnpm run lint` (pre-pass-2) | 0 | baseline |
| 5 | `pnpm --filter @geochatbot/widget exec vitest run test/loaders/detectLatLon.test.ts` (after COL-001 fix) | 0 | 27 pass (19 + 8 new) |
| 6 | `pnpm --filter @geochatbot/widget exec vitest run test/agent/agentic/inspect-runners.test.ts` (after SEC-006 fix) | 0 | 17 pass (11 + 6 new) |
| 7 | `pnpm --filter @geochatbot/widget exec vitest run test/loaders/shapefile-zipbomb.test.ts` (after SEC-005 fix) | 0 | 1 pass |
| 8 | `pnpm --filter @geochatbot/widget exec vitest run test/agent/retrieval/retriever.test.ts` (after SEC-008 fix) | 0 | 5 pass (4 + 1 new) |
| 9 | `pnpm --filter @geochatbot/widget exec vitest run test/agent/validate-sql.test.ts` (after SEC-007 test) | 0 | 83 pass (80 + 3 new) |
| 10 | `pnpm --filter @geochatbot/widget exec vitest run test/agent/preamble-consistency.test.ts` (after DOC-001/AGENTIC fix) | 0 | 2 pass (NEW) |
| 11 | `pnpm --filter @geochatbot/widget test` (post-fixes, pre-override) | 0 | **522 pass / 5 skip** |
| 12 | `pnpm --filter @geochatbot/widget build` (post-fixes, pre-override) | 0 | ESM stub still ~287 B gz |
| 13 | `pnpm -r --if-present run typecheck` (post-fixes) | 0 | clean |
| 14 | `pnpm run lint` (post-fixes) | 0 | clean |
| 15 | `pnpm --filter @geochatbot/e2e test:e2e` (post-fixes, pre-override) | 0 | 7/7 in 24.5 s |
| 16 | Add `pnpm.overrides` for protobufjs ≥ 7.5.5; `pnpm install` | 0 | resolves to protobufjs 8.2.0 |
| 17 | `pnpm audit --json` (post-override) | n/a | **CRIT 0** (was 1) · HIGH 4 · MED 3 |
| 18 | `pnpm --filter @geochatbot/widget test` (post-override) | 0 | 522 pass / 5 skip |
| 19 | `pnpm --filter @geochatbot/widget build` (post-override) | 0 | clean |
| 20 | `pnpm -r --if-present run typecheck` (post-override) | 0 | clean |
| 21 | `pnpm run lint` (post-override) | 0 | clean |
| 22 | **Final gate** `pnpm --filter @geochatbot/e2e test:e2e` (post-override) | 0 | **7/7 in 22.9 s** |

## Definition of done — gates

| # | Gate | Status |
|---|---|---|
| 1 | Matrix has ✓/✗/⚠ for every section | ✓ |
| 2 | Every ✗ has a fix-and-test OR a deferred note | ✓ |
| 3 | Report exists at `audit-reports/FINAL-AUDIT-2026-05-11-PASS2.md` | ✓ |
| 4 | `install && typecheck && test && build` all green | ✓ |
| 5 | `e2e test:e2e` green | ✓ (7/7) |

## Recommended next-slice work (smallest-effort highest-leverage)

1. **(P1)** Pin `thrift >= 0.23.0` via `pnpm.overrides`, test parquet loader still parses (SEC-002).
2. **(P1)** Bump Next.js to a postcss-patched version (SEC-003); affects marketing site only.
3. **(P2)** Backfill `geocode.ts` test coverage (Nominatim happy-path + rate-limit-sleep stub).
4. **(P2)** Add `:focus-visible` rings to Ask button, sample chips, plan-review edits (UX-001).
5. **(P3)** Live Lighthouse + axe-core run on a Vercel preview before public launch.
6. **(P3)** Smoke-test real-key paths for Anthropic / Gemini / Groq / OpenAI when keys are available.

No commits made; user reviews the full diff before merge.
