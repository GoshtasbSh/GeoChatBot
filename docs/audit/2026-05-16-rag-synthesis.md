# Phase R.3 — RAG Synthesis (2026-05-16)

Synthesis of [`2026-05-16-rag-current.md`](./2026-05-16-rag-current.md) (current state) + [`2026-05-16-rag-research.md`](./2026-05-16-rag-research.md) (2024–2026 literature, 44 cited findings).

## What we're missing today (literature → GeoChatBot gap)

| # | Missing | Source citation | File / insert point | Est. impact | Token cost |
|---|---|---|---|---|---|
| 1 | **Prompt-injection datamarking** on `<<<UNTRUSTED_DATASET_PROFILE>>>` block. The current delimiter is plain text, not a per-session random token. | Spotlighting paper (arXiv 2403.14720), OWASP LLM01:2025 | `agent/prompts/agentic-preamble.ts` and the profile builder | Drops injection ASR from ~50 % → ~2 % | ≈ 30 tokens / call |
| 2 | **Per-question example retrieval** instead of dumping all 36 worked examples. examples.ts is ~9 KB / 9 k tokens injected every single-shot call. | CHASE-SQL (BIRD-leader 2025), CEDAR ICSE'23, arXiv 2512.04106 (Dec '25) | `agent/prompts/builders.ts`, examples.ts → existing `agent/retrieval/*` | 30–50 % cost cut on single-shot path, ≤ 0 % accuracy loss | saves 6 k tokens |
| 3 | **`reasoning_effort` per call-type** (planner=high, chat=low, critic=medium). gpt-oss-120b supports this via system prompt. | gpt-oss model card (HF), arXiv 2508.10925 | `agent/forced-tool/uf-navigator.ts`, `providers/uf-navigator.ts` | 30–40 % latency / cost on low-effort calls | trivial |
| 4 | **Harmony channel stripping** — must drop `analysis` channel before re-prompting gpt-oss in multi-turn conversations. | OpenAI gpt-oss docs (harmony format spec) | `agent/forced-tool/openai-compat.ts` / `uf-navigator.ts` history accumulator | Fixes silent tool-call quality degradation; privacy win | trivial |
| 5 | **Mini-gazetteer (Wikidata-Q-ID-keyed)** for ~100 high-ambiguity US place names. "Springfield, FL" vs other Springfields. | SNEToolkit (Elsevier 2023), Wikidata Embedding Project 2025 | new `agent/data/gazetteer-mini.json` + lookup in `tools/geocode.ts` | Eliminates wrong-Springfield class of geocode failures | ≈ 15 KB asset, ≈ 0 tokens |
| 6 | **Closed-checklist critic before `finalize_plan`** — narrow checks, not open-ended self-judge. | Self-Refine + arXiv 2512.24103 + 2025 MAR paper warning on broad self-verify FPs | `agent/validate-plan.ts` extension | Catches the most common plan bugs pre-execution | 0 LLM tokens (deterministic checklist), modest LOC |
| 7 | **Hybrid CSV semantic detection** — regex for lat/lon, state code, ZIP, country; LLM for the long tail. | codenote.net 2024 hybrid-design analysis, DuckDB sniffer doc | new `executor/runners/profile-semantics.ts` injected into dataset profile | Removes "planner picked wrong column" failures; cuts inspect-loop turns | ≈ +1 line per column |
| 8 | **Nominatim 1-rps + real User-Agent enforcement**, plus batch-size UI nudge. Stock User-Agent gets the IP blocked. | OSM Nominatim usage policy (current) | `executor/runners/geocode.ts` | Compliance + reliability (prevents IP block at scale) | trivial |
| 9 | **Previous-turn bbox → viewbox in next geocode** | Spatial-RAG arXiv 2502.18470 | `tools/geocode.ts`, `runners/geocode.ts` | Higher Nominatim hit rate when user has zoomed/filtered | 1 line |
| 10 | **`finalize_plan` last-step renderability soft-check during validation** — clearer error feedback when violated | validate-plan literature, GeoChatBot's own retry path | `agent/validate-plan.ts` | Saves retry rounds | none |

## What we're wasting tokens on today

| # | Waste | Estimated savings |
|---|---|---|
| W1 | All 36 examples shipped in every single-shot call → use MMR-retrieve top 3–5 | ≈ 6 000 tokens |
| W2 | All 50 canonical patterns shipped in every call → could retrieve top 3 (literature is more nuanced here — keep static for stability per R.1 wiring) | optional ≈ 2 500 tokens |
| W3 | Dataset profile dumps 3 sample values × every column on wide tables → cap to top 8 ambiguous columns or move to inspect.* | ≈ 500 tokens on 50-col CSVs |

## Recommendations — prioritized for THIS audit's R.4 implementation

Given the audit's scope and time-budget pressure (we still owe Phases 2–7), R.4 will implement the **highest-leverage / lowest-risk** subset first:

### Tier A — apply now (low risk, high impact)

- **R.4-a — Datamark `<<<UNTRUSTED_DATASET_PROFILE>>>` with a per-session random token** (#1 above). Add a system-prompt sentence telling the model to treat marker contents as data. Direct injection-defense win.
- **R.4-b — `reasoning_effort` system-prompt header for UF Navigator** (#3). Single-line change per call-site (planner / chat / critic).
- **R.4-c — Mini-gazetteer + viewbox lookup in `geocode.address`** (#5, partial #9). Static JSON; pure additive code.
- **R.4-d — Nominatim User-Agent + 1-rps enforcement audit** (#8). Verify present; harden if missing.
- **R.4-e — Closed-checklist plan critic** (#6). Pre-execution deterministic checks added to `validate-plan.ts`.
- **R.4-f — Hybrid semantic column tagging in dataset profile** (#7). Adds `semantic_hint?` field to each column.

### Tier B — DEFERRED (large refactor; document in final report)

- **R.4-g — Examples retrieval refactor** (#2 / W1). Touches `builders.ts`, breaks cached-prefix invariant, needs full snapshot-test update. Worth ~6 k tokens / call but high-risk to do under time pressure. Documented as a follow-up recommendation in the final report.
- **R.4-h — Harmony channel stripping** (#4). Need to confirm whether current parser already handles it (likely yes via OpenAI SDK); if not, deferred.

### Tier C — UX-only (documented for product roadmap)

- **R.4-i — Date-format confirmation UI** (#9 from research). Not in this audit's scope.
- **R.4-j — Large-batch geocode nudge in UI**. Same.

## Sampling-parameter calibration for `gpt-oss-120b`

Per the gpt-oss model card and OpenAI's published guidance:

- **temperature = 1.0** is the recommended default for tool-call work. Lower values (≤ 0.3) hurt JSON-mode reliability on this family.
- **top_p = 1.0** likewise default.
- `reasoning_effort` system header replaces temperature as the steering knob.
- For Plan + Critic: `reasoning_effort: high`.
- For chat / clarification routing: `reasoning_effort: low`.

## Why we do NOT add LATS / Tree-of-Thoughts

Research consensus: LATS shines on novel / exploratory problems. GeoChatBot's spatial questions are bounded (≤ 30 iterations) and have a clear plan-then-execute shape. LATS would inflate latency 3–5× for marginal accuracy gains. Anthropic's published "Building Effective Agents" guide explicitly recommends workflows over agents for this class of task; we already do that.

## Architecture confirmations (unchanged)

- Stay with plan-then-execute (essentially ReWOO).
- Keep agentic ReAct loop as the inspection fallback.
- Keep `gpt-oss-120b` as the recommended UF Navigator model.

— end Phase R.3 synthesis.
