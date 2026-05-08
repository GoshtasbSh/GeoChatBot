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

### Phase 5 — Executors + Renderers · 1.5 weeks · [P]

Implement each tool. Run them in a Web Worker via Comlink. Wire renderers.

Subtasks parallelizable after Phase 4 freezes signatures:
- 5a [P] SQL + spatial executors via DuckDB-WASM (with strict SQL validation per §4)
- 5b [P] Turf-based executors (buffer / distance) where SQL is awkward
- 5c [P] Renderers: map (MapLibre layer), chart (ECharts), table (virtualized grid), summary (markdown)
- 5d [P] Headless equivalents that emit events instead of rendering

**Initial prompt:**
> Phase 5: implement the tool executors registered in Phase 4. Run them inside a dedicated Web Worker using Comlink. SQL/spatial tools go through `DuckDBEngine`; pure geometry ops go through Turf.js where simpler. Each step's output is stored under `output_var` and is referenceable by later steps via `${var}` substitution in args. Implement the four renderers (map / chart / table / summary) — in `mode="full"` they mount inside Shadow DOM; in `mode="headless"` they emit `result` events with the equivalent payload. Strict SQL validation per PLAN.md §4: only SELECT/WITH allowed. Add integration tests running a 4-step plan end-to-end against the Phase 1 fixture.

---

### Phase 6 — Critic / error-recovery loop · 3 days · [S]

On step failure: capture context, ask LLM to either patch the step or declare unrecoverable. Max 2 retries. Show a transparent timeline.

**Initial prompt:**
> Phase 6: implement the Critic. When an executor throws, capture `{ step, args, error_msg, dataset_profile, prior_outputs_summary }` and send it to Anthropic with a "diagnose and emit a corrected step OR declare unrecoverable" prompt. Retry the patched step up to 2 times. Show a transparent timeline of attempts in the UI (and as a `progress` event in headless mode). Add tests where a step is engineered to fail (bad column name, missing CRS) and assert recovery succeeds within 2 retries.

---

### Phase 7 — Eval harness · 1 week · [P with Phase 8]

The thing that turns this from demo to portfolio standout.

- `packages/eval` (Python + Playwright). 1 anchor dataset. ~15 tasks.
- Each task: `{ question, acceptable_plan_shapes, expected_answer (numeric/geometric with tolerance) }`.
- Runner drives the standalone app headlessly, captures plan + result, scores, emits a Markdown leaderboard.
- Run on Claude Sonnet 4.6 + Haiku 4.5 minimum.

**Initial prompt:**
> Create `packages/eval` (Python). Pick the anchor dataset (default to NYC 311 + boroughs unless otherwise specified). Define 15 tasks per PLAN.md §5 Phase 7 with question, acceptable plan shapes, expected answer with tolerance. Build a Playwright runner that drives the standalone `/app` page, captures `plan` + `result` events via the dev API, scores them, and writes `EVALS.md` with a Markdown leaderboard. Run on `claude-sonnet-4-6` and `claude-haiku-4-5-20251001`. Target ≥80% on Sonnet.

---

### Phase 8 — Standalone app + marketing site + README + GIF · 1 week · [P with Phase 7]

One Next.js app on Cloudflare Pages (or Vercel):
- `/` — landing with embedded widget, embed snippet, 4 differentiators
- `/app` — full-screen standalone widget
- `/dashboard` — Phase 7 dashboard demo
- `/docs` — embed guide, dev API reference, security model
- `/evals` — leaderboard from Phase 7

Record 90-second screencast. README rewritten with GIF + embed snippet + leaderboard above the fold.

**Initial prompt:**
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
