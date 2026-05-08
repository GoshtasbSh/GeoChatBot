# GeoChatBot · Phase 7 Design — Dashboard Redesign

*Author: Goshtasb + Claude (Opus 4.7) · Drafted: 2026-05-08 · Status: Pending review · Supersedes ad-hoc UI scattered across `element.ts`*

---

## 0. Overview

This spec defines the visual + interaction redesign of the GeoChatBot
widget into a proper **dashboard** that any user can run standalone or
embed in their own site. It is the first design milestone after the
core agent loop landed (Phases 4–6).

It does NOT change agent behavior, the tool catalog, the validator, the
critic, or any provider plumbing. Everything below is presentation
layer + IA + persistence-of-saves.

### 0.1 Why now

Phases 4–6 shipped a working agent loop, but the UI was a single
vertical card with a giant drop zone, schema tables stacked under it,
and the plan-review appearing inline below the chat. After the user
opened the deployed URL and called it _"very basic and disgusting"_,
we did a four-variant design review and locked in a paired-theme
system (B+C blend) on 2026-05-08. The mockups live at
`mockups/{A,B,C,D,E-blend}.html`; this spec turns the approved blend
into a buildable plan.

### 0.2 Goals (in priority order)

1. **Replace the chrome that the user called out.** Compact upload
   button (top-right) opening a popover instead of a giant drop zone.
   Plan-review opens as a centered modal, not inline under the chat.
2. **Add a left rail with persistent Saved results.** Users should be
   able to pin any agent output and click into it later in the
   session — and across sessions via localStorage.
3. **Add 3-tab main area** — Map · Results · Detail — so the dashboard
   has clear modes instead of a single vertical scroll.
4. **Establish a unified design system.** Light=Cartograph
   (paper/emerald), dark=Atlas-Pro (ink/lime), single Geist +
   Newsreader + JetBrains Mono type stack, one shape language.
5. **Standalone /dashboard route AND iframe-embeddable widget** —
   one codebase, two entry points. The current `<geo-chatbot>`
   element keeps its public API; the dashboard is a thin shell
   over the same internal state.

### 0.3 Non-goals for Phase 7

- ❌ Real-time collaboration (no presence cursors, no shared sessions).
- ❌ A backend / accounts / multi-tenant DB. Saves stay in
  localStorage; export/import via JSON file is post-Phase 7.
- ❌ Mobile-native parity. The dashboard targets ≥1024 px desktop;
  the embedded widget collapses gracefully but is not the focus.
- ❌ Re-skinning marketing pages. Out of scope.
- ❌ A new agent / planner / critic. Behavior unchanged.

### 0.4 Out-of-scope but flagged for follow-up

- File export of saved results (PNG / CSV / GeoJSON). Cards have a
  Share button that copies a deep-link, but the round-trip
  serializer is a Phase 7.5 deliverable.
- Iframe `postMessage` API surface for hosts to drive the embedded
  widget. Today the host uses the imperative widget API; an iframe
  bridge is post-Phase 7.

---

## 1. Information Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ Topbar:  [G GeoChatBot] · cwd-crumb · ⌘K · 🌓 · ⚙ · share · +Add │
├────────────────┬─────────────────────────────────────────────────┤
│ Left Rail      │ Tab strip: [Map] [Results] [Detail]   ⟳ ⊜ ⤓     │
│  Datasets (n)  ├─────────────────────────────────────────────────┤
│   ● ports.csv  │                                                 │
│   ● coastline  │              ACTIVE TAB CONTENT                 │
│                │   Map:     full-bleed MapLibre + deck.gl,       │
│  Saved (n)     │            float-overlay legend & stat strip    │
│   ▣ throughput │   Results: gallery of saved cards               │
│   ▣ top-10     │   Detail:  drill-down on selected save          │
│   ▣ buffer     │                                                 │
│   …            │                                                 │
├────────────────┴─────────────────────────────────────────────────┤
│ Bottom dock: ▎last-result-preview │ ask input ………………… [↵ Run]   │
└──────────────────────────────────────────────────────────────────┘
            (Approve&Run modal floats above when triggered)
