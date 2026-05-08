# GeoChatBot — Plan v2 (trimmed · free · embeddable-first)

*Author: Goshtasb + Claude (Opus 4.7) · Last revised: 2026-05-07*
*Status: ready to execute. Scope is locked. Do not add features without writing them down here first.*

---

## 0. North star (read every time you open this file)

GeoChatBot is **one Web Component**, distributed three ways, that lets a user (or a developer pre-loading data) ask plain-English questions about spatial/tabular data. Analysis runs **entirely in the browser**. The agent **plans before it acts** and the user approves the plan. Hosting and dependencies are **free**.

**v1 must do exactly this much, no more:**
1. Drop a CSV (with lat/lon) or GeoJSON file → see schema + map.
2. Type a question → see a numbered plan → approve → see map / chart / table / written answer.
3. Errors are caught by a Critic loop that retries up to twice.
4. Embeddable on any site with one `<script>` tag.
5. Standalone hosted app at `/app` of the same site.
6. Headless mode for dashboards: `<geo-chatbot mode="headless">` emits events instead of rendering, so a host page can put results into its own map.
7. README has a GIF, an embed snippet, and an eval leaderboard.

Excel, Shapefile, Parquet, Pyodide, multi-LLM, custom SQL tool, proxy worker → **post-1.0**. The `shpjs` and `xlsx` deps already in `packages/widget/package.json` may stay if their loaders are trivial; if either fights for more than half a day, cut it.

---

## 1. Free stack — explicit choices (no debate during build)

| Layer | Choice | Why free / why this |
|---|---|---|
| Widget core | TypeScript + Lit + Shadow DOM | Already scaffolded. Lit is tiny (~5 KB), works as a Web Component natively. |
| Build | Vite 6 (lib mode) | Already scaffolded. |
| Data engine | DuckDB-WASM + spatial extension | Free, runs in browser. Lazy-loaded on first interaction. |
| Geometry helpers | Turf.js (subset import) | Free, MIT. Use only where SQL is awkward. |
| Map | MapLibre GL JS | Free, open-source. |
| Tiles (v1) | MapLibre demotiles + OSM raster fallback | Zero cost, OK for portfolio traffic. Switch to PMTiles on Cloudflare R2 if traffic grows. |
| Big-data layers | deck.gl | Free, MIT. Lazy-loaded. |
| Charts | ECharts | Free, Apache-2.0, smaller than Plotly. |
| LLM provider (v1) | Anthropic only, BYO key | Direct browser→Anthropic call. No backend. |
| Optional cheap path | Document Gemini Flash free tier in README | User sets their own key. |
| Hosting (site + standalone) | Cloudflare Pages **or** Vercel free tier | Cloudflare wins on egress; Vercel wins on Next.js DX. Pick one on day 1, don't switch. |
| CDN distribution | npm → jsdelivr / unpkg automatic | One-line embed. Free. |
| Eval harness | Python + Playwright in `packages/eval` | Local-only. Free. |
| Telemetry | None in v1. | If added later: self-hosted Plausible or Cloudflare Web Analytics free tier. |
| CI | GitHub Actions free tier | Sufficient. |

**Hosting decision rule:** if you want to ship the optional LLM proxy later, pick Cloudflare (Workers free tier = 100k req/day). Otherwise Vercel is fine.

---

## 2. Architecture — one component, three surfaces

```
┌─────────────────────────────────────────────────────────────┐
│  packages/widget   — the Web Component (the only product)   │
│   • <geo-chatbot>                                           │
│   • DataLoader · DuckDBEngine · MapView · ChatUI            │
│   • LLMProvider · Planner · Executor · Critic               │
│   • Modes: "full" (default) · "headless" (dashboard inject) │
└──────────────┬──────────────────────────────────────────────┘
               │ published to npm + jsdelivr
   ┌───────────┼───────────────────────────────┐
   ▼           ▼                               ▼
embed:     standalone:                    dashboard:
<script>   /app on the marketing site     pushData() + 'result' event
+ <geo-                                    in headless mode → results
chatbot/>                                  flow into host's own map
```

