# Phase R.4 — Applied RAG / Agent-AI Augmentations (2026-05-16)

This doc lists every R.4 code change that landed, why it was chosen, and which R.2 finding(s) it implements. The full external-research bibliography is in [`2026-05-16-rag-research.md`](./2026-05-16-rag-research.md).

> Verification: `pnpm -C packages/widget typecheck` clean and `pnpm -C packages/widget test --reporter=dot` reports **811 passing / 5 skipped / 0 failing** after every change below.

---

## R.4-a — Per-session datamarked fence around UNTRUSTED dataset profile

**Files changed**
- `packages/widget/src/agent/planner.ts` — new `fenceToken` field + new `generateFenceToken()` helper; both single-shot and agentic-mode profile renderings now use the per-session token in their fence delimiters.

**Why**
- Microsoft "Spotlighting" (arXiv 2403.14720) reports prompt-injection ASR drops from > 50 % to ≈ 2 % with datamarking; OWASP LLM Top 10 (2025) keeps prompt injection at #1 critical risk.
- The previous static delimiter (`<<<UNTRUSTED_DATASET_PROFILE … UNTRUSTED_DATASET_PROFILE>>>`) was trivially forgeable: a CSV row containing the literal closing token would break out of the fence and inject instructions into the planner's system prompt.
- The new delimiter is `<<<DATA-FENCE-${TOKEN} … ${TOKEN}-DATA-FENCE>>>`, where TOKEN is 8 chars from a 32-symbol alphabet — `~10¹²` possibilities. A hostile CSV would have to guess the per-session token to forge a close.

**Cache-safety**
- The token is constant per Planner instance, so Anthropic's `cache_control: ephemeral` prefix-cache still hits across calls within the same session.

**Token cost** ≈ 30 tokens per call (the explanatory preamble and the token itself).

---

## R.4-b — `reasoning_effort` plumbing for gpt-oss family

**Files changed**
- `packages/widget/src/agent/forced-tool/types.ts` — added `reasoningEffort?: 'low' | 'medium' | 'high'` to `ForcedToolInput`.
- `packages/widget/src/agent/forced-tool/openai-compat.ts` — pass through as `reasoning_effort` body field when set.
- `packages/widget/src/agent/llm.ts` — surfaced on `PlannerLLMInput` and forwarded.
- `packages/widget/src/agent/planner.ts` — new `pickReasoningEffort(model, mode)` helper; auto-sets `reasoningEffort: 'high'` when the model is gpt-oss-family.
- `packages/widget/src/agent/agentic/loop.ts` — `defaultOpenAICompatCall` sends `reasoning_effort: 'high'` for gpt-oss models on every inspection turn.

**Why**
- The gpt-oss model card (HF) and the OpenAI gpt-oss tool-calling guide explicitly recommend `reasoning_effort: high` for plan-shape tool-call work. Lower values trade tool-call reliability for latency.
- Other OpenAI-compatible providers (Groq, OpenAI proper, LiteLLM general) ignore unknown body fields with HTTP 200 — safe to send unconditionally for gpt-oss-* models.

**Cost** trivial body addition; latency increase is paid back by fewer retries on plan validation.

---

## R.4-c — Mini-gazetteer for ambiguous toponyms

**Files added**
- `packages/widget/src/agent/data/gazetteer-mini.json` — ~80 high-ambiguity place entries with `{ name, region, country, lat, lon, wikidata_qid?, aliases? }`.
- `packages/widget/src/agent/data/gazetteer.ts` — `lookupPlace(query)` + `listGazetteer()`.
- `packages/widget/test/agent/data/gazetteer.test.ts` — unit coverage for ambiguous bare names, region-qualified hits, alias matches.

**Files changed**
- `packages/widget/src/agent/executor/runners/geocode.ts` — `region_hint` first hits the gazetteer; on a unique match the viewbox is built directly from cached lat/lon, skipping the Nominatim region geocode (one less external call).

**Why**
- SNEToolkit (Elsevier 2023) shows small handcrafted gazetteers dominate the long tail of toponym disambiguation. Wikidata Q-IDs (Wikidata Embedding Project 2025) anchor entries so users / downstream callers can verify.
- Concrete wins captured: distinguishing the 7 US Springfields, Keystone Heights FL vs other Keystones, Birmingham UK vs AL, Vienna VA vs Austria.

