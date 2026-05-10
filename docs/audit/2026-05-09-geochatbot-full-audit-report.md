# GeoChatBot full audit report

**Date:** 2026-05-09  
**Scope:** State map, security review, click-path audit, changed-files review, automated verification (lint/typecheck/tests/e2e), dependency audit.

---

## Executive summary

| Gate | Status |
|------|--------|
| Typecheck | PASS |
| Unit tests (Vitest) | PASS — 496 passed, 5 skipped |
| Biome `ci` | FAIL — formatting + lint issues (see §7) |
| Playwright e2e | PARTIAL — 5/7 passed after `playwright install chromium`; 2 failures due to outdated selectors vs Phase 7 shell UI |
| npm audit | Issues — 11 findings via transitive deps (see §6) |

**Recommendation:** **NEEDS WORK** — ship-quality depends on fixing lint/CI, refreshing e2e assertions for the new shell layout, and accepting or mitigating transitive dependency advisories on Excel/Parquet loaders.

---

## 1. Store map (`GeoChatBotElement`)

### Mutable session / planner / executor fields

| Field | Role |
|-------|------|
| `generation` | Monotonic token; `clear()` / `disconnectedCallback()` bump it. In-flight `ingest`, `_ingestRows`, `ask`, `rejectPlan` compare before committing results. |
| `loaded`, `profiles` | UI + profiler state for ingested tables. |
| `_datasets` | Planner-facing profiles (synced on ingest; wiped by `clear`). |
| `_execDatasets` | DuckDB view names for executor / agentic inspection. |
| `_pendingPlan` | Plan awaiting approve/reject. |
| `_planner`, `_llmCall` | Cached planner; invalidated by `willUpdate` (agentic/retrieval/dangerous flags), `setProvider`, `__setLlmCall`, settings save, `clear`. |
| `_apiKey`, `_llmProvider`, `_model`, `_maskedKey` | LLM configuration. |
| `busy`, `_agentBusy` | Ingest busy vs agent turn busy (separate concerns). |
| `_execAbort` | Per-execution `AbortController`; `clear()` aborts critic LLM calls. |
| `saves`, `_savesList`, `_activeSaveId` | Persisted results (SavesStore). |
| `_derivedLayers` | Layers from `render.map` / layer results. |
| `_criticOverride` | Test injection. |
| `_executorEngine` | Test injection for DuckDB. |

### Public methods: sets vs resets

| Method | Sets | Resets / side effects |
|--------|------|------------------------|
| `setProvider` | `_apiKey`, `_model`, `provider` | `delete _planner` |
| `pushData` → `ingest` / `_ingestRows` | profiles, loaded, `_datasets`, `_execDatasets`, dispatches | `busy`; generation guard on completion |
| `pushData` (planner profile shape) | `_datasets.push({...sample: []})` | Strips hostile `sample` (prompt injection defense) |
| `ask` | `_lastQuestion`, `_pendingPlan`, events | Errors if `PLAN_PENDING`, `NO_KEY`, `BROWSER_KEY_GUARD`; rebuilds `_planner` lazily |
| `approvePlan` | fires `_execute` | Deletes `_pendingPlan` immediately |
| `rejectPlan` | async replan | Deletes `_pendingPlan`; generation guard on `.then` |
| `clear` | bumps `generation` | Wipes loaded, profiles, `_datasets`, `_execDatasets`, `_pendingPlan`, `_planner`, `_apiKey`, critic override, `_maskedKey`, `_activeSaveId`; **does not** remove localStorage keys (documented: session reset, not “forget key”) |
| `_onSaveSettings` | persists to localStorage | `delete _planner` |

### Dangerous resets (cross-cutting)

- **`clear()` resets `_apiKey` and `_maskedKey`** while **localStorage still holds the key** — next `_restoreSettings` does not re-run until reconnect; programmatic `clear()` leaves widget without in-memory key until user re-opens Settings or host calls `setProvider`. Intended for multi-tenant wipe; hosts relying only on persisted key should call `setProvider` after `clear()` or expect “not connected” until settings reload path runs.
- **`willUpdate` deletes `_planner`** when `agenticMode`, `retrievalMode`, or `dangerouslyAllowBrowser` change — avoids stale planner; first render skipped to avoid wiping planner created in same tick as first `ask()` (see comments in `element.ts`).

---

## 2. Security findings

| ID | Severity | Topic | Location / notes | Fix direction |
|----|----------|--------|-------------------|---------------|
| SEC-001 | HIGH | API keys in `localStorage` | `element.ts` `_STORAGE_KEYS`, `_onSaveSettings` | Document for embedders: any XSS steals keys; recommend backend proxy + httpOnly session; widget already defaults `dangerouslyAllowBrowser=false` for direct LLM. |
| SEC-002 | MEDIUM | Client-side LLM calls | `agent/llm.ts`, `agentic/loop.ts` | Opt-in `dangerouslyAllowBrowser`; production should proxy. |
| SEC-003 | MEDIUM | SQL surface | `validate-sql.ts` | Strong denylist (SELECT/WITH, blocks COPY/ATTACH/httpfs/etc.). Defense-in-depth with executor runners. |
| SEC-004 | MEDIUM | Planner prompt injection via dataset | `pushData` profile branch strips `sample`; `toPlannerDatasetProfile` uses profiler-derived samples only | Good; keep `sample: []` for raw profile push. |
| SEC-005 | MEDIUM | ZIP / large files | `shapefile.ts` JSZip unpack | No explicit max uncompressed size or entry count — zip bombs could exhaust memory (browser tab). Add max bytes / max entries where feasible. |
| SEC-006 | HIGH (supply chain) | Transitive vulnerabilities | `npm audit`: `@loaders.gl/excel` → `xlsx`; `@loaders.gl/parquet` → `thrift` | Track upstream fixes; consider isolating Excel/Parquet parsing in worker or optional chunk; monitor GHSA. |
| SEC-007 | LOW | Embed CSP | Host pages | Document: allow wasm/workers for DuckDB; restrict `connect-src` if proxying LLM. |

