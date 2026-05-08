# ADR 0001 — TypeScript for the widget core; Pyodide as optional power mode

**Status:** Accepted · 2026-05-08
**Supersedes:** —

## Context

The product is an embeddable Web Component that ships to arbitrary websites via a `<script>` tag. The author prefers Python and considered building the widget around Pyodide + GeoPandas so that all spatial logic could be Python.

## Decision

The widget core is **TypeScript**. Pyodide is **not** part of v1. It is reserved as an optional, lazy-loaded "power mode" reachable from a settings toggle in a post-1.0 release.

## Consequences

**Why TypeScript wins for the core:**
- Pyodide adds ~15 MB of runtime download before any user code runs. That is unacceptable for a widget that must embed on third-party sites; bundle budget is the single hardest UX constraint (see `PLAN.md` §3, ≤ 100 KB initial paint).
- Lit + Web Components is the native way to ship encapsulated UI to any framework. Python in the browser does not change this; the boundary still has to be JS.
- DuckDB-WASM's spatial extension already covers ~90% of the operations the agent needs without leaving the browser's WASM space.
- TypeScript types travel with the public API, which matters for the developer-injection use case (`pushData`, events).

**Why Pyodide stays on the roadmap:**
- GeoPandas, scikit-learn, and shapely cover edge cases DuckDB-WASM does not (advanced topology, ML on geometries). For the small fraction of users who need them, lazy-loading Pyodide on demand is fine because they have already opted into a heavier session.

**Trade-offs accepted:**
- Author gains less Python practice on this project. Mitigation: the eval harness (`packages/eval`) is Python.
- Some operations may need to be implemented twice (TS in v1, Python in optional mode). Acceptable; the tool catalog is small.