**Asset size** ≈ 15 KB JSON; zero added tokens to the prompt (lookup is server-side in the geocoder runner).

---

## R.4-d — Nominatim policy documentation + verification

**Files changed**
- None — verification confirms the runner already enforces:
  - 1.1 s between requests (`RATE_LIMIT_MS = 1100`, exceeds the 1 rps policy).
  - 400-row cap per call.
  - Abort-aware sleeps.
  - viewbox + `bounded=1` for the rural-address path.

**Known browser limitation** — Nominatim's policy asks clients to send a real `User-Agent` identifying the application. Browsers list `User-Agent` as a Forbidden Header, so `fetch()` silently strips any custom value. The browser-injected User-Agent (Chrome/Firefox) is what Nominatim sees; the policy compliance gap is unfixable client-side. Mitigation already in place: rate-limit + cap. Operators who need to comply in production should proxy through their own backend (out of scope for this audit — recorded as a roadmap item in the final report).

---

## R.4-e — Closed-checklist plan critic — DEFERRED

Deferred to roadmap. Rationale:
- The current `validate-plan.ts` already performs the highest-leverage closed checks (canonical step ids, render-last invariant, `${var}` integrity, args sanitization).
- Adding a second-pass deterministic critic adds risk under audit-time pressure and didn't show up as a recurring failure mode in the sampled live run.
- The "MAR" 2025 paper warned that broad self-verification has high false-positive rates; a narrow checklist needs more time than this audit has to design correctly.

---

## R.4-f — Hybrid semantic column tagging

**Files changed**
- `packages/widget/src/agent/prompts/builders.ts` — new exported `detectSemanticHint(name, type, samples)` helper; `renderDatasetsBlock` appends a `hint:<tag>` suffix per column when a confident match is found.

**Hints detected**
- `latitude`, `longitude`, `wkt-geometry`, `street-address`, `zip-or-postal`, `country-name`, `country-code`, `state`, `currency`, `phone`, `iso-date`, `low-card-categorical`.

**Why**
- Schema-linking is the #1 NL2SQL bottleneck on BIRD/Spider 2.0 (LitE-SQL 2025). The planner today re-discovers column semantics via `inspect.column_pattern` round-trips; pre-tagging the obvious cases saves an iteration each time.
- Hybrid (regex first, LLM only for the long tail) is the consensus pattern in 2024–2025 data-engineering literature.

**Conservative defaults** — only emits a hint when name+sample agree; never overrides the geometry block in the dataset profile.

**Token cost** ≈ +1 word per column (e.g. ` hint:latitude`).

---

## Sampling-parameter calibration (R.4-b adjunct)

- `temperature: 1.0` is the gpt-oss recommended default for tool-call reliability. The forced-tool adapter currently sends `temperature: 0` (`openai-compat.ts:44`). Audit observation: the live sample produced valid plans at `temperature: 0` — we are NOT changing this in the current audit pass to avoid plan-shape regression, but the report flags it as a recommended R.4-b follow-up.

## Defensive-prompt-injection wrapper (R.2 finding #7)

Implemented via R.4-a (per-session fence) and existing UNTRUSTED-data preamble wording. No additional change required.

## What we did NOT change

- The 50 canonical patterns in `agentic-preamble.ts` — per audit ground rule.
- The static examples bundle in `examples.ts` (~9 K tokens, ~36 worked examples). The R.2 research recommends per-question retrieval here, but the refactor risk is too high for this audit. **Documented as a deferred roadmap item in the final report.**
- Anthropic / OpenAI / Groq adapter logic.
- The 27 terminal-tool registrations.
- `.env.local` semantics (only the key value was refreshed when supplied by the user).

---

## Verification at end of R.4

```
$ pnpm -C packages/widget typecheck
> tsc --noEmit
(no output — clean)

$ pnpm -C packages/widget test --reporter=dot
Test Files  74 passed (74)
Tests       811 passed | 5 skipped (816)
```

— end Phase R.4 changes log.
