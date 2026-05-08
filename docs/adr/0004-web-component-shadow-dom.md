# ADR 0004 — Web Component with Shadow DOM, not iframe

**Status:** Accepted · 2026-05-08

## Context

The widget must embed on arbitrary third-party sites. Two options:

1. **Iframe** — completely isolated origin, no CSS or JS bleed in either direction, easy to reason about for security. Used by Stripe Checkout, Disqus, Intercom.
2. **Web Component with Shadow DOM** — single DOM, encapsulated styles, native browser standard, lightweight. Used by Vanna's `<vanna-chat>`, GitHub's many `<*-element>` components.

## Decision

Use a **Web Component (`<geo-chatbot>`) with Shadow DOM**. No iframe.

## Consequences

**Why not iframe:**
- The dashboard injection use case (`pushData()` from the host page, `result` events back) is the strongest differentiator. Cross-frame `postMessage` plumbing for typed data with geometry is fragile and slow. A same-document Web Component just exposes methods and dispatches `CustomEvent`s.
- Iframes pin a basemap render context to a separate WebGL canvas, which is awkward when the host already has its own MapLibre canvas the agent should write to.
- Initial paint of an iframe is heavier; we have a 100 KB initial-paint budget (see PLAN.md §3).

**Why Shadow DOM is sufficient:**
- Style encapsulation is real. Host CSS does not leak into the widget. The widget's CSS does not leak out. This is the only style isolation a portfolio embed needs.
- The author is in control of every script the widget loads. There is no third-party JS executing inside `<geo-chatbot>`.

**Mitigations for the trade-offs:**
- LLM-generated content is rendered through Lit's templating, which auto-escapes. The widget never `innerHTML`s LLM output.
- Generated SQL is validated to be `SELECT`-only before reaching DuckDB. Tool args are zod-validated. See ADR 0003.
- The Anthropic API key is in `localStorage` and only sent to `api.anthropic.com`. The widget's network access is documentable and minimal.

**Open question:** if a future hosting partner requires strict iframe isolation (e.g. enterprise SSO contexts), we will ship an iframe wrapper that internally hosts the Web Component. That is purely additive; the core stays the Web Component.