**Key invariant:** the standalone app and the embed share the **same** widget bundle. The standalone is a thin wrapper page that mounts `<geo-chatbot>` full-screen and persists settings to `localStorage`. Building the widget right ⇒ standalone is one afternoon.

**Headless mode contract** (the dashboard injection feature — your strongest differentiator):

```ts
const bot = document.querySelector('geo-chatbot');
bot.setAttribute('mode', 'headless');     // suppress internal map/chart UI
bot.pushData({ name: 'sales', rows, geometryColumn: 'geom' });
bot.addEventListener('plan',   (e) => showApprovalUiInHostPage(e.detail));
bot.addEventListener('result', (e) => {
  if (e.detail.kind === 'layer') hostMap.addLayer(e.detail.geojson);
  if (e.detail.kind === 'chart') hostChartLib.render(e.detail.spec);
  if (e.detail.kind === 'table') hostGrid.setRows(e.detail.rows);
});
bot.ask('Which neighborhoods sold the most?');
```

Headless mode is what makes the project genuinely novel. Spend real time on it.

---

## 3. Bundle budget (matters because it embeds on other sites)

- **Initial paint:** ≤ 100 KB gzipped. Just chat shell + welcome state.
- **First user action lazy-loads** the heavy modules: DuckDB-WASM (~3–4 MB), MapLibre (~250 KB), deck.gl (~200 KB), ECharts (~250 KB), specific Loaders.gl loaders.
- **Hard rule:** nothing heavy in the initial chunk. Use dynamic `import()` everywhere downstream of `handleFiles` and `ask`.

---

## 4. Privacy & safety guarantees (put these in the README)

