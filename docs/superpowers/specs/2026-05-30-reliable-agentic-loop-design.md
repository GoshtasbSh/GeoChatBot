# GeoChatBot · Reliable Agentic Loop — Design

*Author: Goshtasb + Claude (Opus 4.8) · Drafted: 2026-05-30 · Status: Approved (design) · Pending implementation plan*

---

## 0. Overview

GeoChatBot reliably handles the datasets it was built against, but **fails on new, messy, real-world data** in three recurring ways:

1. **Hard errors / dead-ends** — a runtime step fails (e.g. `geocode.address` resolved 0/317) and the agent dumps a red error instead of recovering.
2. **Confidently wrong output** — no error, but the result is useless and the agent doesn't notice (e.g. a geocoded map where 264 of 306 points render the *same* color because of a palette hash collision).
3. **Can't handle messy columns** — free-text statuses (185 distinct values in one column), street-only addresses with no city/state, irregular headers.

This spec defines a redesign of the agent's **reason → execute → verify → recover** loop plus a set of **self-grounding geo primitives**, so the system produces a *sane outcome or an honest failure* on data it has never seen — on the UF Navigator provider (gpt-oss-120b), with RAG and the existing agentic ReAct loop.

### 0.1 Root-cause diagnosis (why this happens)

The current architecture (`packages/widget/src/agent/agentic/loop.ts` → `executor/executor.ts`) is actually well-built:

- It **inspects** data before planning (`inspect.list_columns`, `sample_rows`, `distinct_values`, `column_pattern`, `probe_sql`).
- It has a **critic-driven retry** that patches step *arguments* on a thrown error (`onStepError` → `patch | retry | abort`).

But it has two structural gaps:

- **No outcome verification.** The critic only asks "did this step *throw*?" — never "did this step produce a *useful result*?" A geocode that resolves 0 rows, or a color-by that collapses to one color, passes every existing check.
- **No strategy-level recovery, and no infra-vs-logic distinction.** When geocoding returned 0/317 the real cause was a missing dev proxy (infrastructure). The critic kept patching *arguments* (`region_hint`, columns) — which can never fix an infra problem — burned its retry budget, and dead-ended. It cannot tell *"my plan is wrong"* from *"the environment is broken."*

Plus a **grounding gap**: the planner guesses `region_hint` / column roles instead of deriving them from the data.

### 0.2 Goals

- On a **new dataset**, the agent either produces a result that passes deterministic outcome guards, or fails **honestly** with a specific, actionable reason — it (almost) never dead-ends on a bare error and never silently ships a degenerate result.
- The weak model has **less to get wrong**: high-value geo operations (geocode, status bucketing, region inference) are self-configuring.
- Reliability comes first; extra latency / LLM round-trips on hard queries are acceptable (user-confirmed: "reliability first," 10–30s OK).

### 0.3 Non-goals

- ❌ Replacing the existing inspection phase or the executor's single-step critic — we **wrap and extend**, not rewrite.
- ❌ Changing the human plan-approval gate / Plan UI.
- ❌ Raster / network / hydrology / PostGIS scope (still out, per project positioning).
- ❌ Swapping the LLM provider. UF Navigator (gpt-oss-120b) stays the default; the design must work *with* a mid-tier open model, not depend on a frontier model.

---

## 1. Architecture

### 1.1 The new control loop

Today:

```
inspect → finalize_plan → execute (critic patches args on throw) → render OR red error
```

New (additions in **bold**):

```
PROFILE dataset (deterministic, once per dataset)
   └─► inspect → plan → execute → VERIFY OUTCOME
                                    ├─ good          → done
                                    ├─ bad (logic)   → RECOVER: re-plan w/ failure reason  (≤ K attempts)
                                    └─ bad (infra)   → STOP, surface exact fix (no wasted retries)
   if still bad after K attempts   → HONEST failure (specific reason + what the user can do)
```

### 1.2 Module layout

| Module | Responsibility | New / changed |
|---|---|---|
| `agent/profile/dataset-profiler.ts` | Deterministic per-column profiling + semantic role + region inference | **new** |
| `agent/agentic/orchestrator.ts` | The outer attempt loop: plan → execute → verify → classify → recover | **new** |
| `agent/verify/outcome-guards.ts` | Deterministic result guards per output kind | **new** |
| `agent/verify/failure-classifier.ts` | infra-vs-logic classification of a failure | **new** |
| `agent/executor/runners/geocode.ts` | Add self-config: auto-detect address cols + infer region | **changed** |
| `agent/executor/runners/bucketize.ts` | Free-text categorical → clean N-bucket derived column | **new** |
| `agent/agentic/loop.ts` | Accept injected `DatasetProfile` + recovery context in the prompt | **changed** |
| `ui/MapView.ts` | `computeLegend` degeneracy check already exists — **reused** by a guard | reused |
| `element.ts` | Call the orchestrator instead of executor directly; render honest-failure UI | **changed** |

Design principle: the executor keeps its single responsibility (run one plan, single-step critic). The orchestrator owns the *outer* loop. Each new unit is independently testable with a clear interface.

---