No hardcoded production API keys found in reviewed paths. Errors dispatched as `{ message, code }` without raw `Error.cause` (good).

---

## 3. Click-path audit (`CLICK-PATH-NNN`)

| ID | Severity | Touchpoint | Pattern | Verdict |
|----|----------|--------------|---------|---------|
| CP-001 | OK | Ask while plan pending | Guard emits `PLAN_PENDING` | Prevents overwriting `_pendingPlan`. |
| CP-002 | OK | `clear()` during `ask()` | `generation` guard | Test: `element.test.ts` NH1. |
| CP-003 | OK | `clear()` during ingest | `generation` guard | Test: ghost ingest. |
| CP-004 | OK | `rejectPlan` replan after `clear()` | `generation` in `.then` | Aligns with ask path. |
| CP-005 | MEDIUM | `clear()` during `_execute` | Executor has **no** AbortSignal for SQL/render steps; `_execAbort` only affects **critic** `diagnose()` | **Residual behavior:** DuckDB steps may continue; progress/result events may still fire after clear. Consider wiring execution cancel token if UX requires hard stop. |
| CP-006 | LOW | Modal `plan:approve` | `approvePlan` then `modal.open=false` | Order is synchronous for approve; OK. |
| CP-007 | OK | Step edit in plan review | `validatePlan` before replacing `_pendingPlan` | Invalid edits dispatch `EDIT_INVALID`. |
| CP-008 | OK | RAG / agentic fallback | `AGENTIC_FALLBACK` event when agentic unavailable | User gets feedback vs silent downgrade. |

---

## 4. Code review — changed files (`git diff --name-only HEAD`)

Notable paths: `element.ts`, `planner.ts`, `validate-plan.ts`, executor runners, UI (`MapView`, `rail`, `result-canvas`, `shell`, `settings-drawer`), tests.

**Observations:**

- **Regression tests** expanded (`element.test.ts`, integration tests) — strong coverage for race and security boundaries (H7, NH1).
- **No `innerHTML`** in `packages/widget/src` (grep) — Lit templates reduce XSS vs raw HTML injection.
- **`exportLayer`** remains a documented stub — hosts must not rely on real GeoJSON export until Phase note is resolved.

---

## 5. Automated verification log

| Command | Result |
|---------|--------|
| `npm run typecheck` | PASS (site, widget, example-react) |
| `npm run test` | PASS — 52 files, 496 tests |
| `npm run lint` (`biome ci .`) | FAIL — includes `package.json` format drift and `packages/widget/test/ui/ask-input.test.ts` `noNonNullAssertion` (+ likely more across repo) |
| `npm run e2e` | After `npx playwright install chromium`: **5 passed, 2 failed** |
| `npm audit` | **11 vulnerabilities** (6 moderate, 4 high, 1 critical) — transitive via loaders.gl excel/parquet |

### E2E failures (root cause)

1. **`widget.spec.ts` — light theme `.drop`** — UI redesigned to `gcb-shell`; legacy `.drop` selector no longer exists. **Fix:** Update test to assert on shell/chat chrome (e.g. `gcb-shell`, `result-canvas`, or dock ask input).

2. **`widget.spec.ts` — CSV drop → map canvas** — Timeout waiting for `gcb-map` / inner canvas; map may mount under different structure or lazy path after redesign. **Fix:** Align test with current DOM (shadow structure from `MapView` / shell slots).

---

## 6. Dependency audit summary

Run: `npm audit` (2026-05-09). Highlights:

- **xlsx** (via `@loaders.gl/excel`): prototype pollution / ReDoS advisories — no fix in tree yet.
- **thrift** (via `@loaders.gl/parquet`): multiple issues — no fix available at audit time.

Treat as **risk acceptance** for client-side parsing of user Excel/Parquet until upstream resolves or dependencies are swapped.

---

## 7. Lint / formatting (Biome)

Representative issues:

- **Formatting:** root `package.json` does not match Biome format output.
- **Lint:** `packages/widget/test/ui/ask-input.test.ts` — `noNonNullAssertion` (fixable with optional chaining).

Full `biome ci .` reports multiple errors across the repo; **CI pipeline using `npm run lint` will fail** until `biome format` / fixes are applied.

---

## 8. SHIP / NEEDS WORK / BLOCKED

**NEEDS WORK**

- Fix or waive Biome failures so `npm run lint` passes.
- Update Playwright specs for Phase 7 shell UI (`e2e/tests/widget.spec.ts`).
- Document or mitigate npm audit findings for Excel/Parquet ingestion.

**Strengths:** Unit/integration test depth, generation guards, SQL validator, prompt-injection handling on profile ingest, explicit browser-key guard.

---

## References

- Core orchestration: `packages/widget/src/element.ts`
- RAG: `packages/widget/src/agent/retrieval/retriever.ts`, `packages/widget/src/agent/planner.ts`
- Agentic loop: `packages/widget/src/agent/agentic/loop.ts`
- SQL validation: `packages/widget/src/agent/validate-sql.ts`