```

### 1.1 Tabs — explicit semantics

| Tab | Shows | Backed by |
|---|---|---|
| **Map** | All currently-loaded datasets, layered with toggleable visibility. The "live data canvas." | `_execDatasets`, `<gcb-map>` |
| **Results** | Gallery of every saved result this session. Each card is interactive (open / share / remove). | `SavesStore` (localStorage) |
| **Detail** | The currently-selected saved result, drilled in: chart/map + facts + the SQL or args that produced it. Empty state when nothing selected. | `SavesStore.getById()` |

Clicking a Saved-rail item *navigates* to the Detail tab and
selects it (same behavior on Map and Results tab).

### 1.2 Upload — popover, not page-blocking

The drop zone disappears entirely. The top-right `Add data` button
opens an anchored popover (12 px below, right-aligned, arrow on the
top-right corner) containing:

1. A 220×120 dashed-border drop area (still accepts drops + click
   to open a file picker, same handlers as before).
2. An **or paste** affordance that handles `⌘V` / `ctrl+V` for a URL
   or a clipboard table.
3. Format hint line in mono (`CSV · GeoJSON · Shapefile.zip · Excel · Parquet`).

When the popover is open, an `Escape` key dismisses it; clicking
outside also dismisses. Dropping a file anywhere on the dashboard
window (not just inside the popover) still works — a full-window
overlay appears mid-drag.

### 1.3 Approve-and-Run — modal, not inline

Today, `<plan-review>` is appended inline beneath the chat. New
behavior: when a `plan` event fires, render `<plan-review>` inside a
centered scrim modal (`.gcb-scrim` + `.gcb-modal`) with:

- Goal line as the modal title (italic Newsreader display).
- Numbered step list (mono pill for tool name, code-styled args).
- `Reject & rephrase` (secondary) and `Approve · Run all N steps ↵`
  (primary, accent-colored, default focus, `Enter` triggers).
- `Esc` rejects / closes (same as clicking the scrim).

While running, the modal stays open and step rows light up
(`pending → running → success / fail`). On final success it
auto-dismisses 600 ms after the last step completes (long enough to
register the green checkmarks). On any failure it stays open with a
red banner.

This means **plan-review does not need to be ripped out**; it just
gets re-mounted inside a new `<gcb-modal>` host. Existing event
plumbing is untouched.

---

## 2. Design System

### 2.1 Tokens

All tokens are CSS custom properties on `:host` so the embedded
widget inherits cleanly and a host can override one or two without
forking the whole theme. Light is the default; dark is selected via
`:host([theme="dark"])` or `prefers-color-scheme: dark` when no
explicit theme is set.

| Token | Light | Dark |
|---|---|---|
| `--gcb-bg` | `#fbfaf7` | `#0c0e12` |
| `--gcb-bg-2` | `#ffffff` | `#14171c` |
| `--gcb-bg-3` | `#f3f1ec` | `#1b1f25` |
| `--gcb-line` | `#e5e1d8` | `#25292f` |
| `--gcb-ink` | `#1a1a1a` | `#e7e9ee` |
| `--gcb-ink-soft` | `#4a4a4a` | `#b6bbc4` |
| `--gcb-ink-muted` | `#757575` | `#767c87` |
| `--gcb-accent` | `#0e7a5f` | `#c4f042` |
| `--gcb-accent-fg` | `#ffffff` | `#0c0e12` |
| `--gcb-accent-soft` | `#d8eee5` | `rgba(196,240,66,.10)` |

Both accents are in the green family on purpose — same brand,
different time of day. WCAG AA contrast verified for body + small
text in both modes.

### 2.2 Typography

| Role | Family | Weight | Notes |
|---|---|---|---|
| Sans body / UI | **Geist** | 400 / 500 / 600 | `font-feature-settings: "ss01","ss02","cv11"` |
| Display (brand, section heads, modal title, stat numbers) | **Newsreader** | 400 / 500, italic | Optical-size 6..72 |
| Mono (data, captions, code, keyboard shortcuts) | **JetBrains Mono** | 400 / 500 | Use tabular-nums for tables |

All three are loaded from Google Fonts via `<link rel="preconnect">`
+ a single `<link>` on the dashboard route, and bundled
self-host-friendly fallbacks in the embedded widget so no
third-party request is needed at embed time.

### 2.3 Shape language