## 2. Component: Dataset Profiler  (`agent/profile/dataset-profiler.ts`)

Runs **once per dataset** at ingest (CSV/GeoJSON/Parquet loaders → `element.ts pushData`). Pure/deterministic; no LLM.

### 2.1 Output type

```ts
interface ColumnProfile {
  name: string;
  dtype: "string" | "number" | "boolean" | "date" | "geometry";
  nullPct: number;            // 0..1
  distinctCount: number;
  distinctRatio: number;      // distinctCount / nonNullCount
  samples: string[];          // up to 5 representative values
  role:
    | "address" | "city" | "state" | "zip" | "country"
    | "lat" | "lon" | "geometry"
    | "category"              // clean categorical, low distinctRatio
    | "free_text_category"    // categorical-ish but high distinctRatio → needs bucketing
    | "temporal" | "measure" | "id" | "unknown";
  needsBucketing: boolean;    // true for free_text_category used as a grouping target
}

interface DatasetProfile {
  rowCount: number;
  columns: ColumnProfile[];
  inferredRegion?: { label: string; lon: number; lat: number; source: "zip" | "city_state" | "coords" | "none" };
}
```

### 2.2 Role detection (deterministic rules, ordered)

- **address**: header matches `/address|addr|street|location/i` **and** sample values match a street pattern (`^\s*\d+\s+\w+`); OR ≥60% of samples match the street pattern.
- **city/state/zip/country**: header match + value shape (zip = 5-digit, state = 2-letter or known names).
- **lat/lon**: header match `/lat|lon|lng|latitude|longitude/i` + numeric in valid ranges; **geometry**: WKB/WKT/GeoJSON geometry column.
- **category** vs **free_text_category**: a static, deterministic split on `string` columns — `category` when `distinctRatio ≤ 0.5` (already clean enough to group/color by directly); `free_text_category` when `distinctRatio > 0.5` (too many distinct values to be a useful grouping target as-is). `needsBucketing = (role === "free_text_category")`. The profiler does **not** need to know the eventual grouping target; the planner consults `needsBucketing` when a user asks to color/group by such a column and inserts a bucketize step first (see §5.2).
- **temporal**: parseable dates. **measure**: numeric not lat/lon/id. **id**: header `/id$/i` + near-unique.

### 2.3 Region inference

If the data has city/state or zip columns → derive a region centroid from the modal value (via the existing mini-gazetteer in `agent/data/gazetteer.ts`, extended as needed). If it has lat/lon → centroid of coordinates. Else `source: "none"` and the geocoder will ask once or require an explicit hint. **This replaces the planner hallucinating `region_hint`.**

### 2.4 Injection

`DatasetProfile` is serialized compactly into the planner preamble (`agent/prompts/builders.ts`) so every plan is grounded in real column roles and the inferred region.

---

## 3. Component: Outcome Verifier  (`agent/verify/outcome-guards.ts`)

After plan execution, run deterministic guards over the produced outputs. **No LLM** unless escalated.

### 3.1 Guards

```ts
interface GuardResult {
  ok: boolean;
  severity: "ok" | "warn" | "fail";
  reason: string;          // human + machine readable
  suggestedFix?: string;   // injected into recovery prompt
}
```

| Output kind | Guard | Fail condition |
|---|---|---|
| geocoded layer | match-rate | `matched / attempted < 0.30` |
| any layer | non-empty | `featureCount === 0` |
| any geo layer | plausible bbox | centroid > ~2° outside `inferredRegion` (when known) |
| color-by render | not degenerate | reuse `computeLegend` warning: ≤2 colors on ≥20 features, **or** ≥90% in one bucket, **or** `< 2` distinct swatches |
| stats / report | substantive | empty rows, or all-NaN / all-null measure |

The color-by guard **reuses the existing `LegendSpec.warning` + the distinct-swatch count** from `ui/MapView.ts` — no new color logic.

### 3.2 LLM judge (escalation only)

When all deterministic guards pass but semantic fit is uncertain (e.g. ambiguous "answer the question" cases), one cheap LLM call: *"Given the user asked Q and the result is R-summary, does this answer it? {ok|no, reason}."* Skipped entirely when guards already fail (recovery triggers directly) or clearly pass.

---

## 4. Component: Failure classification + recovery

### 4.1 Failure classifier  (`agent/verify/failure-classifier.ts`)

Given a thrown error **or** a failed guard, classify:

- **infra** — network error, CORS, non-JSON response from an API path, HTTP 5xx, "all providers returned 0 with valid-looking inputs," abort. Signal: the *inputs were reasonable* but the *environment failed*.
- **logic/data** — validation error, wrong/missing column, empty/degenerate result with resolvable inputs, bad region.

Classification is rule-based first (error codes, response shapes), with a fallback heuristic (e.g. geocode 0% **and** the address column looks valid per profile → likely infra; 0% **and** address column is street-only with no region → logic).

### 4.2 Recovery loop (in the orchestrator)

