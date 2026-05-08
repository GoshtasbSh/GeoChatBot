# ADR 0003 — Constrained tool calling, not free code generation, in v1

**Status:** Accepted · 2026-05-08

## Context

Once the planner has produced a plan, each step must execute against the user's data. Two design choices:

1. **Free code generation** — the LLM emits arbitrary JavaScript or Python, the runtime `eval`s it. Most flexible. Used by LLM-Geo, parts of PandasAI, OpenInterpreter.
2. **Constrained tool calling** — the LLM picks from a fixed catalog of typed tools (`buffer`, `point_in_polygon`, `aggregate`, `render_map`, …) and supplies arguments validated by zod. Used by enterprise agent systems and most production LLM apps.

## Decision

v1 uses **constrained tool calling only**. There is no `eval`, no `Function(...)`, no remote-loaded code. The tool catalog is the v1 vocabulary and is intentionally small (~10 tools). A `custom_sql` tool is allowed because SQL is parsed and validated to be `SELECT`/`WITH` only — see ADR 0004 sandboxing notes.

## Consequences

- **Safety**: the widget runs on third-party sites with the user's API key. Free code-gen would require a real sandbox (Web Worker + iframe + CSP) to be defensible; even then, we'd be responsible for any data the LLM exfiltrates by writing a `fetch`. Tool calling sidesteps that entirely.
- **Predictability**: every step is replayable. This is what makes the eval harness (Phase 7) score the agent reliably.
- **Quality**: published benchmarks (e.g. GeoBenchX) consistently show structured tool use beats free code-gen on multi-step geospatial tasks at fixed model size.
- **Cost of expansion**: every new spatial operation has to be added as a tool, with a typed signature and an executor. Acceptable for a portfolio project; the v1 catalog is small enough that this is days, not weeks.
- **Limitations accepted**: the agent cannot answer questions that fall entirely outside the tool catalog. It must say so explicitly rather than fabricate. This is desirable behaviour.

A future ADR may revisit free code-gen once the eval harness exists and gives a quantitative basis for the decision.