| Element | Radius | Border | Shadow |
|---|---|---|---|
| Buttons / chips | 6 px | 1 px hairline | none (light), none (dark) |
| Inputs | 10 px | 1 px hairline | none |
| Cards / popover | 14 px | 1 px hairline | `--shadow-1` (light only) |
| Modal | 14 px | 1 px hairline | `--shadow-2` |
| Brand mark | 7 px | none | none |

### 2.4 Density & spacing

- Base unit = 4 px.
- Buttons / chips: 28–32 px tall (B's compact rhythm).
- Body copy: 13 px / 1.5 line-height.
- Mono captions: 10–12 px.
- Section gutters in main canvas: 14–22 px (C's calmer rhythm).
- Topbar: 56 px.
- Bottom dock: 84 px.
- Left rail: 280 px.

### 2.5 Motion

- All transitions ≤200 ms, easing `cubic-bezier(.2,.9,.2,1.05)` for
  arrivals, ease-out for departures.
- Modal enter: `translateY(14px) scale(.98) → 0,1` over 240 ms.
- Theme change: 200 ms cross-fade on `--gcb-bg` and `--gcb-ink`.
- Respect `prefers-reduced-motion`: kill all enter animations,
  keep instant state changes only.

---

## 3. Component Architecture

We add 5 new components and refactor 2 existing ones. Everything
stays inside `packages/widget/src/ui/` and is registered as a Lit
custom element so the dashboard can compose them like any other DOM.

### 3.1 New components

| Tag | File | Responsibility |
|---|---|---|
| `<gcb-shell>` | `ui/shell.ts` | Top-level layout grid (topbar / rail / main / dock). Owns tab state. Slots for `<gcb-rail>`, content, `<gcb-ask-input>`. |
| `<gcb-rail>` | `ui/rail.ts` | Left rail. Renders `Datasets` from `_execDatasets` and `Saved` from `SavesStore`. Emits `gcb:save-select`, `gcb:dataset-toggle`. |
| `<gcb-upload-popover>` | `ui/upload-popover.ts` | Anchored popover. Wraps the existing drop / picker logic. Emits `gcb:files`. |
| `<gcb-modal>` | `ui/modal.ts` | Generic centered modal w/ scrim, focus trap, `Esc` close. `<plan-review>` mounts as a child. |
| `<gcb-results-grid>` | `ui/results-grid.ts` | Gallery view for the Results tab. Cards show kind-specific previews (bar SVG, line SVG, mini-map, table head). |

### 3.2 Refactored components

- **`<geo-chatbot>` (`element.ts`)** — `render()` switches on `mode`:
  - `'headless'` → render nothing (unchanged).
  - `'full'` → render `<gcb-shell>` instead of the current vertical
    stack. The drop zone, error banner, and tables block are removed
    from this render path; they are replaced by `<gcb-shell>` +
    children.
  - `'dashboard'` (new) → same as `'full'`, but the shell expands
    edge-to-edge, the topbar shows "Cedar Key Workspace" or
    user-supplied workspace label, and a footer with API-key chip
    appears.
- **`<plan-review>`** — no behavioral change; `_renderPlanIfFull()`
  in `element.ts` mounts it as a child of `<gcb-modal>` instead of
  appending it directly to `shadowRoot`.

### 3.3 New helpers (non-DOM)

| Module | Responsibility |
|---|---|
| `state/saves-store.ts` | LocalStorage-backed CRUD for saved results. Observable via `EventTarget`. Schema versioned (`v1`). |
| `state/theme.ts` | Resolves `auto / light / dark` against `prefers-color-scheme`, sets `data-theme` attr on the host, persists choice. |

---

## 4. Data Model

### 4.1 SavedResult (versioned)

```ts
type SavedResultV1 = {
  /** stable opaque id */
  id: string;
  /** schema version, bumped on shape change */
  version: 1;
  /** when the user pinned it */
  createdAt: number;
  /** session-friendly display name; user-editable in card */
  title: string;
  /** what produced it */
  origin: {
    planId: string;
    stepId: string;
    question: string;
  };
  /** what kind of payload — drives card preview + Detail tab */
  kind: 'chart' | 'table' | 'map' | 'summary';
  /** opaque payload; same shape ResultEvent already emits */
  payload: Record<string, unknown>;
};
```

Stored under localStorage key `geochatbot:saves:v1` as a JSON array.
On read, any entry with `version !== 1` is dropped (forwards-compat
shim). On every mutation we re-serialize the whole array — saves
are bounded (≤ a few hundred per session in practice) so this is
fine.

### 4.2 SavesStore API

```ts
class SavesStore extends EventTarget {
  list(): SavedResultV1[];
  get(id: string): SavedResultV1 | undefined;
  add(input: Omit<SavedResultV1, 'id' | 'version' | 'createdAt'>): SavedResultV1;
  rename(id: string, title: string): void;
  remove(id: string): void;
  clear(): void;
  // Emits: 'change' on add/rename/remove/clear.
}
```

Single instance per widget host, exposed as `geoChatBot.saves`.

### 4.3 Tab state

Tab state is **not persisted**. It lives on `<gcb-shell>` as a
reactive property. Default tab on first render = `Map`. Selecting
a saved item from the rail switches to `Detail` automatically;
explicit clicks on tab labels bypass that.

---

## 5. Event Wiring

| Event | Emitter | Listener | Effect |
|---|---|---|---|
| `gcb:files` | `<gcb-upload-popover>` | `<geo-chatbot>` | Calls `pushData(file)` for each. Closes popover on success. |
| `gcb:save` | result-card "Save" button | `<geo-chatbot>` | `saves.add(...)`, then `<gcb-rail>` re-renders via the store's `change` event. |
| `gcb:save-select` | `<gcb-rail>` item click | `<gcb-shell>` | Sets `activeSaveId`, switches `tab='detail'`. |
| `gcb:dataset-toggle` | `<gcb-rail>` eye icon | `<geo-chatbot>` | Flips a per-dataset visibility flag; `<gcb-map>` re-renders. |
| `gcb:tab` | `<gcb-shell>` tab click | nothing external | Updates internal state. |
| `gcb:approve` / `gcb:reject` | `<plan-review>` (existing) | `<gcb-modal>` | Closes the modal in addition to the existing approve/reject behavior. |

All events bubble + compose so a host page can listen on the widget
host element directly if needed.

---

## 6. Two Entry Points, One Codebase

### 6.1 Embedded widget (existing path)

Today's host pages do `<geo-chatbot dangerously-allow-browser>` and
call `setProvider(...)`. After Phase 7, the same tag gets the new
shell automatically (`mode='full'` is the default). No host code
changes are required. CSS variables continue to be the override
surface.

### 6.2 Standalone `/dashboard` route

A new top-level Vite entry under `examples/dashboard/`:

```
examples/dashboard/
  index.html           — full-page shell, loads /src/dashboard.ts
  src/dashboard.ts     — instantiates <geo-chatbot mode='dashboard'>,
                         wires settings drawer, theme, ?embed= params
```

Key differences from the embedded widget:

- `<html data-theme>` is owned by the page, not the host.
- Sets `--gcb-max-width: 100%` and `padding: 0` on the host.
- Adds a small footer with project links + version.

A query param `?embed=true` forces `mode='full'` and removes the
footer / workspace crumb so the dashboard URL can be embedded in an
`<iframe>` for hosts that want the full UI without integrating the
custom element directly.

---

## 7. Accessibility

| Requirement | How met |
|---|---|
| Keyboard-only navigation | All interactive elements are real `<button>` / `<a>`; tab-order matches visual order; modal traps focus and restores it on close. |
| Visible focus rings | 2 px outline using `--gcb-accent`, never removed. |
| Color contrast | Every text/background pair tested AA (4.5:1) in both themes. |
| Screen-reader labels | Icon-only buttons get `aria-label`; the rail uses `role="navigation"`; saved-list items use `role="listitem"`. |
| Reduced motion | All entering / scaling animations gated on `(prefers-reduced-motion: no-preference)`. |
| Esc / dismiss | Modal + popover both support `Esc` and outside-click. |
| Live announcements | Plan progress emits to a `role="status"` region so `running → success` is announced. |

---

## 8. Testing Strategy

### 8.1 Unit (vitest)

- `SavesStore` — add/remove/rename round-trips localStorage, emits
  `change`, drops `version !== 1` entries.
- `theme.ts` — auto resolves correctly against
  `matchMedia('(prefers-color-scheme: dark)')`; persisted choice
  overrides auto.

### 8.2 Component (@open-wc/testing)

- `<gcb-upload-popover>` — open / close, `Esc`, file drop, paste.
- `<gcb-modal>` — focus trap, `Esc` closes, scrim click closes,
  focus restoration.
- `<gcb-rail>` — datasets render, saved render, click emits
  `gcb:save-select`.
- `<gcb-results-grid>` — renders one card per save, kind-correct
  preview component selected.

### 8.3 Integration (`element.test.ts` extensions)

- New shell renders in `mode='full'`; old drop zone is gone.
- Plan-review shows up inside `<gcb-modal>` after a `plan` event;
  approving it dismisses the modal.
- Save flow: agent emits a `result` event → user clicks Save on
  the result card → entry appears in `<gcb-rail>` and survives a
  `connectedCallback` round-trip.

### 8.4 E2E (Playwright)

- Drop a CSV via the popover → ports appear on Map tab.
- Ask a question → modal appears → Approve → result lands on Map
  tab → click Save on the card → switch to Detail tab via rail
  click → drill-down renders.
- Toggle theme via topbar → all surfaces reflect new tokens within
  ≤300 ms; check both `light` and `dark` snapshots.

---

## 9. Effort Estimate & Sequencing

The user picked **"Replace the widget chrome (drop zone → upload pop,
inline plan → modal, add left rail)"** as the first ship-able slice.
That governs the order below.

### Slice 1 — Chrome replacement (~3.5 days, ships visibly)

| # | Item | Effort |
|---|---|---|
| 9.1 | Design tokens + type stack + `theme.ts` (auto / light / dark) | 0.5 day |
| 9.2 | `<gcb-modal>` + `<plan-review>` re-mount inside it | 0.5 day |
| 9.3 | `<gcb-upload-popover>` + remove giant drop zone from `element.ts` | 0.5 day |
| 9.4 | `<gcb-shell>` (topbar / rail / main / dock layout grid + tab state) | 1 day |
| 9.5 | `<gcb-rail>` + `SavesStore` + "Save" affordance on result cards | 1 day |

Slice 1 ends with: a user can drop data via the new popover, ask a
question, see the new approve modal, see results render, and pin
them to the rail (which survives reload via localStorage). The
visual debt the user complained about is gone after this slice.

### Slice 2 — Results + Detail tabs (~1.5 days)

| # | Item | Effort |
|---|---|---|
| 9.6 | `<gcb-results-grid>` (Results tab gallery cards) | 0.75 day |
| 9.7 | Detail-tab drill-down view (chart/map + facts + SQL block) | 0.75 day |

Slice 2 ends with the full 3-tab dashboard.

### Slice 3 — Standalone route + tests (~1 day)

| # | Item | Effort |
|---|---|---|
| 9.8 | `examples/dashboard/` standalone Vite entry + `?embed=` mode | 0.5 day |
| 9.9 | Tests (component, integration, E2E) + a11y audit + Playwright traces | 0.5 day |

**Total: ~6 days** (one engineer, 6-hour day, full focus).

---

## 10. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Replacing the inline plan-review with a modal breaks tests that query for `plan-review` directly inside `shadowRoot`. | Update those tests to query through `<gcb-modal>`. The element is still in the DOM, just nested. Selectors like `el.shadowRoot.querySelector('plan-review')` keep working because `<gcb-modal>` uses light-DOM children, not nested shadow roots. |
| LocalStorage quota exceeded for saves. | Cap save count at 200 per origin; FIFO-evict on overflow with a toast. |
| Embedded widget hosts override CSS variables and get broken contrast. | Document the canonical token list in the README; ship a `:host` reset for any token they fail to set, falling back to the light defaults. |
| Adding three new components increases bundle size past the 100 KB gzipped budget. | Lazy-load `<gcb-results-grid>` and `<gcb-modal>` (modal only mounts on first plan event; grid only mounts when Results tab is opened). Track gzipped size in CI. |
| User on first load with no key sees an empty shell + dock with disabled Run button — confusing. | The empty `Map` tab shows a visual onboarding card: "Add data" arrow pointing at the top-right button + a sample-dataset link. The dock retains its `disabledReason` chip ("API key needed" / "Add data first"). |

---

## 11. Open questions

None. All four decisions in the 2026-05-08 review (variant blend,
auto theme, localStorage saves, both entry points) are locked.

---

*Spec ends here. Implementation plan to follow under
`docs/superpowers/plans/2026-05-08-phase-7-dashboard-redesign.md`.*
