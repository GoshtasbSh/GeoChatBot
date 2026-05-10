import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { tokensCSS } from './tokens.js';
import type { SavedResultV1 } from '../state/saves-store.js';

export interface RailDataset {
  name: string;
  rows: number;
  hasGeometry: boolean;
}

/**
 * A "derived layer" entry in the Contents panel — produced by a
 * render.map step. Auto-added to the Layers section by the host
 * element.ts when an executor result with kind: 'layer' arrives.
 */
export interface RailLayer {
  /** Identifier — usually the layer name from the result payload. */
  id: string;
  /** Display name shown in the Layers list. */
  name: string;
  /** Feature count to display alongside the name. */
  features: number;
  /** Whether the user has it visible (eye icon state). */
  visible: boolean;
  /** Whether the layer is brand-new (shows "NEW" badge). */
  isNew: boolean;
}

/**
 * <gcb-rail> — Contents panel.
 *
 * Three sections (top → bottom): Layers, Saved, Datasets.
 * Pinned to the bottom: a prominent "Add data" CTA.
 *
 * Backwards-compatible event surface:
 *   - gcb:dataset-toggle   (legacy, for visibility toggles)
 *   - gcb:save-select      (existing)
 *   - gcb:save-remove      (existing)
 * New events:
 *   - gcb:layer-toggle     ({ id })
 *   - gcb:layer-remove     ({ id })
 *   - gcb:add-data         (no detail) — clicked the footer button
 *
 * Spec: docs/superpowers/specs/2026-05-08-phase-7-dashboard-redesign-design.md §3.1
 */
@customElement('gcb-rail')
export class GcbRail extends LitElement {
  static override styles = [
    tokensCSS,
    css`
      :host {
        display: flex; flex-direction: column;
        height: 100%; min-height: 0;
        background: var(--gcb-bg-2);
        font-family: var(--gcb-font-sans);
        color: var(--gcb-ink);
        overflow: hidden;
      }

      .panel-hdr {
        padding: 10px 12px;
        font-size: 10px; font-weight: 700;
        letter-spacing: .10em; text-transform: uppercase;
        color: var(--gcb-ink-muted);
        border-bottom: 1px solid var(--gcb-line);
        display: flex; align-items: center; gap: 6px;
        flex-shrink: 0;
      }
      .panel-hdr svg { color: var(--gcb-ink-muted); }

      .panel-scroll {
        flex: 1; overflow-y: auto;
        padding: 4px 0;
        min-height: 0;
      }

      .section + .section { margin-top: 4px; }

      .section-lbl {
        padding: 6px 12px 2px;
        font-size: 10px; font-weight: 600;
        letter-spacing: .07em; text-transform: uppercase;
        color: var(--gcb-ink-muted); opacity: .85;
      }

      .empty {
        font-size: 11px; color: var(--gcb-ink-muted);
        padding: 4px 12px 6px;
      }

      /* Layer / dataset rows */
      .row {
        display: flex; align-items: center; gap: 7px;
        padding: 6px 10px; margin: 1px 5px;
        border-radius: var(--gcb-radius-sm);
        cursor: pointer; position: relative;
        font-size: 12px; color: var(--gcb-ink-soft);
      }
      .row:hover { background: var(--gcb-bg-3); }
      .row.is-new { background: var(--gcb-accent-soft); }
      .row.is-new:hover { filter: brightness(1.04); }

      .icon { width: 14px; height: 14px; flex-shrink: 0; }
      .dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
      .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .count {
        font-size: 10px; color: var(--gcb-ink-muted);
        font-family: var(--gcb-font-mono); flex-shrink: 0;
      }
      .eye {
        width: 22px; height: 22px; border-radius: 4px; border: 0;
        background: transparent; color: var(--gcb-ink-muted);
        display: inline-grid; place-items: center;
        cursor: pointer; flex-shrink: 0;
      }
      .eye:hover { color: var(--gcb-ink); background: var(--gcb-bg-4); }
      .eye[aria-pressed="false"] { opacity: 0.45; }

      .new-badge {
        font-size: 9px; font-weight: 700; letter-spacing: .04em;
        color: var(--gcb-accent-ink);
        background: var(--gcb-accent-soft);
        border: 1px solid var(--gcb-accent-ring);
        padding: 1px 5px; border-radius: 3px; flex-shrink: 0;
      }

      /* Saved rows */
      .saved-row {
        display: flex; align-items: center; gap: 8px;
        padding: 5px 10px; margin: 1px 5px;
        border-radius: var(--gcb-radius-sm); cursor: pointer;
      }
      .saved-row:hover { background: var(--gcb-bg-3); }
      .saved-row[aria-current="true"] {
        background: var(--gcb-accent-soft);
        border: 1px solid var(--gcb-accent-ring);
      }
      .saved-icon {
        width: 26px; height: 26px; border-radius: var(--gcb-radius-sm);
        background: var(--gcb-bg-3); border: 1px solid var(--gcb-line);
        display: grid; place-items: center;
        color: var(--gcb-ink-muted); flex-shrink: 0;
      }
      .saved-meta { min-width: 0; flex: 1; }
      .saved-title {
        font-size: 12px; font-weight: 500; color: var(--gcb-ink-soft);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .saved-sub {
        font-family: var(--gcb-font-mono); font-size: 10px;
        color: var(--gcb-ink-muted); margin-top: 1px;
      }
      .remove {
        width: 20px; height: 20px; border-radius: 4px; border: 0;
        background: transparent; color: var(--gcb-ink-muted);
        display: grid; place-items: center;
        cursor: pointer; flex-shrink: 0;
      }
      .remove:hover { color: var(--gcb-ink); background: var(--gcb-bg-4); }

      .divider {
        height: 1px; background: var(--gcb-line); margin: 6px 0;
      }

      /* Add-data footer (G's prominent button) */
      .panel-foot {
        border-top: 1px solid var(--gcb-line);
        padding: 10px 8px; flex-shrink: 0;
      }
      .add-btn {
        width: 100%;
        display: flex; align-items: center; justify-content: center; gap: 6px;
        padding: 9px 0; border-radius: var(--gcb-radius);
        border: 1.5px dashed var(--gcb-accent-ring);
        background: var(--gcb-accent-soft);
        color: var(--gcb-accent);
        font: inherit; font-size: 12px; font-weight: 600;
        cursor: pointer;
        transition: filter 150ms ease, border-style 150ms ease;
      }
      .add-btn:hover { border-style: solid; filter: brightness(1.08); }
      .add-btn:focus-visible {
        outline: 2px solid var(--gcb-accent);
        outline-offset: 2px;
      }
    `,
  ];

