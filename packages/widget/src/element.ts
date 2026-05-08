import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { loadFile } from './data/loaders';
import { getEngine } from './data/engine';
import { profileDataset } from './data/profile';
import type { BinaryInput, LoadResult, DatasetProfile, SourceFormat } from './data/contracts';
import {
  type ChatProvider,
  setProvider as setActiveProvider,
} from './providers/index';
import './ui/MapView';

/**
 * Typed event map dispatched by {@link GeoChatBotElement}.
 *
 * The string event names are namespaced as `geochatbot:<key>`. The `plan`
 * event is reserved for phase 3 and is not emitted yet, but the type is
 * exported so consumers can wire handlers ahead of time.
 */
export type GeoChatBotEvents = {
  result: {
    name: string;
    source: SourceFormat;
    profile: DatasetProfile;
    engineRegistered: boolean;
  };
  plan: {
    steps: Array<{ id: string; description: string }>;
    rationale?: string;
  };
  error: { message: string; code?: string; cause?: unknown };
};

const EVENT_NAME: Record<keyof GeoChatBotEvents, string> = {
  result: 'geochatbot:result',
  plan: 'geochatbot:plan',
  error: 'geochatbot:error',
};

/**
 * <geo-chatbot> — top-level Web Component.
 *
 * Phase 2 surface:
 *   - file drop / picker / programmatic {@link pushData} all funnel through
 *     a single ingest path
 *   - typed `result` / `error` / `plan` events via {@link on}
 *   - {@link setProvider} stores the active LLM provider for the agent loop
 *   - {@link clear} resets all loaded state (provider survives)
 *   - full CSS-variable theming with a built-in `theme="dark"` mode
 *
 * Style isolation comes from Shadow DOM.
 */
@customElement('geo-chatbot')
export class GeoChatBotElement extends LitElement {
  static styles = css`
    :host {
      /* Theme tokens — override from light DOM by setting these on the host. */
      --gcb-bg: #ffffff;
      --gcb-fg: #1a1a1a;
      --gcb-muted-fg: #555555;
      --gcb-border: #e3e3e3;
      --gcb-radius: 12px;
      --gcb-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
      --gcb-accent: #4338ca;
      --gcb-accent-soft-bg: #f5f3ff;
      --gcb-accent-badge-bg: #eef2ff;
      --gcb-drop-border: #c7c7c7;
      --gcb-table-bg: #fafafa;
      --gcb-error-bg: #fef2f2;
      --gcb-error-fg: #991b1b;
      --gcb-geom-fg: #047857;
      --gcb-font: system-ui, -apple-system, 'Segoe UI', sans-serif;
      --gcb-map-height: 360px;
      --gcb-max-width: 880px;

      display: block;
      font-family: var(--gcb-font);
      color: var(--gcb-fg);
      background: var(--gcb-bg);
      border: 1px solid var(--gcb-border);
      border-radius: var(--gcb-radius);
      box-shadow: var(--gcb-shadow);
      padding: 16px;
      max-width: var(--gcb-max-width);
    }
    :host([theme='dark']) {
      --gcb-bg: #0b1020;
      --gcb-fg: #e5e7eb;
      --gcb-muted-fg: #9ca3af;
      --gcb-border: #1f2937;
      --gcb-shadow: 0 2px 12px rgba(0, 0, 0, 0.4);
      --gcb-accent: #818cf8;
      --gcb-accent-soft-bg: #1e1b4b;
      --gcb-accent-badge-bg: #312e81;
      --gcb-drop-border: #374151;
      --gcb-table-bg: #111827;
      --gcb-error-bg: #3f1d1d;
      --gcb-error-fg: #fca5a5;
      --gcb-geom-fg: #34d399;
      --gcb-map-bg: #0f172a;
    }
    header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
    header h2 { margin: 0; font-size: 16px; font-weight: 600; }
    header .badge {
      font-size: 11px; padding: 2px 6px; border-radius: 4px;
      background: var(--gcb-accent-badge-bg); color: var(--gcb-accent);
    }
    .drop {
      border: 2px dashed var(--gcb-drop-border); border-radius: 10px;
      padding: 28px; text-align: center; cursor: pointer;
      transition: border-color .15s, background .15s;
    }
    .drop.over { border-color: var(--gcb-accent); background: var(--gcb-accent-soft-bg); }
    .drop p { margin: 0; color: var(--gcb-muted-fg); font-size: 14px; }
    .hint { font-size: 12px; color: var(--gcb-muted-fg); margin-top: 4px; opacity: 0.8; }
    .tables { margin-top: 16px; display: flex; flex-direction: column; gap: 12px; }
    .table-card {
      border: 1px solid var(--gcb-border); border-radius: 8px; padding: 12px;
      background: var(--gcb-table-bg);
    }
    .table-card h3 { margin: 0 0 4px; font-size: 14px; font-weight: 600; }
    .table-card .summary { font-size: 12px; color: var(--gcb-muted-fg); margin-bottom: 8px; }
    table { border-collapse: collapse; font-size: 12px; width: 100%; }
    th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--gcb-border); }
    th { color: var(--gcb-muted-fg); font-weight: 500; }
    .err {
      margin-top: 12px; padding: 10px; border-radius: 6px;
      background: var(--gcb-error-bg); color: var(--gcb-error-fg); font-size: 13px;
    }
    .geom { color: var(--gcb-geom-fg); font-weight: 500; }
    gcb-map { margin-top: 12px; }
  `;

