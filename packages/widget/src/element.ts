import { LitElement, html, css } from 'lit';
import { customElement, state, property } from 'lit/decorators.js';
import { loadFile } from './data/loaders';
import { getEngine } from './data/engine';
import { profileDataset } from './data/profile';
import type { BinaryInput, LoadResult, DatasetProfile, SourceFormat } from './data/contracts';
import {
  type ChatProvider,
  setProvider as setActiveProvider,
} from './providers/index';
import { Planner } from './agent/index.js';
import type { Plan, DatasetProfile as PlannerDatasetProfile } from './agent/index.js';
import type { PlannerLLMInput } from './agent/llm.js';
import { validateSql } from './agent/validate-sql.js';
import './ui/plan-review.js';
// MapView (MapLibre GL + deck.gl) is lazy-loaded on first geometry ingest
// so the initial bundle stays lean (PLAN §3 hard rule: ≤ 100 KB gzipped).

/** Operating modes — see {@link GeoChatBotElement.setMode}. */
export type GeoChatBotMode = 'full' | 'headless';

/**
 * A single step in an agent plan. Phase 2 emits stub plans; Phase 4 fills
 * `tool` and `args` from the real Planner.
 */
export interface PlanStep {
  id: string;
  /** Human-readable description for the plan UI. */
  description: string;
  /** Tool the executor will call (Phase 5). Optional in stub plans. */
  tool?: string;
  /** Tool arguments. Validated via zod in Phase 5. */
  args?: Record<string, unknown>;
  /** One-line rationale for this step. */
  why?: string;
}

/** A single agent result emitted via the `result` event in headless mode. */
export type AgentResult =
  | {
      kind: 'layer';
      /** GeoJSON FeatureCollection. */
      geojson: unknown;
      /** Optional layer name for the host map. */
      name?: string;
    }
  | {
      kind: 'chart';
      /** ECharts option spec (Phase 5). Free-form for now. */
      spec: Record<string, unknown>;
    }
  | {
      kind: 'table';
      rows: ReadonlyArray<Record<string, unknown>>;
      columns?: ReadonlyArray<string>;
    }
  | {
      kind: 'summary';
      text: string;
    };

/**
 * Typed event map dispatched by {@link GeoChatBotElement}.
 *
 * The string event names are namespaced as `geochatbot:<key>`.
 *
 * - `dataset-loaded` — fires when ingest completes for a file/blob.
 * - `plan`           — agent has produced a plan (Phase 4 emits real ones).
 * - `result`         — agent has produced a result for a step (Phase 5 emits real ones).
 * - `progress`       — agent execution progress beat (Phase 5+).
 * - `error`          — any ingest or agent failure. `cause` is intentionally
 *                      a string (provider error code or message) so we never
 *                      leak raw Error objects that might carry secrets.
 */
export type GeoChatBotEvents = {
  'dataset-loaded': {
    name: string;
    source: SourceFormat;
    profile: DatasetProfile;
    engineRegistered: boolean;
  };
  result: AgentResult;
  plan: {
    /** Stable plan id; lets host UIs correlate `result` events to a plan. */
    id: string;
    steps: PlanStep[];
    rationale?: string;
    /** Names of datasets this plan operates on. */
    datasetRefs?: ReadonlyArray<string>;
  };
  progress: {
    /** Plan id this progress beat belongs to. */
    planId: string;
    /** 0-based index of the step that is now running, or `'done'`. */
    step: number | 'done';
    /** Status word for UI. */
    status: 'started' | 'running' | 'completed' | 'failed';
    /** Optional human-readable message. */
    message?: string;
  };
  error: {
    message: string;
    /** Stable error code (e.g. `UNSUPPORTED_FORMAT`, `NETWORK`, `BAD_RESPONSE`). */
    code?: string;
  };
};