  /** Raw datasets (uploaded files) — shown in the Datasets section. */
  @property({ attribute: false }) datasets: ReadonlyArray<RailDataset> = [];
  /** Saved results — pinned by the user. */
  @property({ attribute: false }) saves: ReadonlyArray<SavedResultV1> = [];
  /** Derived layers from render.map results. */
  @property({ attribute: false }) layers: ReadonlyArray<RailLayer> = [];
  /** Currently-active save id (for highlighting). */
  @property() activeSaveId: string | null = null;

  private _emit<T>(name: string, detail: T): void {
    this.dispatchEvent(
      new CustomEvent<T>(name, { detail, bubbles: true, composed: true }),
    );
  }

  private _emitVoid(name: string): void {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }));
  }

  override render() {
    return html`
      <div class="panel-hdr">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <polygon points="12 2 2 7 12 12 22 7 12 2"/>
          <polyline points="2 17 12 22 22 17"/>
          <polyline points="2 12 12 17 22 12"/>
        </svg>
        Contents
      </div>

      <div class="panel-scroll">

        <!-- Layers (derived from render.map results) -->
        <div class="section" role="list" aria-label="Layers">
          <div class="section-lbl">Layers</div>
          ${this.layers.length === 0
            ? html`<div class="empty">Layers from analysis appear here.</div>`
            : this.layers.map((l) => html`
                <div class="row ${l.isNew ? 'is-new' : ''}" role="listitem">
                  <svg class="icon" viewBox="0 0 14 14" fill="none">
                    <circle cx="7" cy="7" r="4.5" stroke="${l.isNew ? '#60a5fa' : '#22c55e'}" stroke-width="1.2"/>
                    <circle cx="7" cy="7" r="2" fill="${l.isNew ? '#60a5fa' : '#22c55e'}"/>
                  </svg>
                  <span class="dot" style="background:${l.isNew ? '#60a5fa' : '#22c55e'}"></span>
                  <span class="name" title=${l.name}>${l.name}</span>
                  ${l.isNew
                    ? html`<span class="new-badge">NEW</span>`
                    : html`<span class="count">${l.features} ft</span>`}
                  <button
                    class="eye"
                    type="button"
                    aria-pressed=${l.visible ? 'true' : 'false'}
                    aria-label="Toggle visibility for ${l.name}"
                    @click=${(e: Event) => { e.stopPropagation(); this._emit('gcb:layer-toggle', { id: l.id }); }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                    </svg>
                  </button>
                </div>
              `)}
        </div>

        <div class="divider"></div>

        <!-- Saved -->
        <div class="section" role="list" aria-label="Saved results">
          <div class="section-lbl">Saved</div>
          ${this.saves.length === 0
            ? html`<div class="empty">No saved results yet.</div>`
            : this.saves.map((s) => html`
                <div
                  class="saved-row"
                  role="listitem"
                  aria-current=${s.id === this.activeSaveId ? 'true' : 'false'}
                  @click=${() => this._emit('gcb:save-select', s.id)}
                >
                  <div class="saved-icon">
                    ${this._savedIcon(s.kind)}
                  </div>
                  <div class="saved-meta">
                    <div class="saved-title">${s.title}</div>
                    <div class="saved-sub">${s.kind} · ${new Date(s.createdAt).toLocaleTimeString()}</div>
                  </div>
                  <button
                    class="remove"
                    type="button"
                    aria-label="Remove ${s.title}"
                    @click=${(e: Event) => { e.stopPropagation(); this._emit('gcb:save-remove', s.id); }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                </div>
              `)}
        </div>

        <div class="divider"></div>

        <!-- Datasets (raw uploads) -->
        <div class="section" role="list" aria-label="Datasets">
          <div class="section-lbl">Datasets</div>
          ${this.datasets.length === 0
            ? html`<div class="empty">No datasets uploaded.</div>`
            : this.datasets.map((d) => html`
                <div class="row dataset-row" role="listitem">
                  <svg class="icon" viewBox="0 0 14 14" fill="none">
                    <rect x="1" y="2.5" width="12" height="9" rx="1" stroke="currentColor" stroke-width="1.1"/>
                    <line x1="1" y1="5.5" x2="13" y2="5.5" stroke="currentColor" stroke-width=".9"/>
                    <line x1="4.5" y1="5.5" x2="4.5" y2="11.5" stroke="currentColor" stroke-width=".9"/>
                  </svg>
                  <span class="dot" style="background: var(--gcb-ink-muted)"></span>
                  <span class="name" title=${d.name}>${d.name}</span>
                  <span class="count">${d.rows.toLocaleString()} r</span>
                  <button
                    class="eye"
                    type="button"
                    aria-label="Toggle visibility for ${d.name}"
                    @click=${(e: Event) => { e.stopPropagation(); this._emit('gcb:dataset-toggle', d.name); }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                    </svg>
                  </button>
                </div>
              `)}
        </div>

      </div><!-- /panel-scroll -->

      <!-- Add data CTA pinned to the bottom -->
      <div class="panel-foot">
        <button
          class="add-btn"
          type="button"
          aria-label="Add data"
          @click=${() => this._emitVoid('gcb:add-data')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          Add data
        </button>
      </div>
    `;
  }

  private _savedIcon(kind: SavedResultV1['kind']): unknown {
    switch (kind) {
      case 'chart':
        return html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
        </svg>`;
      case 'map':
        return html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/>
        </svg>`;
      case 'table':
        return html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="3" x2="9" y2="21"/>
        </svg>`;
      case 'summary':
      default:
        return html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="14" y2="18"/>
        </svg>`;
    }
  }
}

// suppress unused-import lint until tests use this
void nothing;

declare global {
  interface HTMLElementTagNameMap {
    'gcb-rail': GcbRail;
  }
}