```
attempt = 1
while attempt ≤ K (default 2):                 # K bounded for cost
   plan = planner.plan(profile, query, recoveryContext?)
   result = executor.execute(plan)
   verdict = verify(result, profile, query)
   if verdict.ok: return result
   cls = classify(verdict | result.error)
   if cls === "infra":
       return HonestFailure(infra, fix=cls.suggestedFix)   # don't re-plan
   recoveryContext = buildRecoveryContext(plan, verdict)    # failure reason + suggestedFix
   attempt++
return HonestFailure(logic, lastVerdict.reason, lastVerdict.suggestedFix)
```

`buildRecoveryContext` injects, into the next planner call: the failed plan summary, the guard `reason`s and `suggestedFix`es, and an explicit directive to try a **different strategy** (different columns / bucketize first / different region / use a different runner) — not merely re-emit the same plan.

### 4.3 Honest failure surface (`element.ts`)

`HonestFailure` renders a clear card, never a bare stack trace:

- **infra**: *"Couldn't reach the geocoding service. Fix: restart the dev server so the `/api/census-geocode` proxy is active (or configure it in production)."*
- **logic**: *"These addresses are street-only with no city/state, so they can't be placed on a map. Add a city/state column, or tell me the town and I'll retry."*

---

## 5. Component: Self-grounding geo primitives (the "B" half)

### 5.1 Smart geocoder (`runners/geocode.ts`, extended)

- Accept minimal args; **auto-detect** address column(s) from the `DatasetProfile` (role `address` + supporting `city/state/zip`) when not explicitly given.
- **Infer `region_hint`** from `profile.inferredRegion` rather than the LLM guessing.
- Keep the existing Census → Nominatim fallback and rate limits. Return `{ matched, attempted }` so the match-rate guard can read it.

### 5.2 Auto-bucketizer (`runners/bucketize.ts`, new)

- Input: a `free_text_category` column + optional target bucket count.
- **Deterministic keyword rules first** (domain lexicon: completed/refused/inaccessible/no-answer/vacant/…), producing a clean derived column.
- **Optional LLM labeling** only for the residual "other" values that no rule matched, to name a small number of extra buckets.
- Output: a new column (e.g. `status_bucket`) the color-by / group-by can use. This is what makes "color by status" meaningful on a 185-distinct free-text column automatically.

The planner is taught (via preamble + a worked example) to **bucketize before color-by** whenever a grouping target has role `free_text_category`.

---

## 6. RAG integration

Per query, retrieve and inject (extends the existing `agent/retrieval`):

1. **Geo-playbook snippets** — short, deterministic how-tos ("street-only addresses need a region; bucketize free-text before color-by").
2. **Past successful plans** — keyed by a **dataset-profile signature** (role multiset + question intent). On a verified-good outcome, store `{profileSignature, query, plan}`; on a similar future query, retrieve it as a few-shot. The system **gets more reliable with use**. Hook implemented now; store grows over time.

---

## 7. Testing strategy

The principle that makes this durable: **a test that drives genuinely messy, never-before-seen data through the entire loop and asserts a sane outcome.** Such a test would have caught *both* bugs found on 2026-05-30.

### 7.1 Integration (the headline)

- `test/integration/reliable-loop.community-survey.test.ts`: feed the real `public/community_survey_raw.csv` through profile → plan → execute → verify headless (geocode stubbed to a deterministic fixture to avoid network in CI), asserting:
  - profiler tags `Address` as `address`, `First attempt` as `free_text_category` (`needsBucketing`), infers the region;
  - the loop bucketizes status, geocodes, and renders a **non-degenerate colored map** (≥2 distinct swatches, no degeneracy warning);
  - an **infra-injected** variant (geocode returns 0 with valid inputs) yields an **infra HonestFailure**, *not* a re-plan storm.

### 7.2 Unit

- Profiler role detection (address/zip/free-text/lat-lon/temporal) + region inference.
- Each outcome guard (match-rate, non-empty, bbox, color degeneracy reuse, stats).
- Failure classifier (infra vs logic) across representative error shapes.
- Auto-bucketizer keyword rules + residual handling.
- Orchestrator recovery loop: re-plans once on logic failure, stops immediately on infra, caps at K, returns honest failure.

### 7.3 Regression (already landed 2026-05-30, keep)

- `test/ui/mapview-legend.test.ts` — distinct-swatch / no-collision guarantee.

---

## 8. Rollout / sequencing

1. Dataset Profiler + injection (grounding) — unlocks everything downstream.
2. Outcome guards + reuse of the legend degeneracy check.
3. Failure classifier + orchestrator recovery loop + honest-failure UI.
4. Self-grounding geocoder + auto-bucketizer + planner teaching.
5. RAG success-plan store.
6. Integration + unit tests throughout (TDD per unit).

Each step is independently shippable and testable; the loop degrades gracefully if a later step isn't present yet.

---

## 9. Success criteria

- The real `community_survey_raw.csv` "color by status" request produces a **non-degenerate colored map** end-to-end with no manual intervention.
- A simulated infra outage surfaces an **actionable infra message**, not a dead-end or a retry storm.
- A street-only-no-region dataset yields an **honest, specific logic failure**, not a silent empty map.
- No silent degenerate outputs: every shipped result passed the outcome guards (or was explicitly flagged).
