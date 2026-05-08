import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { loadFile } from './data/loaders';
import { getEngine } from './data/engine';
import { profileDataset } from './data/profile';
import type { LoadResult, DatasetProfile } from './data/contracts';
import './ui/MapView';

/**
 * <geo-chatbot> — top-level Web Component.
 *
 * Phase 1 surface: file drop zone → DataLoader pipeline → Arrow table.
 * When a loaded table carries a GeometryEncoding, the table is forwarded to
 * <gcb-map> for rendering. Agent loop, plan-approval UI, and result
 * rendering land in subsequent phases.
 *
 * Style isolation comes from Shadow DOM.
 */
@customElement('geo-chatbot')
export class GeoChatBotElement extends LitElement {
  static styles = css`
    :host {
      display: block;
      font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
      color: #1a1a1a;
      background: #fff;
      border: 1px solid #e3e3e3;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
      padding: 16px;
      max-width: 880px;
    }
    header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
    header h2 { margin: 0; font-size: 16px; font-weight: 600; }
    header .badge {
      font-size: 11px; padding: 2px 6px; border-radius: 4px;
      background: #eef2ff; color: #4338ca;
    }
    .drop {
      border: 2px dashed #c7c7c7; border-radius: 10px;
      padding: 28px; text-align: center; cursor: pointer;
      transition: border-color .15s, background .15s;
    }
    .drop.over { border-color: #4338ca; background: #f5f3ff; }
    .drop p { margin: 0; color: #555; font-size: 14px; }
    .hint { font-size: 12px; color: #888; margin-top: 4px; }
    .tables { margin-top: 16px; display: flex; flex-direction: column; gap: 12px; }
    .table-card {
      border: 1px solid #e3e3e3; border-radius: 8px; padding: 12px;
      background: #fafafa;
    }
    .table-card h3 { margin: 0 0 4px; font-size: 14px; font-weight: 600; }
    .table-card .summary { font-size: 12px; color: #555; margin-bottom: 8px; }
    table { border-collapse: collapse; font-size: 12px; width: 100%; }
    th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #eee; }
    th { color: #666; font-weight: 500; }
    .err {
      margin-top: 12px; padding: 10px; border-radius: 6px;
      background: #fef2f2; color: #991b1b; font-size: 13px;
    }
    .geom { color: #047857; font-weight: 500; }
    gcb-map { margin-top: 12px; }
  `;

  @state() private loaded: LoadResult[] = [];
  @state() private profiles: Record<string, DatasetProfile> = {};
  @state() private error: string | null = null;
  @state() private dragOver = false;
  @state() private busy = false;

  render() {
    return html`
      <header>
        <h2>GeoChatBot</h2>
        <span class="badge">phase 1 · ingest</span>
      </header>

      <div
        class="drop ${this.dragOver ? 'over' : ''}"
        @click=${this.openPicker}
        @dragover=${this.onDragOver}
        @dragleave=${this.onDragLeave}
        @drop=${this.onDrop}
      >
        <p>${this.busy ? 'Loading…' : 'Drop a file here or click to choose'}</p>
        <p class="hint">CSV · GeoJSON · Shapefile (.zip) · Excel · Parquet</p>
      </div>

      ${this.error ? html`<div class="err">${this.error}</div>` : null}

      ${this.geometryLayers().length
        ? html`<gcb-map .layers=${this.geometryLayers()}></gcb-map>`
        : null}

      <div class="tables">
        ${this.loaded.map((r) => this.renderTable(r))}
      </div>
    `;
  }

  private renderTable(result: LoadResult) {
    const profile = this.profiles[result.name];
    const geomCol = result.geometry?.kind === 'lonlat'
      ? `${result.geometry.lonColumn},${result.geometry.latColumn}`
      : result.geometry?.column;
    const cols = profile
      ? profile.columns
      : result.table.schema.fields.map((f) => ({
          name: f.name,
          kind: 'other' as const,
          arrowType: String(f.type),
          nullCount: 0,
        }));
    const summary = profile
      ? `${result.source} · ${profile.rowCount.toLocaleString()} rows · ${profile.columns.length} columns` +
        (profile.geometry
          ? ` · geometry: ${profile.geometry.column} (${profile.geometry.encoding}, ${profile.geometry.crsGuess})`
          : '')
      : `${result.source} · ${result.table.numRows.toLocaleString()} rows · ${result.table.schema.fields.length} columns`;
    return html`
      <div class="table-card">
        <h3>${result.name}</h3>
        <div class="summary">${summary}</div>
        <table>
          <thead>
            <tr><th>column</th><th>kind</th><th>arrow type</th><th>nulls</th></tr>
          </thead>
          <tbody>
            ${cols.map(
              (c) => html`<tr>
                <td class=${c.name === geomCol ? 'geom' : ''}>${c.name}</td>
                <td>${'kind' in c ? c.kind : ''}</td>
                <td>${c.arrowType}</td>
                <td>${c.nullCount ?? ''}</td>
              </tr>`,
            )}
          </tbody>
        </table>
      </div>
    `;
  }

  private geometryLayers() {
    return this.loaded
      .filter((r) => !!r.geometry)
      .map((r) => ({ name: r.name, table: r.table, geometry: r.geometry! }));
  }

  private onDragOver = (e: DragEvent) => { e.preventDefault(); this.dragOver = true; };
  private onDragLeave = () => { this.dragOver = false; };
  private onDrop = async (e: DragEvent) => {
    e.preventDefault();
    this.dragOver = false;
    const files = e.dataTransfer?.files;
    if (files && files.length) await this.handleFiles(Array.from(files));
  };

  private openPicker = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.csv,.tsv,.geojson,.json,.zip,.shp,.xlsx,.xls,.parquet';
    input.addEventListener('change', async () => {
      if (input.files) await this.handleFiles(Array.from(input.files));
    });
    input.click();
  };

  private async handleFiles(files: File[]) {
    this.busy = true;
    this.error = null;
    try {
      for (const f of files) {
        try {
          const result = await loadFile(f);

          const profile = profileDataset(result);
          this.profiles = { ...this.profiles, [result.name]: profile };

          // Best-effort engine registration. wasm boot may fail without
          // COOP/COEP headers; we still show the schema + map.
          let engineRegistered = false;
          try {
            const engine = getEngine();
            await engine.init();
            await engine.registerArrow(result);
            engineRegistered = true;
          } catch (err) {
            console.warn('[geochatbot] engine registration failed; continuing in JS-only mode', err);
          }

          this.loaded = [...this.loaded, result];
          this.dispatchEvent(
            new CustomEvent('geochatbot:layer-loaded', {
              detail: { name: result.name, source: result.source, hasGeometry: !!result.geometry, profile, engineRegistered },
              bubbles: true,
              composed: true,
            }),
          );
        } catch (err) {
          this.error = err instanceof Error ? err.message : String(err);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'geo-chatbot': GeoChatBotElement;
  }
}
