/**
 * <result-canvas> — host for Phase 5 render.* outputs in full mode.
 *
 * Stores the most recent {@link ResultPayload} per kind and renders all
 * present payloads stacked vertically inside Shadow DOM. Map rendering
 * lazy-loads MapLibre via the existing <gcb-map> module so the initial
 * paint stays under the §3 budget.
 *
 * Headless mode bypasses this component entirely — the host element
 * dispatches `result` events without mounting it.
 */

import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { ResultPayload } from '../agent/executor/types.js';

@customElement('result-canvas')
export class ResultCanvas extends LitElement {
  static override styles = css`
    :host {
      display: block;
      margin-top: 12px;
      font-family: var(--gcb-font, system-ui, sans-serif);
      color: var(--gcb-fg, #1a1a1a);
    }
    .panel {
      border: 1px solid var(--gcb-border, #e3e3e3);
      border-radius: var(--gcb-radius, 12px);
      padding: 12px;
      margin-top: 12px;
      background: var(--gcb-bg, #ffffff);
    }
    .panel h4 {
      margin: 0 0 8px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--gcb-muted-fg, #555555);
    }
    .summary {
      font-size: 14px;
      line-height: 1.4;
      white-space: pre-wrap;
    }
    table {
      border-collapse: collapse;
      font-size: 12px;
      width: 100%;
    }
    th, td {
      text-align: left;
      padding: 4px 8px;
      border-bottom: 1px solid var(--gcb-border, #e3e3e3);
    }
    th {
      color: var(--gcb-muted-fg, #555555);
      font-weight: 500;
    }
    .chart-placeholder {
      font-size: 12px;
      color: var(--gcb-muted-fg, #555555);
      padding: 12px;
      border: 1px dashed var(--gcb-drop-border, #c7c7c7);
      border-radius: 6px;
      background: var(--gcb-table-bg, #fafafa);
    }
    .chart-placeholder pre {
      margin: 8px 0 0;
      font-size: 11px;
      max-height: 240px;
      overflow: auto;
    }
    gcb-map { display: block; height: var(--gcb-map-height, 360px); }
  `;

  @state() private _summary: ResultPayload | null = null;
  @state() private _table: ResultPayload | null = null;
  @state() private _chart: ResultPayload | null = null;
  @state() private _layer: ResultPayload | null = null;

  /** Public method: surface a result payload to the user. */
  setResult(p: ResultPayload): void {
    switch (p.kind) {
      case 'summary': this._summary = p; break;
      case 'table': this._table = p; break;
      case 'chart': this._chart = p; break;
      case 'layer': this._layer = p; break;
    }
  }

  clear(): void {
    this._summary = null;
    this._table = null;
    this._chart = null;
    this._layer = null;
  }

  override render() {
    return html`
      ${this._renderSummary()}
      ${this._renderTable()}
      ${this._renderChart()}
      ${this._renderLayer()}
    `;
  }

  private _renderSummary(): TemplateResult | typeof nothing {
    if (!this._summary || this._summary.kind !== 'summary') return nothing;
    return html`
      <div class="panel">
        <h4>Summary</h4>
        <div class="summary">${this._summary.text}</div>
      </div>
    `;
  }

  private _renderTable(): TemplateResult | typeof nothing {
    if (!this._table || this._table.kind !== 'table') return nothing;
    const cols = this._table.columns;
    const rows = this._table.rows.slice(0, 200);
    return html`
      <div class="panel">
        <h4>Table (${this._table.rows.length} rows)</h4>
        <div style="max-height: 320px; overflow: auto;">
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

  private _renderChart(): TemplateResult | typeof nothing {
    if (!this._chart || this._chart.kind !== 'chart') return nothing;
    // ECharts integration is post-Phase-5 (~250 KB lazy-load). For now we
    // surface the spec inline so the developer can see / pipe it elsewhere
    // and so the headless contract is verifiable end-to-end.
    // Defensive: a malformed payload could omit `data`/`x`/`y` (the
    // executor type guarantees them, but a future critic-patched step or
    // host-injected event could violate the type at runtime). Coerce to
    // safe defaults so the entire shadow root render doesn't throw.
    const spec = this._chart.spec;
    const dataLen = Array.isArray(spec.data) ? spec.data.length : 0;
    return html`
      <div class="panel">
        <h4>Chart (${spec.kind})</h4>
        <div class="chart-placeholder">
          ${dataLen} data points · x=${spec.x ?? '(missing)'}, y=${spec.y ?? '(missing)'}
          <pre>${JSON.stringify(spec, null, 2)}</pre>
        </div>
      </div>
    `;
  }

  private _renderLayer(): TemplateResult | typeof nothing {
    if (!this._layer || this._layer.kind !== 'layer') return nothing;
    const fc = this._layer.geojson;
    // Same defensive coercion as _renderChart: an upstream malformed
    // layer payload (no `features`) would throw on `.features.length`.
    const featCount = Array.isArray(fc?.features) ? fc.features.length : 0;
    return html`
      <div class="panel">
        <h4>Map (${featCount} features)</h4>
        <div class="chart-placeholder">
          GeoJSON FeatureCollection with ${featCount} features.
          Drop into your map via the <code>result</code> event payload, or
          enable the bundled <code>&lt;gcb-map&gt;</code> renderer (lazy-loaded after the first geometry ingest).
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

declare global {
  interface HTMLElementTagNameMap {
    'result-canvas': ResultCanvas;
  }
}
