/**
 * <result-canvas> — chat history host.
 *
 * Renders a scrollable thread of user / AI turns, with each AI turn
 * containing inline result cards (summary / chart / table / map).
 *
 * Public API used by element.ts:
 *   - beginTurn(question)         — start a new user turn (right-aligned bubble)
 *   - setOrigin(origin)           — pass plan/step/question for save events
 *   - setResult(payload)          — append a result card to the latest AI turn
 *   - clear()                     — reset the whole thread
 *
 * Headless mode bypasses this component entirely — the host element
 * dispatches `result` events without mounting it.
 *
 * Spec: docs/superpowers/specs/2026-05-08-phase-7-dashboard-redesign-design.md §3.2
 */

import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { tokensCSS } from './tokens.js';
import type { ResultPayload } from '../agent/executor/types.js';
import type { GeoJsonInputLayer } from './MapView.js';

interface Turn {
  id: string;
  question: string;
  text?: string;
  results: ResultPayload[];
  origin: { planId: string; stepId: string; question: string };
}

@customElement('result-canvas')
export class ResultCanvas extends LitElement {
  static override styles = [
    tokensCSS,
    css`
      :host {
        display: block;
        height: 100%;
        font-family: var(--gcb-font-sans);
        color: var(--gcb-ink);
        overflow-y: auto;
        padding: 20px 0 8px;
        scroll-behavior: smooth;
      }

      .empty {
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        height: 100%; min-height: 200px;
        color: var(--gcb-ink-muted);
        text-align: center; padding: 32px;
      }
      .empty-icon {
        width: 48px; height: 48px;
        border-radius: 50%;
        background: var(--gcb-accent-soft);
        color: var(--gcb-accent);
        display: grid; place-items: center;
        margin-bottom: 16px;
      }
      .empty-title {
        font-family: var(--gcb-font-display);
        font-size: 22px; font-weight: 500;
        font-style: italic;
        color: var(--gcb-ink);
        margin-bottom: 6px;
      }
      .empty-sub { font-size: 13px; max-width: 360px; line-height: 1.5; }

      .msg {
        display: flex; gap: 12px;
        padding: 2px 20px;
        max-width: 860px;
      }
      .msg + .msg { margin-top: 2px; }
      .msg-last { margin-bottom: 18px; }

      .avatar {
        width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0;
        display: grid; place-items: center;
        font-size: 12px; font-weight: 700; margin-top: 1px;
        background: var(--gcb-accent-soft);
        color: var(--gcb-accent-ink);
        border: 1px solid var(--gcb-accent-ring);
      }
      .body { flex: 1; min-width: 0; }
      .who {
        font-size: 12px; font-weight: 600;
        color: var(--gcb-ink-muted); margin-bottom: 3px;
      }
      .text {
        font-size: 14px; color: var(--gcb-ink-soft); line-height: 1.65;
      }
      .text code {
        background: var(--gcb-bg-3); border: 1px solid var(--gcb-line);
        padding: 1px 5px; border-radius: 4px;
        font-family: var(--gcb-font-mono); font-size: 12px;
      }
      .text strong {
        color: var(--gcb-accent); font-family: var(--gcb-font-mono);
      }

      .msg.user { justify-content: flex-end; padding-left: 80px; }
      .bubble {
        display: inline-block;
        background: var(--gcb-user-bg); color: #fff;
        padding: 9px 14px; border-radius: 18px 18px 4px 18px;
        font-size: 14px; line-height: 1.5; max-width: 480px;
        word-wrap: break-word;
      }

      /* Result cards */
      .card {
        margin-top: 10px;
        border: 1px solid var(--gcb-line);
        border-radius: var(--gcb-radius-lg);
        overflow: hidden;
        background: var(--gcb-bg-2);
        box-shadow: var(--gcb-shadow-1);
      }
      .card-hdr {
        display: flex; align-items: center; gap: 7px;
        padding: 8px 12px;
        border-bottom: 1px solid var(--gcb-line);
        background: var(--gcb-bg-3);
      }
      .card-hdr svg { color: var(--gcb-accent); flex-shrink: 0; }
      .card-lbl {
        font-size: 10px; font-weight: 700;
        letter-spacing: .07em; text-transform: uppercase;
        color: var(--gcb-ink-muted); flex: 1;
      }
      .save-btn {
        display: flex; align-items: center; gap: 4px;
        padding: 3px 8px; border-radius: 5px;
        border: 1px solid var(--gcb-line);
        background: transparent;
        color: var(--gcb-ink-muted);
        font: inherit; font-size: 11px; cursor: pointer;
        transition: background 120ms, border-color 120ms, color 120ms;
      }
      .save-btn:hover {
        background: var(--gcb-bg-4);
        color: var(--gcb-ink);
        border-color: var(--gcb-accent-ring);
      }

      /* Summary card */
      .sum-bd { padding: 14px 16px; }
      .sum-num {
        font-size: 32px; font-weight: 700; letter-spacing: -.02em;
        font-family: var(--gcb-font-mono); color: var(--gcb-accent); line-height: 1;
      }
      .sum-text {
        font-size: 14px; color: var(--gcb-ink-soft);
        line-height: 1.5; white-space: pre-wrap;
      }

      /* Chart card */
      .chart-bd { padding: 14px 16px; }
      .bar-row { display: flex; align-items: center; gap: 9px; margin-bottom: 9px; }
      .bar-row:last-child { margin-bottom: 0; }
      .bar-lbl {
        width: 90px; font-size: 11px; color: var(--gcb-ink-soft);
        text-align: right; flex-shrink: 0;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .bar-track {
        flex: 1; height: 14px;
        background: var(--gcb-bg-3); border: 1px solid var(--gcb-line);
        border-radius: 3px; overflow: hidden;
      }
      .bar-fill {
        height: 100%; background: var(--gcb-accent);
        opacity: 0.78; border-radius: 2px;
      }
      .bar-val {
        width: 50px; font-size: 10px; color: var(--gcb-ink-muted);
        font-family: var(--gcb-font-mono); flex-shrink: 0;
      }
      .chart-fallback {
        font-size: 12px; color: var(--gcb-ink-muted);
        padding: 12px;
        border: 1px dashed var(--gcb-line); border-radius: var(--gcb-radius-sm);
        background: var(--gcb-bg-3);
      }
      .chart-fallback pre {
        margin: 8px 0 0; font-size: 11px; max-height: 240px; overflow: auto;
      }

      /* Table card */
      .tbl-bd { max-height: 320px; overflow: auto; }
      table { border-collapse: collapse; font-size: 12px; width: 100%; }
      th, td {
        text-align: left; padding: 6px 10px;
        border-bottom: 1px solid var(--gcb-line);
      }
      th {
        position: sticky; top: 0;
        background: var(--gcb-bg-3);
        color: var(--gcb-ink-muted);
        font-weight: 600; letter-spacing: .04em;
        font-size: 11px; text-transform: uppercase;
      }

      /* Map card */
      .map-bd { position: relative; }
      gcb-map { display: block; height: 260px; }
      .map-loading {
        font-size: 12px; color: var(--gcb-ink-muted);
        padding: 60px 12px; text-align: center;
        background: var(--gcb-bg-3);
      }
      .layer-added {
        position: absolute; bottom: 10px; left: 10px;
        display: flex; align-items: center; gap: 5px;
        padding: 4px 10px; border-radius: 999px;
        background: var(--gcb-accent); color: var(--gcb-accent-fg);
        font-size: 11px; font-weight: 600;
      }

      ::-webkit-scrollbar { width: 6px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: var(--gcb-line); border-radius: 3px; }
      ::-webkit-scrollbar-thumb:hover { background: var(--gcb-line-strong); }
    `,
  ];

