import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { tokensCSS } from './tokens.js';

export type ShellTab = 'map' | 'results' | 'detail';

const TABS: ReadonlyArray<{ id: ShellTab; label: string }> = [
  { id: 'map',     label: 'Map' },
  { id: 'results', label: 'Results' },
  { id: 'detail',  label: 'Detail' },
];

/**
 * <gcb-shell> — top-level dashboard layout.
 *
 * Provides four named slots — `topbar`, `rail`, `main`, `dock` — and
 * an internal tab strip whose selection is exposed via the
 * `activeTab` property and emitted as `gcb:tab`.
 *
 * Spec: docs/superpowers/specs/2026-05-08-phase-7-dashboard-redesign-design.md §1, §3.1
 */
@customElement('gcb-shell')
export class GcbShell extends LitElement {
  static override styles = [
    tokensCSS,
    css`
      :host {
        display: grid;
        grid-template-columns: 280px 1fr;
        grid-template-rows: 56px 42px 1fr 84px;
        grid-template-areas:
          "topbar topbar"
          "rail   tabs"
          "rail   main"
          "rail   dock";
        height: 100%; min-height: 480px;
        background: var(--gcb-bg); color: var(--gcb-ink);
        font-family: var(--gcb-font-sans);
        border-radius: var(--gcb-radius-lg);
        overflow: hidden;
      }
      .topbar {
        grid-area: topbar;
        background: var(--gcb-bg-2);
        border-bottom: 1px solid var(--gcb-line);
      }
      .rail {
        grid-area: rail;
        border-right: 1px solid var(--gcb-line);
      }
      .tabs {
        grid-area: tabs;
        background: var(--gcb-bg-2);
        border-bottom: 1px solid var(--gcb-line);
        display: flex; align-items: center; gap: 4px;
        padding: 0 14px;
      }
      .tab {
        height: 30px; padding: 0 12px;
        display: inline-flex; align-items: center; gap: 8px;
        border-radius: 8px; font-size: 12px; font-weight: 500;
        color: var(--gcb-ink-soft); background: transparent;
        border: 1px solid transparent;
        font: inherit; cursor: pointer;
      }
      .tab:hover { background: var(--gcb-bg-3); color: var(--gcb-ink); }
      .tab[aria-selected="true"] {
        color: var(--gcb-ink); background: var(--gcb-bg);
        border-color: var(--gcb-line); box-shadow: var(--gcb-shadow-1);
      }
      .badge {
        font-family: var(--gcb-font-mono); font-size: 10px;
        padding: 1px 6px; border-radius: 999px;
        background: var(--gcb-accent-soft); color: var(--gcb-accent);
        font-weight: 500;
      }
      .main { grid-area: main; min-width: 0; min-height: 0; overflow: hidden; }
      .dock {
        grid-area: dock;
        background: var(--gcb-bg-2);
        border-top: 1px solid var(--gcb-line);
      }
    `,
  ];

  @property() activeTab: ShellTab = 'map';
  @property({ type: Number }) datasetCount = 0;
  @property({ type: Number }) savedCount = 0;

  private _select(id: ShellTab): void {
    this.activeTab = id;
    this.dispatchEvent(
      new CustomEvent<ShellTab>('gcb:tab', {
        detail: id, bubbles: true, composed: true,
      }),
    );
  }

  override render() {
    return html`
      <div class="topbar"><slot name="topbar"></slot></div>
      <div class="rail"><slot name="rail"></slot></div>
      <div class="tabs" role="tablist" aria-label="Dashboard sections">
        ${TABS.map((t) => html`
          <button
            role="tab"
            class="tab"
            aria-selected=${t.id === this.activeTab ? 'true' : 'false'}
            @click=${() => this._select(t.id)}
          >
            ${t.label}
            ${t.id === 'map' && this.datasetCount > 0
              ? html`<span class="badge">${this.datasetCount}</span>` : ''}
            ${t.id === 'results' && this.savedCount > 0
              ? html`<span class="badge">${this.savedCount}</span>` : ''}
          </button>
        `)}
      </div>
      <div class="main"><slot name="main"></slot></div>
      <div class="dock"><slot name="dock"></slot></div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gcb-shell': GcbShell;
  }
}