const EVENT_NAME: Record<keyof GeoChatBotEvents, string> = {
  'dataset-loaded': 'geochatbot:dataset-loaded',
  result: 'geochatbot:result',
  plan: 'geochatbot:plan',
  progress: 'geochatbot:progress',
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
  /** Becomes true once the MapView module has been dynamically imported. */
  @state() private _mapModuleLoaded = false;

  /**
   * Operating mode. In `'headless'`, the widget does NOT render the map /
   * tables / drop zone — it only emits typed CustomEvents so a host page
   * can wire the agent's output into its own UI. Reflects to the `mode`
   * attribute so it is settable from HTML markup.
   */
  @property({ reflect: true })
  mode: GeoChatBotMode = 'full';

  /** Active LLM provider, set via {@link setProvider}. Survives {@link clear}. */
  private provider: ChatProvider | undefined = undefined;

  /**
   * Monotonic ingest generation. Bumped by {@link clear}; an in-flight
   * ingest checks this before publishing results so a clear() mid-load
   * does not produce a ghost result after the reset.
   */
  private generation = 0;

  /** Counter for stub plan ids; reset by {@link clear}. */
  private planCounter = 0;

  /* -------------------------------------------------------------------- */
  /* Phase 4 planner state                                                */
  /* -------------------------------------------------------------------- */
  private _planner?: Planner;
  private _llmCall?: (input: PlannerLLMInput) => Promise<Record<string, unknown>>;
  private _pendingPlan?: { id: string; plan: Plan };
  private _datasets: PlannerDatasetProfile[] = [];
  private _apiKey?: string;
  private _model = 'claude-sonnet-4-6';

  render() {
    // In headless mode the widget renders nothing — the host owns the UI
    // and listens for typed events. We still render an invisible host so
    // CSS-targeted host queries do not break.
    if (this.mode === 'headless') {
      return html``;
    }
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

      ${this._mapModuleLoaded && this.geometryLayers().length
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
    input:
      | File
      | { name: string; bytes: Uint8Array | ArrayBuffer }
      | PlannerDatasetProfile,
  ): Promise<void> {
    // Phase 4: a DatasetProfile object (has kind + columns + rows fields and no bytes)
    // is a planner-only profile — do NOT ingest binary.
    if (
      input &&
      typeof input === 'object' &&
      !('bytes' in input) &&
      'kind' in input &&
      'columns' in input &&
      'rows' in input
    ) {
      this._datasets.push(input as PlannerDatasetProfile);
      return;
    }
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
    // Phase 4: stash key+model for the Planner. ChatProvider has optional apiKey/model.
    if ((provider as any).apiKey) this._apiKey = (provider as any).apiKey as string;
    if ((provider as any).model) this._model = (provider as any).model as string;
    // Reset planner so the next ask() rebuilds with the new key.
    delete this._planner;
  }

  /** Test-only: substitute the LLM call for deterministic tests. */
  __setLlmCall(fn: (input: PlannerLLMInput) => Promise<Record<string, unknown>>): void {
    this._llmCall = fn;
    delete this._planner; // force rebuild with stub on next ask()
  }

  /** Currently active provider, if any. Exposed for tests / introspection. */
  getProvider(): ChatProvider | undefined {
    return this.provider;
  }

  /**
   * Switch between full UI and headless (events-only) rendering. Equivalent
   * to setting the `mode` attribute / property; provided as a method so
   * imperative consumers can toggle without touching attributes.
   */
  setMode(mode: GeoChatBotMode): void {
    this.mode = mode;
  }

  /**
   * Phase 4: Ask the agent a question. Builds (or reuses) a Planner, calls
   * the LLM, validates the returned Plan, and dispatches a `plan` event.
   * The plan is held pending until {@link approvePlan} or {@link rejectPlan}.
   */
  async ask(question: string): Promise<void> {
    if (!this._apiKey) {
      this._emit('error', { code: 'NO_KEY', message: 'No provider configured' });
      return;
    }
    if (!this._planner) {
      this._planner = new Planner({
        apiKey: this._apiKey,
        model: this._model,
        dangerouslyAllowBrowser: true,
        ...(this._llmCall ? { llmCall: this._llmCall } : {}),
      });
    }
    try {
      const plan = await this._planner.plan({ question, datasets: this._datasets });
      const id = `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      this._pendingPlan = { id, plan };
      this._emit('plan', { planId: id, plan, datasets: this._datasets });
      this._renderPlanIfFull();
    } catch (err) {
      this._emit('error', {
        code: (err as any)?.name ?? 'UNKNOWN',
        message: (err as Error)?.message ?? 'plan failed',
      });
    }
  }

  approvePlan(id?: string): void {
    if (!this._pendingPlan) return;
    if (id !== undefined && id !== this._pendingPlan.id) return;
    const { plan, id: planId } = this._pendingPlan;
    delete this._pendingPlan;
    this._executeStub(planId, plan);
  }

  rejectPlan(opts?: { id?: string; feedback?: string }): void {
    if (!this._pendingPlan) return;
    if (opts?.id !== undefined && opts.id !== this._pendingPlan.id) return;
    const { plan } = this._pendingPlan;
    delete this._pendingPlan;
    this._emit('progress', { planId: '_rejected', status: 'rejected' });
    void this._planner?.plan({
      question: plan.goal,
      datasets: this._datasets,
      feedback: opts?.feedback ?? 'rejected by user',
    }).then((newPlan) => {
      const id = `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      this._pendingPlan = { id, plan: newPlan };
      this._emit('plan', { planId: id, plan: newPlan, datasets: this._datasets });
      this._renderPlanIfFull();
    }).catch((err) => {
      this._emit('error', { code: (err as any)?.name ?? 'UNKNOWN', message: (err as Error)?.message });
    });
  }

  private _executeStub(planId: string, plan: Plan): void {
    // Phase 5 will replace this with a real Comlink Worker. Phase 4 stub
    // emits progress + a final render result.
    for (const step of plan.steps) {
      if (step.tool === 'sql') {
        try {
          validateSql((step.args as any).query);
        } catch (err) {
          this._emit('error', {
            planId,
            stepId: step.id,
            code: 'SQL',
            message: (err as Error).message,
          });
          return;
        }
      }
    }
    for (const step of plan.steps) {
      this._emit('progress', { planId, stepId: step.id, status: 'running' });
      this._emit('progress', { planId, stepId: step.id, status: 'success', durationMs: 0 });
    }
    const last = plan.steps[plan.steps.length - 1]!;
    const kind = last.tool === 'render.map' ? 'layer'
      : last.tool === 'render.chart' ? 'chart'
      : last.tool === 'render.table' ? 'table'
      : 'summary';
    this._emit('result', { planId, stepId: last.id, kind, payload: last.args });
  }

  private _renderPlanIfFull(): void {
    // In Task 16 this is filled in. Headless mode never renders.
    if (this.getAttribute('mode') === 'headless') return;
    // Defer to Task 16 — not yet wired in Task 15.
  }

  private _emit(name: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  /**
   * Export a loaded dataset as GeoJSON, suitable for pushing into a host
   * map. Phase 2 stub: returns a `FeatureCollection` skeleton with no
   * features, plus a `meta.warning` field. Phase 5 will populate features
   * from the Arrow table via DuckDB-WASM.
   *
   * Returns `undefined` for unknown table names so callers can branch
   * without try/catch.
   */
  exportLayer(name: string): {
    type: 'FeatureCollection';
    features: ReadonlyArray<unknown>;
    meta: { name: string; warning?: string };
  } | undefined {
    const result = this.loaded.find((r) => r.name === name);
    if (!result) return undefined;
    return {
      type: 'FeatureCollection',
      features: [],
      meta: {
        name,
        warning:
          'Phase 2 stub: features are not yet materialized. Wired up in Phase 5.',
      },
    };
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
   * remove the active provider or change the operating mode.
   */
  clear(): void {
    this.generation++;
    this.planCounter = 0;
    this.loaded = [];
    this.profiles = {};
    this.error = null;
    this.dragOver = false;
    this.busy = false;
  }

  /**
   * Internal: dispatch a typed CustomEvent. Centralized so we never leak
   * raw error / detail objects, and the event-name → detail mapping
   * stays in one place.
   */
  private dispatch<K extends keyof GeoChatBotEvents>(
    event: K,
    detail: GeoChatBotEvents[K],
  ): void {
    this.dispatchEvent(
      new CustomEvent<GeoChatBotEvents[K]>(EVENT_NAME[event], {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
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
    // Build a Set of geometry-bearing column names so the lonlat case
    // (which has TWO columns) highlights both correctly. The previous
    // implementation joined them with a comma, which never matched.
    const geomCols = new Set<string>();
    if (result.geometry) {
      if (result.geometry.kind === 'lonlat') {
        geomCols.add(result.geometry.lonColumn);
        geomCols.add(result.geometry.latColumn);
      } else {
        geomCols.add(result.geometry.column);
      }
    }
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
                <td class=${geomCols.has(c.name) ? 'geom' : ''}>${c.name}</td>
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
    const gen = this.generation;
    this.busy = true;
    this.error = null;
    try {
      const result = await loadFile(input);
      if (gen !== this.generation) return; // clear() ran while loading — drop result
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

      if (gen !== this.generation) return; // clear() ran during engine init

      // Lazy-load the MapView module the first time we see geometry. This
      // keeps MapLibre GL + deck.gl out of the initial bundle (PLAN §3).
      if (result.geometry && !this._mapModuleLoaded) {
        await import('./ui/MapView.js');
        if (gen !== this.generation) return;
        this._mapModuleLoaded = true;
      }

      this.loaded = [...this.loaded, result];

      this.dispatch('dataset-loaded', {
        name: result.name,
        source: result.source,
        profile,
        engineRegistered,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code: unknown }).code)
          : undefined;
      this.error = message;
      // Important: never include `cause: err` — provider/network errors can
      // carry the request URL / Authorization header in their message, and
      // dispatching the raw Error object would surface that to any DOM
      // listener (including dev-tool hooks). Stick to {message, code?}.
      const errorDetail: GeoChatBotEvents['error'] = code
        ? { message, code }
        : { message };
      this.dispatch('error', errorDetail);
    } finally {
      // Only release the busy lock if we still own the current generation.
      // If clear() ran while we were loading, a re-drop may already be
      // in flight and we mustn't stomp its busy state.
      if (gen === this.generation) this.busy = false;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'geo-chatbot': GeoChatBotElement;
  }
}