- Files never leave the browser. Verifiable from network tab.
- API key stored in `localStorage` only; sent only to the configured LLM provider.
- Generated SQL is parsed and rejected if it contains anything other than `SELECT` / CTEs / `WITH`. No `INSTALL`, `LOAD`, `ATTACH`, `COPY`, `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `DROP`, `PRAGMA`.
- All tool args validated via zod before execution.
- Executors run in a Web Worker; main thread cannot eval LLM-produced strings.
- No telemetry by default.

---

## 5. Phased roadmap (revised — 8 weeks at 15–20 hr/week, 4 weeks full-time)

Each phase ends in a green CI build and a working demo. Don't start phase N+1 until phase N is demoable.

> [P] = parallelizable subtask after the prior interfaces are frozen.
> [S] = sequential, blocking.

---

### ✅ Phase 0 — Workspace · *done*
Monorepo, package.json, vite config, widget skeleton, types, dep choices already exist. **Skip.**

---

### 🔄 Phase 1 — Data + Engine + Map (in progress) · 1.5 weeks · [P internally]

**Goal:** drop a CSV with lat/lon or a GeoJSON → see schema cards + a map. No LLM yet.

Subtasks (parallelizable after `DatasetProfile` and `DuckDBEngine` interfaces are frozen):
- 1a [P] Loaders: **CSV** (lat/lon auto-detect) and **GeoJSON**. (Excel/Shapefile only if trivial — they're already wired in deps.)
- 1b [P] `DuckDBEngine`: boot WASM, install/load spatial extension, register Arrow tables as views, expose `query(sql)`.
- 1c [P] `MapView`: MapLibre + auto-fit + simple layer styling for the loaded geometry.
- 1d [P] `DatasetProfile`: typed JSON describing columns, types, ranges, nulls, geom col, bbox, CRS guess. **Other phases consume this — freeze its shape first.**

**Initial prompt for next session:**
> Continue Phase 1 of GeoChatBot. The widget is at `packages/widget`. Read PLAN.md §5 Phase 1 and the existing `src/element.ts`, `src/types.ts`, `src/data/loaders/*`, `src/data/duckdb.ts`, `src/data/catalog.ts`. (1) Finish CSV + GeoJSON loaders so they produce Apache Arrow tables and a complete `TableSchema` (incl. bbox + geometryColumn for GeoJSON, and lat/lon detection for CSV). (2) Implement `DuckDBEngine.boot()` lazy + register Arrow tables; spatial extension load with graceful fallback if it fails. (3) Add `MapView` Lit component using MapLibre with a free demo tile style; render the loaded layer auto-fit to bbox. (4) Wire it into `<geo-chatbot>` so dropping a GeoJSON shows schema card + map side-by-side. Keep Excel/Shapefile loaders behind a try/catch — if they break, mark them post-1.0 and move on. End in green typecheck + a working demo page in `examples/` that drops a fixture GeoJSON.

---

### Phase 2 — Public dev API + headless mode · 3 days · [S]

**Goal:** the developer-facing API exists even with the agent stubbed.

- Define and implement: `pushData()`, `setProvider()`, `setMode('full' | 'headless')`, `ask()`, `clear()`, `exportLayer(name)`, plus events: `'plan'`, `'result'`, `'error'`, `'progress'`.
- In headless mode, suppress internal map/chart/table renderers and instead emit events with the equivalent payloads.
- Build `examples/dashboard/` showing a Leaflet/MapLibre dashboard that consumes the events and adds a layer to its own map.

**Initial prompt:**
> Implement Phase 2 of GeoChatBot per PLAN.md §5. Add the public dev API on `<geo-chatbot>`: `pushData`, `setProvider`, `setMode`, `ask`, `clear`, `exportLayer`, plus typed CustomEvents `plan`/`result`/`error`/`progress`. Implement `mode="headless"`: in headless mode the widget renders no map/chart/table and only emits events. Build `examples/dashboard/index.html` — a plain page with its own MapLibre map; it instantiates `<geo-chatbot mode="headless">`, calls `pushData` with a fixture GeoJSON, listens for `result`, and adds resulting layers to its own map. Stub `ask()` to fire a fake plan + fake result so the event flow is testable without an LLM. Add Playwright tests for the headless contract.

---

### Phase 3 — LLM provider + BYO-key UI · 2 days · [S]

- Anthropic provider only. `LLMProvider` interface so others can be added later.
- Settings drawer inside Shadow DOM: provider dropdown (Anthropic only for now, label others "soon"), key input, persisted to `localStorage`, masked display.
- One-line consent copy: *"Your key is sent only to api.anthropic.com from your browser. Files never leave your device."*

**Initial prompt:**
> Phase 3: LLM provider abstraction + settings UI. Define `LLMProvider` with `chat(messages, tools?, options) → AsyncIterable<Chunk>`. Implement `AnthropicProvider` that calls `https://api.anthropic.com/v1/messages` directly from the browser using a user-supplied key. Build a settings panel inside Shadow DOM with provider dropdown + masked API key field, persisted to `localStorage`. Add a one-time consent banner. Update `setProvider` from Phase 2 to accept `{ name: 'anthropic', apiKey }`. No backend.

---

### Phase 4 — Planner + Plan UI + Approval Gate · ~2.5 weeks · [S]

> Updated 2026-05-08. See docs/superpowers/specs/2026-05-08-phase-4-planner-design.md and docs/superpowers/plans/2026-05-08-phase-4-planner.md.

This is the heart and the differentiator.

- `Plan` zod schema: `{ goal, steps: Step[], assumptions, dataset_refs }`
- `Step`: `{ id, tool, args, output_var, why }`
- Tool catalog v1 (25 tools — locked; see the design spec for full signatures):
  - **SQL (1):** `sql`
  - **Geometry (8):** `buffer`, `point_in_polygon`, `distance_matrix`,
    `nearest`, `convex_hull`, `centroid`, `union`, `intersection`
  - **Aggregation / stats (5):** `aggregate`, `summary_stats`,
    `correlation`, `histogram`, `topk`
  - **Transforms (3):** `filter`, `sort`, `project`
  - **Joins (2):** `attribute_join`, `spatial_join`
  - **Renderers (4):** `render.map`, `render.chart`, `render.table`,
    `render.summary`
  - **Critic helpers (2):** `clarify`, `decline`
- Planner uses Anthropic tool-use with structured output (forced
  `submit_plan` tool) and prompt caching on the system prompt + 20
  few-shot exemplars.
- Plan UI: numbered steps with Why, inline edit of args (zod-validated
  per tool), Approve / Reject. No execution before approval.

**Initial prompt:**
> Phase 4: build the Planner + Plan UI. Implement `Plan` and `Step` as zod schemas (PLAN.md §5 Phase 4). Build a typed tool registry in `src/agent/tools.ts` — each tool has a JSON-Schema arg signature and a runtime executor stub returning mock outputs. Implement `Planner.plan(question, profile, history) → Plan` using Anthropic's tool-use. Build `PlanReview` Lit component inside Shadow DOM with numbered steps, expandable Why, inline arg editing, Approve / Reject buttons. Wire `ask()` from Phase 2 to call the planner, emit a `plan` event, and only call the (still stubbed) executor on user approval. Test end-to-end with a real Anthropic key on the fixture GeoJSON.

---

### ✅ Phase 5 — Executors + Renderers · *core landed 2026-05-08*

Status: **core complete.** Tool executors registered via runtime registry,
Comlink worker scaffold + main-thread fallback, four renderers wired in
both `mode="full"` (Shadow DOM `<result-canvas>`) and `mode="headless"`
(events). Strict SQL validation per §4 enforced both pre-approval and
inside the runner. 4-step plan integration test green against the Phase 1
fixture flow.

Implemented in v1 (`src/agent/executor/`):
- 5a SQL + spatial via DuckDB: `sql`, `geometry.{buffer, centroid, intersect, union, difference, dissolve, simplify, convex_hull}`,
  `joins.{spatial_join, point_in_polygon, nearest_neighbor}`,
  `stats.{aggregate, summary_stats, distance_matrix}`
- 5c Renderers: `render.{map, chart, table, summary}` + `<result-canvas>` Lit component
- 5d Headless equivalents emit `result` events with the same payload

Deferred to Phase 5 expansion (explicit "not yet implemented" stubs):
- `geometry.voronoi` (Turf voronoi/concaveman ~10 KB lazy)
- `geometry.reproject` (proj4js ~50 KB lazy)
- `stats.{hex_bin, density_grid, morans_i, getis_ord_gi}` (h3-js + custom JS)
- ECharts mounting in full-mode chart panel (spec emitted; placeholder rendered)

Worker-via-Comlink: `src/agent/executor/{worker,client}.ts` ship the boundary;
production currently runs the executor in-process against the main-thread
DuckDB engine (Phase 1 contract). Switching to a worker-owned engine is
Phase 5 expansion.

**Initial prompt:**
> Phase 5: implement the tool executors registered in Phase 4. Run them inside a dedicated Web Worker using Comlink. SQL/spatial tools go through `DuckDBEngine`; pure geometry ops go through Turf.js where simpler. Each step's output is stored under `output_var` and is referenceable by later steps via `${var}` substitution in args. Implement the four renderers (map / chart / table / summary) — in `mode="full"` they mount inside Shadow DOM; in `mode="headless"` they emit `result` events with the equivalent payload. Strict SQL validation per PLAN.md §4: only SELECT/WITH allowed. Add integration tests running a 4-step plan end-to-end against the Phase 1 fixture.

---

### ✅ Phase 6 — Critic / error-recovery loop · *done 2026-05-08*

Status: **complete.** Critic loop landed end-to-end; integration tests engineer
real-shaped DuckDB failures (bad column name, missing CRS, persistent failure,
abort) and assert recovery within 2 retries.

Implemented in v1:
- 6a `agent/critic-llm.ts` — Anthropic Messages caller forced to `submit_diagnosis`,
  with prompt caching on the static prefix and the same browser-direct guard
  the planner uses.
- 6b `agent/prompts/critic.system.md` + `agent/prompts/critic-builders.ts` —
  system prompt with rules + tool catalogue, user-message builder that wraps
  both the DuckDB error message AND the dataset profile in `<<<UNTRUSTED…>>>`
  fences (blocks prompt-injection-via-error-text). Prior outputs are listed
  by name+kind+ref only — scalar `value` is never emitted.
- 6c `agent/critic.ts` — `Critic.diagnose(StepErrorContext)` returns a
  `CriticDecision` (patch / retry / abort). Any LLM error or schema mismatch
  is coerced to abort so the executor always makes progress.
- 6d Host wiring — `<geo-chatbot>` builds a Critic per plan run, passes
  `onStepError` to the Executor, and emits a typed `critic` event with
  `{planId, stepId, attempt, maxAttempts, decision, errorMessage, beforeArgs, afterArgs?}`.
- 6e Timeline UI — `<plan-review>` renders per-step attempt badges
  (`attempt N of M — <decision>`) plus a truncated error preview. Footer
  hides automatically once `mode='running'`.

Phase 5 alignment fixes shipped in the same phase:
- Per-tool zod-args validation on critic-patched steps (matches what
  `validate-plan.ts` does for planner output; emits `CRITIC_PATCH_INVALID`).
- Comlink worker bridge forwards `onStepError` (was silently dropped),
  via a wire-form `WireStepErrorContext` so Map serialization is robust
  across runtime variants.
- `MissingRunnerError.code` exposed so a hallucinated tool name is now
  routed through the critic loop instead of hard-halting (the executor
  looks up the runner inside the try/catch).

**Initial prompt:**
> Phase 6: implement the Critic. When an executor throws, capture `{ step, args, error_msg, dataset_profile, prior_outputs_summary }` and send it to Anthropic with a "diagnose and emit a corrected step OR declare unrecoverable" prompt. Retry the patched step up to 2 times. Show a transparent timeline of attempts in the UI (and as a `progress` event in headless mode). Add tests where a step is engineered to fail (bad column name, missing CRS) and assert recovery succeeds within 2 retries.

---

### ✅ Phase 7 Slice 1 — Dashboard chrome replacement · *done 2026-05-08*

The widget shell, not the agent loop. Replaces the giant inline drop
zone with a top-right **+ Add data** popover, mounts plan-review
inside a centered `<gcb-modal>` instead of an inline strip under the
chat, introduces a dashboard layout (`<gcb-shell>`: topbar / left
rail / 3-tab main / bottom dock), and adds persistent saved results
via `SavesStore` (localStorage v1, FIFO 200) + `<gcb-rail>`.

Spec: [`docs/superpowers/specs/2026-05-08-phase-7-dashboard-redesign-design.md`](docs/superpowers/specs/2026-05-08-phase-7-dashboard-redesign-design.md)
Plan: [`docs/superpowers/plans/2026-05-08-phase-7-dashboard-redesign-slice-1.md`](docs/superpowers/plans/2026-05-08-phase-7-dashboard-redesign-slice-1.md)

Implemented in 13 TDD-driven commits:
- 7.1 `ui/tokens.ts` — Phase 7 design tokens (light + dark + auto via `prefers-color-scheme`, reduced-motion gating).
- 7.2 `state/theme.ts` (+ tests) — pure `resolveTheme / applyTheme / subscribeOSTheme`.
- 7.3 `element.ts` styles routed through tokensCSS; reflected `theme` property + OS subscription wired into `connectedCallback` / `disconnectedCallback`.
- 7.4 `<gcb-modal>` (+ tests) — scrim, Esc, focus trap with detached-node guard.
- 7.5 `<plan-review>` re-mounted inside `<gcb-modal>`; query selectors in tests updated to walk through the modal.
- 7.6 `<gcb-upload-popover>` (+ tests) — anchored popover with drop area, Esc, outside-click, file-input value reset for re-pick.
- 7.7 Drop zone removed from `element.ts`; topbar gains the **+ Add data** button + popover.
- 7.8 `<gcb-shell>` (+ tests) — layout grid with 4 named slots and Map/Results/Detail tab strip emitting `gcb:tab`.
- 7.9 `<gcb-shell>` rendered as full-mode root in `element.ts`; existing tables + map projected into the `main` slot via slot composition.
- 7.10 `state/saves-store.ts` (+ tests) — versioned localStorage CRUD with FIFO 200 cap.
- 7.11 `<gcb-rail>` (+ tests) — datasets + saves listings, three composed events.
- 7.12 `SavesStore` + `<gcb-rail>` wired into `element.ts`; result-canvas gains a ☆ Save overlay button.
- 7.13 Bundle/test marker — 465 tests pass, typecheck clean.

**Out of Slice 1, in flight:** Slice 2 (Results gallery + Detail drill-down) and Slice 3 (standalone `/dashboard` route + ?embed= mode + a11y/E2E pass).

**Initial prompt:**
> i checked the URL of this geochatbot was very based and disguseting!!!! not modern, use design skills to create this as a dashboard that any one can use it without add to their website or dashboard … left panel for saves, three tabs (Map / Results / Detail), upload as popup, approve & run as popup not under the chat.

---

### ✅ Phase 7 — Eval harness · *scaffold done 2026-05-08*

Status: **harness scaffolded + 31/31 unit tests green; ready to run as soon
as the user has an Anthropic key + the site running on localhost.**

Implemented in `packages/eval/`:
- Python 3.11 + Playwright + Anthropic SDK + pytest. `pyproject.toml`
  installable via `uv pip install -e .` (or plain pip).
- 8 v1 tasks at `tasks/nyc_311_v1.json` — the anchor dataset is **NYC 311
  + boroughs** (synthesized 50-row CSV + 5-feature borough polygons under
  `geochatbot_eval/fixtures/`; the harness is dataset-agnostic so swapping
  to Cedar Key is a one-line config change).
- `runner.py` — Playwright driver that drives `/app`, sets the API key
  via `setProvider`, pushes the fixture, listens for `plan` / `progress`
  / `result` / `error` / `critic` events, awaits `__lastExecution`.
- `scorer.py` — plan-shape (ordered subsequence) + numeric tolerance +
  geometry feature count + text must-contain. Each task passes only if
  BOTH plan + answer pass.
- `leaderboard.py` — aggregates run JSONs into `EVALS.md`. Renders a
  "no runs yet" placeholder when no data exists, so `/evals` never 404s.
- 31 pytest cases across `test_scorer.py`, `test_tasks_schema.py`,
  `test_leaderboard.py` — all green.

To run (post-scaffold):
```bash
cd packages/eval && pip install -e . && playwright install chromium
python -m geochatbot_eval run --site http://localhost:5173/app \
  --tasks tasks/nyc_311_v1.json \
  --models claude-sonnet-4-6,claude-haiku-4-5-20251001 \
  --api-key $ANTHROPIC_API_KEY --out runs/run-001.json
python -m geochatbot_eval leaderboard --runs 'runs/*.json' --out ../../EVALS.md
```

Target: ≥80% pass rate on Sonnet. Will be measured once the user runs it.

**Initial prompt (kept for reference):**
> Create `packages/eval` (Python). Pick the anchor dataset (default to NYC 311 + boroughs unless otherwise specified). Define 15 tasks per PLAN.md §5 Phase 7 with question, acceptable plan shapes, expected answer with tolerance. Build a Playwright runner that drives the standalone `/app` page, captures `plan` + `result` events via the dev API, scores them, and writes `EVALS.md` with a Markdown leaderboard. Run on `claude-sonnet-4-6` and `claude-haiku-4-5-20251001`. Target ≥80% on Sonnet.

---

### ✅ Phase 8 — Standalone app + marketing site + README · *done 2026-05-08*

Status: **Next.js 16 site shipped at `packages/site/` with all 5 routes
building cleanly (5/5 static, all returning 200 in dev). Root README
rewritten. GIF + Vercel deploy are the only remaining manual steps.**

Implemented:
- Next.js 16 App Router, TypeScript, Tailwind 4, shadcn/ui (new-york /
  zinc) — primitives written inline (no `npx shadcn add` needed).
- `next.config.ts` with `transpilePackages: ['@geochatbot/widget']` so
  the Lit web component imports cleanly into RSC pages.
- `pnpm-workspace.yaml` created at the repo root binding
  `packages/widget` + `packages/site`.
- 5 routes: `/` (hero + 4 differentiators + embed snippet + live widget
  + leaderboard placeholder + footer), `/app` (full-viewport standalone
  widget — what the eval harness drives), `/dashboard` (headless mode
  demo), `/docs` (embed guide + dev API + privacy), `/evals` (server
  component reading `EVALS.md` from the repo root, falls open to
  placeholder when missing).
- `components/geo-chatbot-embed.tsx` — `'use client'` lazy-import wrapper
  that handles SSR-safe `customElements` mount + cleanup on unmount.
- Root `README.md` rewritten: tagline + 30-sec embed snippet + 4
  differentiators + leaderboard placeholder + project layout table.
- GIF placeholder in README to be replaced with a 90-sec screencast
  recorded post-deploy (script in §10 below).

To run locally:
```bash
cd packages/site && pnpm dev
# open http://localhost:3000 (or 5180 with --port)
```

To deploy to Vercel: `vercel deploy` from `packages/site/` (project not
yet linked; one-time setup).

**Initial prompt (kept for reference):**
> Phase 8: ship `packages/site` (Next.js, App Router, deployed to Cloudflare Pages). Pages: `/`, `/app`, `/dashboard`, `/docs`, `/evals`. Use shadcn/ui for the marketing site only (the widget itself stays vanilla — no shadcn inside Shadow DOM). Embed the widget via the published npm package. Record a 90-second screencast (script in PLAN.md §10). Rewrite the root README so above-the-fold has tagline + GIF + 30-second embed snippet + 4 differentiators + eval leaderboard table.

---

## 6. Parallelization plan (real, usable)

You can keep up to ~3 Claude Code sessions productive at once with `git worktree`:

| Block | Parallel sessions |
|---|---|
| Phase 1 | session A: 1a (loaders) · session B: 1b+1c (engine+map) · session C: 1d (profile) |
| Phase 5 | session A: 5a (SQL) · session B: 5b (Turf) · session C: 5c+5d (renderers) |
| Phase 7+8 | session A: eval harness · session B: site + README + GIF |

Phases 2, 3, 4, 6 are sequential — no real parallelism possible.

---

## 7. Risks & mitigations (short)

| Risk | Mitigation |
|---|---|
| Scope creep | Re-read §0 before any "what about…" |
| WASM 4 GB ceiling | Keep anchor dataset small; document limit |
| LLM produces unsafe SQL | §4 validator; tool-call args validated by zod |
| Bundle bloat killing embeds | §3 budget enforced via `vite-bundle-visualizer` in CI |
| Free tile provider rate-limits | Use MapLibre demotiles; document upgrade path |
| You stop after Phase 5 thinking it's done | It isn't. Phases 7 + 8 are why this gets you noticed. |

---

## 8. First-day checklist (do these before writing any more code)

- [ ] Pick anchor dataset (recommend: NYC 311 + boroughs OR your Cedar Key data — pick one, today)
- [ ] Pick hosting (Cloudflare Pages or Vercel — pick one, today)
- [ ] Pick ship date (recommend: 8 weeks out — write it in your calendar)
- [ ] Pick npm package name (`geochatbot` is taken? check with `npm view geochatbot`. Backups: `geomind`, `mapchat`, `cartochat`, `chatgeo`)
- [ ] Write the README skeleton (tagline, GIF placeholder, embed snippet, 4 differentiators, eval table placeholder)
- [ ] Inspect what's done in `packages/widget/src/data/` — list of completed loaders vs stubs

---

## 9. Open decisions awaiting your input

1. **Anchor dataset** — NYC 311 + boroughs (lots of points, classic), or your Cedar Key data, or other?
2. **Hosting** — Cloudflare Pages (truly free egress, lets you add a Worker proxy later) or Vercel (Next.js DX nicer)?
3. **npm name** — `geochatbot` or alternative?

These don't block Phase 1 work but they block Phase 8.

---

## 10. 90-second screencast script (write now, record at Phase 8)

```
0:00 — "GeoChatBot. Ask plain-English questions about your geospatial data,
       in your browser. No server. No upload."
0:08 — drop a GeoJSON file on the widget; map renders.
0:14 — type: "buffer all schools 500 m and find which fall in flood zones"
0:18 — plan appears, 3 numbered steps. Click Approve.
0:22 — map updates with buffers + highlighted intersections. Summary text
       appears: "127 of 412 schools fall within flood zones."
0:35 — switch to dashboard demo: same widget in headless mode injected
       into a Mapbox dashboard. Result appears in the host's own map.
0:55 — switch to evals page: Sonnet 87%, Haiku 74% on 15 spatial tasks.
1:05 — show embed snippet — one script tag.
1:15 — "MIT licensed. BYO API key. Files never leave your browser."
1:25 — github.com/<you>/geochatbot
1:30 — end.
```

Write it now. Build to fit it. Don't drift.