  @state() private _turns: Turn[] = [];
  @state() private _mapLoaded = false;

  /** Origin metadata for the next save event. */
  private _origin: { planId: string; stepId: string; question: string } = { planId: '', stepId: '', question: '' };

  /** Begin a new user turn. Called by the host when ask() fires. */
  beginTurn(question: string): void {
    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this._turns = [...this._turns, { id, question, results: [], origin: { ...this._origin, question } }];
    this._scrollToBottomNextTick();
  }

  /** Pass plan/step metadata for save events on the latest turn. */
  setOrigin(origin: { planId: string; stepId: string; question: string }): void {
    this._origin = origin;
    if (this._turns.length > 0) {
      const last = this._turns[this._turns.length - 1]!;
      last.origin = origin;
    }
  }

  /** Append a result payload to the latest turn (or create one if none exists). */
  setResult(p: ResultPayload): void {
    if (this._turns.length === 0) {
      this.beginTurn('');
    }
    const last = this._turns[this._turns.length - 1]!;
    const next: Turn = { ...last, results: [...last.results, p] };
    this._turns = [...this._turns.slice(0, -1), next];
    if (p.kind === 'layer' && !this._mapLoaded) {
      void import('./MapView.js').then(() => { this._mapLoaded = true; });
    }
    this._scrollToBottomNextTick();
  }

