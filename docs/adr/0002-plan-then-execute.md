# ADR 0002 — Plan-then-execute agent architecture with explicit approval gate

**Status:** Accepted · 2026-05-08

## Context

A user asks a natural-language question about their data. The agent must answer correctly and the user must trust that the agent did not silently do the wrong thing. Two common patterns exist:

1. **ReAct / interleaved reasoning** — the agent thinks, calls a tool, observes, thinks again, ad infinitum. Fast for trivial questions, prone to silent drift on multi-step ones, and the user has no chance to intervene before bad work is done.
2. **Plan-then-execute** — a planner LLM emits a structured plan, the user reviews and approves, then a separate executor runs the plan deterministically. A critic LLM handles failures.

## Decision

Use **plan-then-execute with an explicit approval gate**. The user must click Approve (or Edit + Approve) before any executor runs. A Critic loop handles step failures with at most two retries.

## Consequences

- Latency rises by one round-trip for trivial questions, but the user can see *why* the agent is about to do something. For a tool whose value proposition is "trustworthy spatial analysis on your own data," this is the correct trade-off.
- The plan is a typed, versionable artifact (zod schema in `src/agent/plan.ts`). Plans are loggable, replayable, and testable independently of the LLM. This is what makes the eval harness (Phase 7) feasible.
- The approval UI is a real UX surface and a real differentiator. Most LLM-on-data tools (PandasAI, Vanna, Felt AI assistant) act first and explain after; we explain first.
- ReAct-style "agent loops" using free code generation are explicitly out of scope for v1 (see ADR 0003).
