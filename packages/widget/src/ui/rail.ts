import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { tokensCSS } from './tokens.js';
import type { SavedResultV1 } from '../state/saves-store.js';

export interface RailDataset {
  name: string;
  rows: number;
  hasGeometry: boolean;
}

/**
 * <gcb-rail> — left navigation rail.
 *
 * Spec: docs/superpowers/specs/2026-05-08-phase-7-dashboard-redesign-design.md §1, §3.1
 */
@customElement('gcb-rail')
export class GcbRail extends LitElement {
  static override styles = [
    tokensCSS,
    css`
      :host {
        display: block; height: 100%;
        background: var(--gcb-bg);
        font-family: var(--gcb-font-sans);
        color: var(--gcb-ink);
        padding: 14px;
        overflow: auto;
      }
      h4 {
        font-family: var(--gcb-font-display); font-style: italic;
        font-size: 13px; color: var(--gcb-ink); margin: 0 0 10px;
        font-weight: 500;
        display: flex; align-items: center; justify-content: space-between;
      }
      h4 .count {
        font-family: var(--gcb-font-mono); font-style: normal;
        padding: 1px 6px; border-radius: 999px;
        background: var(--gcb-bg-3); color: var(--gcb-ink-muted);
        font-size: 10px; font-weight: 400;
      }
      .empty {
        font-size: 12px; color: var(--gcb-ink-muted);
        padding: 6px 4px;
      }
      .dataset-row, .save-row {
        display: grid; align-items: center; gap: 10px;
        padding: 7px 10px; border-radius: 8px; cursor: pointer;
        font-size: 13px; color: var(--gcb-ink);
        border: 1px solid transparent;
      }
      .dataset-row {
        grid-template-columns: 12px 1fr auto auto;
      }
      .dataset-row:hover { background: var(--gcb-bg-3); }
      .swatch {
        width: 10px; height: 10px; border-radius: 999px;
        background: var(--gcb-accent);
      }
      .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .rows { font-family: var(--gcb-font-mono); font-size: 10px; color: var(--gcb-ink-muted); }
      .eye, .remove {
        width: 22px; height: 22px;
        display: inline-grid; place-items: center;
        border: 0; background: transparent; color: var(--gcb-ink-muted);
        cursor: pointer; border-radius: 4px;
      }
      .eye:hover, .remove:hover { background: var(--gcb-bg-3); color: var(--gcb-ink); }

      .save-row {
        grid-template-columns: 1fr auto;
        margin-bottom: 4px;
      }
      .save-row:hover { background: var(--gcb-bg-3); }
      .save-row[aria-current="true"] {
        background: var(--gcb-accent-soft);
        border-color: color-mix(in srgb, var(--gcb-accent) 30%, transparent);
      }
      .save-meta { min-width: 0; }
      .save-title {
        font-size: 13px; font-weight: 500; line-height: 1.3;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .save-sub {
        font-family: var(--gcb-font-mono); font-size: 10px;
        color: var(--gcb-ink-muted); margin-top: 3px;
      }
      .section + .section { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--gcb-line-soft); }
    `,
  ];

  @property({ attribute: false }) datasets: ReadonlyArray<RailDataset> = [];
  @property({ attribute: false }) saves: ReadonlyArray<SavedResultV1> = [];
  @property() activeSaveId: string | null = null;

  private _emit<T>(name: string, detail: T): void {
    this.dispatchEvent(
      new CustomEvent<T>(name, { detail, bubbles: true, composed: true }),
    );
  }

  override render() {
    return html`
      <div class="section" role="navigation" aria-label="Datasets">
        <h4>Datasets <span class="count">${this.datasets.length}</span></h4>
        ${this.datasets.length === 0
          ? html`<div class="empty">No datasets yet.</div>`
          : html`<div role="list">
              ${this.datasets.map((d) => html`
                <div class="dataset-row" role="listitem">
                  <span class="swatch"></span>
                  <span class="name" title=${d.name}>${d.name}</span>
                  <span class="rows">${d.rows.toLocaleString()} r</span>
                  <button
                    class="eye"
                    type="button"
                    aria-label="Toggle visibility for ${d.name}"
                    @click=${(e: Event) => { e.stopPropagation(); this._emit('gcb:dataset-toggle', d.name); }}
                  >👁</button>
                </div>
              `)}
            </div>`}
      </div>

      <div class="section" role="navigation" aria-label="Saved results">
        <h4>Saved <span class="count">${this.saves.length}</span></h4>
        ${this.saves.length === 0
          ? html`<div class="empty">No saved results yet.</div>`
          : html`<div role="list">
              ${this.saves.map((s) => html`
                <div
                  class="save-row"
                  role="listitem"
                  aria-current=${s.id === this.activeSaveId ? 'true' : 'false'}
                  @click=${() => this._emit('gcb:save-select', s.id)}
                >
                  <div class="save-meta">
                    <div class="save-title">${s.title}</div>
                    <div class="save-sub">${s.kind} · ${new Date(s.createdAt).toLocaleTimeString()}</div>
                  </div>
                  <button
                    class="remove"
                    type="button"
                    aria-label="Remove ${s.title}"
                    @click=${(e: Event) => { e.stopPropagation(); this._emit('gcb:save-remove', s.id); }}
                  >✕</button>
                </div>
              `)}
            </div>`}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gcb-rail': GcbRail;
  }
}
