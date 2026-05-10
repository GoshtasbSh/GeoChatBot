import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { tokensCSS } from "./tokens.js";

/**
 * Shell tab — kept for backwards compat with existing call sites that
 * still set `activeTab`. The new combined design has no tab strip; the
 * tab is now an internal hint used by the host to decide what to render
 * in the main slot. Default 'map' continues to work.
 */
export type ShellTab = "map" | "results" | "detail";

const RAIL_W = 48;
const PANEL_W = 240;
const TOPBAR_H = 48;
const DOCK_H_MIN = 76;

/**
 * <gcb-shell> — three-pane dashboard layout.
 *
 * Layout:
 *   ┌── topbar (full-width) ─────────────────────────────────────┐
 *   │ [rail-spacer] [logo] [status] ... [theme] [settings]       │
 *   ├── icon rail ┬── contents panel ┬── main ────────────────────┤
 *   │ (48px)      │ (240px)          │ chat history (scrollable)  │
 *   │             │                  │                            │
 *   │             │                  ├── dock (input + chips)     │
 *   └─────────────┴──────────────────┴───────────────────────────┘
 *
 * Slots: `topbar`, `iconRail`, `rail` (= contents panel), `main`, `dock`.
 *
 * Spec: docs/superpowers/specs/2026-05-08-phase-7-dashboard-redesign-design.md §1
 */
@customElement("gcb-shell")
export class GcbShell extends LitElement {
	static override styles = [
		tokensCSS,
		css`
      :host {
        display: grid;
        grid-template-columns: ${RAIL_W}px ${PANEL_W}px 1fr;
        grid-template-rows: ${TOPBAR_H}px 1fr ${DOCK_H_MIN}px;
        grid-template-areas:
          "topbar topbar topbar"
          "rail   panel  main"
          "rail   panel  dock";
        height: 100%; min-height: 480px;
        background: var(--gcb-bg);
        color: var(--gcb-ink);
        font-family: var(--gcb-font-sans);
        border-radius: var(--gcb-radius-lg);
        overflow: hidden;
      }

      .topbar {
        grid-area: topbar;
        background: var(--gcb-bg-2);
        border-bottom: 1px solid var(--gcb-line);
        z-index: 5;
      }

      .icon-rail {
        grid-area: rail;
        background: var(--gcb-bg-rail);
        border-right: 1px solid var(--gcb-line);
        display: flex; flex-direction: column;
        min-height: 0;
      }

      .panel {
        grid-area: panel;
        background: var(--gcb-bg-2);
        border-right: 1px solid var(--gcb-line);
        display: flex; flex-direction: column;
        min-height: 0; min-width: 0;
        overflow: hidden;
      }

      .main {
        grid-area: main;
        min-width: 0; min-height: 0;
        background: var(--gcb-bg);
        overflow: hidden;
      }

      .dock {
        grid-area: dock;
        background: var(--gcb-bg-2);
        border-top: 1px solid var(--gcb-line);
        height: auto;
        min-height: ${DOCK_H_MIN}px;
      }

      /* When dock height needs to grow (multiline input), the
         grid auto-tracks expand. Treat the dock row as 'auto' via min-content.
         Browsers honour min-height on grid areas but capping with the
         template still works for the 76px floor. */

      ::slotted(*) { box-sizing: border-box; }
    `,
	];

	/**
	 * Backwards-compatible tab hint. The shell no longer renders a tab
	 * strip — the host decides what to put in the main slot. Setting
	 * activeTab still updates the property + emits gcb:tab so existing
	 * tests and external integrations keep working.
	 */
	@property() activeTab: ShellTab = "map";
	@property({ type: Number }) datasetCount = 0;
	@property({ type: Number }) savedCount = 0;

	/** Internal helper retained for backwards compatibility with prior tab API. */
	setTab(id: ShellTab): void {
		this.activeTab = id;
		this.dispatchEvent(
			new CustomEvent<ShellTab>("gcb:tab", {
				detail: id,
				bubbles: true,
				composed: true,
			}),
		);
	}

	override render() {
		return html`
      <div class="topbar"><slot name="topbar"></slot></div>
      <div class="icon-rail"><slot name="iconRail"></slot></div>
      <div class="panel"><slot name="rail"></slot></div>
      <div class="main"><slot name="main"></slot></div>
      <div class="dock"><slot name="dock"></slot></div>
    `;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"gcb-shell": GcbShell;
	}
}