  @state() private loaded: LoadResult[] = [];
  @state() private profiles: Record<string, DatasetProfile> = {};
  @state() private error: string | null = null;
  @state() private dragOver = false;
  @state() private busy = false;

  /** Active LLM provider, set via {@link setProvider}. Survives {@link clear}. */
  private provider: ChatProvider | undefined = undefined;

  render() {
    return html`
      <header>
        <h2>GeoChatBot</h2>
        <span class="badge">phase 2 · ingest</span>
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

  /* -------------------------------------------------------------------- */
  /* Public API                                                           */
  /* -------------------------------------------------------------------- */

  /**
   * Ingest a single file or in-memory binary blob through the same pipeline
   * used by drag-drop and the picker. Always resolves; ingest failures are
   * surfaced via the `error` event and the component's error banner rather
   * than thrown.
   */
  async pushData(
    input: File | { name: string; bytes: Uint8Array | ArrayBuffer },
  ): Promise<void> {
    const binary: BinaryInput =
      typeof File !== 'undefined' && input instanceof File
        ? input
        : (input as { name: string; bytes: Uint8Array | ArrayBuffer });
    await this.ingest(binary);
  }

  /** Set the active LLM provider used by future agent turns. */
  setProvider(provider: ChatProvider): void {
    this.provider = provider;
    setActiveProvider(provider);
  }

  /** Currently active provider, if any. Exposed for tests / introspection. */
  getProvider(): ChatProvider | undefined {
    return this.provider;
  }

  /**
   * Subscribe to a typed event. Returns an unsubscribe function.
   *
   * Sugar over `addEventListener` that unwraps the `CustomEvent.detail`.
   */
  on<K extends keyof GeoChatBotEvents>(
    event: K,
    handler: (detail: GeoChatBotEvents[K]) => void,
  ): () => void {
    const name = EVENT_NAME[event];
    const listener = (e: Event) => {
      const ce = e as CustomEvent<GeoChatBotEvents[K]>;
      handler(ce.detail);
    };
    this.addEventListener(name, listener as EventListener);
    return () => this.removeEventListener(name, listener as EventListener);
  }

  /**
   * Reset loaded datasets, profiles, errors, and drag state. Does not
   * remove the active provider.
   */
  clear(): void {
    this.loaded = [];
    this.profiles = {};
    this.error = null;
    this.dragOver = false;
    this.busy = false;
  }

  /** Public read-only view of the currently loaded results (for tests). */
  get results(): readonly LoadResult[] {
    return this.loaded;
  }

  /* -------------------------------------------------------------------- */
  /* Rendering helpers                                                    */
  /* -------------------------------------------------------------------- */

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

  /* -------------------------------------------------------------------- */
  /* Drag & drop / picker                                                 */
  /* -------------------------------------------------------------------- */

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
    for (const f of files) {
      await this.pushData(f);
    }
  }

  /* -------------------------------------------------------------------- */
  /* Single ingest path                                                   */
  /* -------------------------------------------------------------------- */

  private async ingest(input: BinaryInput): Promise<void> {
    this.busy = true;
    this.error = null;
    try {
      const result = await loadFile(input);
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
        console.warn(
          '[geochatbot] engine registration failed; continuing in JS-only mode',
          err,
        );
      }

      this.loaded = [...this.loaded, result];

      const detail: GeoChatBotEvents['result'] = {
        name: result.name,
        source: result.source,
        profile,
        engineRegistered,
      };
      this.dispatchEvent(
        new CustomEvent<GeoChatBotEvents['result']>(EVENT_NAME.result, {
          detail,
          bubbles: true,
          composed: true,
        }),
      );

      // Legacy event — kept for one more phase. Will be removed in phase 3.
      // @deprecated Use the `result` event (`geochatbot:result`) instead.
      this.dispatchEvent(
        new CustomEvent('geochatbot:layer-loaded', {
          detail: {
            name: result.name,
            source: result.source,
            hasGeometry: !!result.geometry,
            profile,
            engineRegistered,
          },
          bubbles: true,
          composed: true,
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code: unknown }).code)
          : undefined;
      this.error = message;
      const errorDetail: GeoChatBotEvents['error'] = code
        ? { message, code, cause: err }
        : { message, cause: err };
      this.dispatchEvent(
        new CustomEvent<GeoChatBotEvents['error']>(EVENT_NAME.error, {
          detail: errorDetail,
          bubbles: true,
          composed: true,
        }),
      );
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