  /** Reset all turns. Called between executions. */
  clear(): void {
    this._turns = [];
  }

  private _scrollToBottomNextTick(): void {
    queueMicrotask(() => {
      this.scrollTop = this.scrollHeight;
    });
  }

  override render() {
    if (this._turns.length === 0) {
      return html`
        <div class="empty">
          <div class="empty-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
            </svg>
          </div>
          <div class="empty-title">Ask a question</div>
          <div class="empty-sub">Upload a dataset using "Add data", then ask GeoChatBot anything about it. Charts, maps, and answers will appear here.</div>
        </div>
      `;
    }

    return html`${this._turns.map((t, i) => this._renderTurn(t, i === this._turns.length - 1))}`;
  }

  private _renderTurn(t: Turn, isLast: boolean): TemplateResult {
    const lastClass = isLast ? 'msg-last' : '';
    return html`
      ${t.question
        ? html`
            <div class="msg user ${lastClass}">
              <div><span class="bubble">${t.question}</span></div>
            </div>`
        : nothing}
      <div class="msg ${lastClass}">
        <div class="avatar">G</div>
        <div class="body">
          <div class="who">GeoChatBot</div>
          ${t.text ? html`<div class="text">${t.text}</div>` : nothing}
          ${t.results.map((p) => this._renderResult(p, t))}
        </div>
      </div>
    `;
  }

  private _renderResult(p: ResultPayload, turn: Turn): TemplateResult | typeof nothing {
    switch (p.kind) {
      case 'summary': return this._renderSummary(p, turn);
      case 'chart':   return this._renderChart(p, turn);
      case 'table':   return this._renderTable(p, turn);
      case 'layer':   return this._renderLayer(p, turn);
    }
  }

  private _saveBtn(kind: string, payload: ResultPayload, title: string, turn: Turn) {
    return html`
      <button
        class="save-btn"
        type="button"
        @click=${() => this._emitSave(kind, payload, title, turn)}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/>
        </svg>
        Save
      </button>
    `;
  }

  private _emitSave(kind: string, payload: ResultPayload, title: string, turn: Turn): void {
    this.dispatchEvent(new CustomEvent('gcb:save-result', {
      bubbles: true, composed: true,
      detail: { kind, payload, title, origin: turn.origin },
    }));
  }

  private _renderSummary(p: ResultPayload, turn: Turn): TemplateResult {
    if (p.kind !== 'summary') return html``;
    // Try to extract a leading number for hero display (e.g. "0.43°", "5", "1,234.5 km").
    const match = /^([-+]?\d{1,3}(?:[,\d]*)(?:\.\d+)?\s*[°a-zA-Z%]*)/.exec(p.text.trim());
    const leadNum = match?.[1] ?? null;
    const rest = leadNum ? p.text.trim().slice(leadNum.length).trim() : p.text;
    return html`
      <div class="card">
        <div class="card-hdr">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <span class="card-lbl">Summary</span>
          ${this._saveBtn('summary', p, 'Summary', turn)}
        </div>
        <div class="sum-bd">
          ${leadNum ? html`<div class="sum-num">${leadNum}</div>` : nothing}
          <div class="sum-text" style="margin-top:${leadNum ? '6px' : '0'};">${rest}</div>
        </div>
      </div>
    `;
  }

  private _renderChart(p: ResultPayload, turn: Turn): TemplateResult {
    if (p.kind !== 'chart') return html``;
    const spec = p.spec;
    const data = Array.isArray(spec.data) ? (spec.data as Array<Record<string, unknown>>).slice(0, 60) : [];
    const title = `chart · ${spec.x} vs ${spec.y}`;

    if ((spec.kind === 'bar' || spec.kind === 'grouped_bar') && data.length > 0) {
      const values = data.map((d) => Number(d['y']) || 0);
      const maxVal = Math.max(...values, 0);
      return html`
        <div class="card">
          <div class="card-hdr">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <line x1="18" y1="20" x2="18" y2="10"/>
              <line x1="12" y1="20" x2="12" y2="4"/>
              <line x1="6" y1="20" x2="6" y2="14"/>
            </svg>
            <span class="card-lbl">Chart · ${spec.kind} · ${spec.x} vs ${spec.y}</span>
            ${this._saveBtn('chart', p, title, turn)}
          </div>
          <div class="chart-bd">
            ${data.map((d) => {
              const val = Number(d['y']) || 0;
              const pct = maxVal > 0 ? (val / maxVal) * 100 : 0;
              return html`
                <div class="bar-row">
                  <div class="bar-lbl" title="${String(d['x'] ?? '')}">${String(d['x'] ?? '').slice(0, 18)}</div>
                  <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
                  <div class="bar-val">${fmtNum(val)}</div>
                </div>
              `;
            })}
          </div>
        </div>
      `;
    }

    return html`
      <div class="card">
        <div class="card-hdr">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <line x1="18" y1="20" x2="18" y2="10"/>
            <line x1="12" y1="20" x2="12" y2="4"/>
            <line x1="6" y1="20" x2="6" y2="14"/>
          </svg>
          <span class="card-lbl">Chart · ${spec.kind}</span>
          ${this._saveBtn('chart', p, title, turn)}
        </div>
        <div class="chart-bd">
          <div class="chart-fallback">
            ${data.length} data points · x=${spec.x ?? '(missing)'}, y=${spec.y ?? '(missing)'}
            <pre>${JSON.stringify(spec, null, 2)}</pre>
          </div>
        </div>
      </div>
    `;
  }

  private _renderTable(p: ResultPayload, turn: Turn): TemplateResult {
    if (p.kind !== 'table') return html``;
    const cols = p.columns;
    const rows = p.rows.slice(0, 200);
    const title = `table · ${new Date().toLocaleTimeString()}`;
    return html`
      <div class="card">
        <div class="card-hdr">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <line x1="3" y1="9" x2="21" y2="9"/>
            <line x1="9" y1="3" x2="9" y2="21"/>
          </svg>
          <span class="card-lbl">Table · ${p.rows.length} rows · ${cols.length} cols</span>
          ${this._saveBtn('table', p, title, turn)}
        </div>
        <div class="tbl-bd">
          <table>
            <thead>
              <tr>${cols.map((c) => html`<th>${c}</th>`)}</tr>
            </thead>
            <tbody>
              ${rows.map((r) => html`
                <tr>${cols.map((c) => html`<td>${formatCell(r[c])}</td>`)}</tr>
              `)}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  private _renderLayer(p: ResultPayload, turn: Turn): TemplateResult {
    if (p.kind !== 'layer') return html``;
    const fc = p.geojson;
    const featCount = Array.isArray(fc?.features) ? fc.features.length : 0;
    const layerName = p.name ?? 'result';
    const mapTitle = `map · ${layerName}`;
    return html`
      <div class="card">
        <div class="card-hdr">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0118 0z"/>
            <circle cx="12" cy="10" r="3"/>
          </svg>
          <span class="card-lbl">Map · ${layerName} · ${featCount} features</span>
          ${this._saveBtn('map', p, mapTitle, turn)}
        </div>
        <div class="map-bd">
          ${this._mapLoaded
            ? html`<gcb-map .geojsonLayers=${[{ name: layerName, geojson: fc as { type: 'FeatureCollection'; features: unknown[] } }] as GeoJsonInputLayer[]}></gcb-map>`
            : html`<div class="map-loading">Loading map…</div>`}
          <div class="layer-added">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            Layer added to Contents
          </div>
        </div>
      </div>
    `;
  }
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n * 100) / 100);
}

declare global {
  interface HTMLElementTagNameMap {
    'result-canvas': ResultCanvas;
  }
}
