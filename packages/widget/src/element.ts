import { LitElement, html, css } from 'lit';
import { customElement, state, property } from 'lit/decorators.js';
import { tableFromJSON } from 'apache-arrow';
import { tokensCSS } from './ui/tokens.js';
import {
  resolveTheme,
  applyTheme,
  subscribeOSTheme,
  type ThemeMode,
} from './state/theme.js';
import { loadFile } from './data/loaders';
import { getEngine } from './data/engine';
import type { DuckDBEngine } from './data/engine/DuckDBEngine.js';
import { profileDataset } from './data/profile';
import type {
  BinaryInput,
  GeometryEncoding,
  LoadResult,
  DatasetProfile,
  SourceFormat,
} from './data/contracts';
import {
  type ChatProvider,
  setProvider as setActiveProvider,
} from './providers/index';
import { Planner, Critic, DEFAULT_PROVIDER_ID, defaultModelFor } from './agent/index.js';
import type {
  Plan,
  DatasetProfile as PlannerDatasetProfile,
  ProviderId,
} from './agent/index.js';
import type { CriticDecision, StepErrorContext } from './agent/executor/index.js';
import type { PlannerLLMInput } from './agent/llm.js';
import { validateSql } from './agent/validate-sql.js';
import { validatePlan, PlanValidationError } from './agent/validate-plan.js';
import {
  Executor,
  type DatasetEntry as ExecDatasetEntry,
  type ExecutorEngine,
  type ResultEvent as ExecResultEvent,
  type ProgressEvent as ExecProgressEvent,
} from './agent/executor/index.js';
import './ui/plan-review.js';
import type { PlanReview } from './ui/plan-review.js';
import './ui/result-canvas.js';
import './ui/settings-drawer.js';
import type { SettingsValue } from './ui/settings-drawer.js';
import './ui/ask-input.js';
import type { AskInputDisabledReason } from './ui/ask-input.js';
// MapView (MapLibre GL + deck.gl) is lazy-loaded on first geometry ingest
// so the initial bundle stays lean (PLAN §3 hard rule: ≤ 100 KB gzipped).

/**
 * Map an ingest-side {@link DatasetProfile} (from data/contracts) into the
 * Planner-side profile shape. Sample rows are not extracted here — the
 * planner gets schema + row count but not raw values, so prompt injection
 * via dataset content cannot piggyback on a regular file drop.
 */
function toPlannerDatasetProfile(
  name: string,
  profile: DatasetProfile,
): PlannerDatasetProfile {
  const kind: 'table' | 'layer' = profile.geometry ? 'layer' : 'table';
  const columns = profile.columns.map((c) => ({
    name: c.name,
    type: c.arrowType,
    nulls: c.nullCount,
  }));
  const planner: PlannerDatasetProfile = {
    name,
    kind,
    rows: profile.rowCount,
    columns,
    sample: [],
  };
  if (profile.geometry) {
    // The ingest profile carries an `encoding` discriminator
    // (`lonlat` | `geojson-string` | `wkb`), not the planner's `kind`
    // (point/line/polygon/multi). We can't reliably infer feature
    // dimensionality from encoding alone, so default to `point` for
    // lonlat (which always represents points) and `multi` otherwise.
    const geomKind: 'point' | 'line' | 'polygon' | 'multi' =
      profile.geometry.encoding === 'lonlat' ? 'point' : 'multi';
    planner.geometry = {
      kind: geomKind,
      column: profile.geometry.column,
      ...(profile.geometry.crsGuess ? { crs: profile.geometry.crsGuess } : {}),
      ...(profile.geometry.bbox ? { bbox: profile.geometry.bbox } : {}),
    };
  }
  return planner;
}

/**
 * Adapter: produce an {@link ExecutorEngine} view over a {@link DuckDBEngine}.
 *
 * `hasSpatial` is exposed as a getter so the executor sees the up-to-date
 * value at call time (the engine flips this from `false` to `true` after
 * `LOAD spatial` succeeds during init). A flat property snapshot taken at
 * adapter construction would freeze the value pre-init.
 */
function toExecutorEngine(eng: DuckDBEngine): ExecutorEngine {
  return {
    query: (sql) => eng.query(sql),
    get hasSpatial() {
      return eng.hasSpatial;
    },
  };
}

/** Stable error code for an arbitrary thrown value, never the raw object. */
function errCode(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err && typeof err.name === 'string') {
    return err.name;
  }
  return 'UNKNOWN';
}

/** Best-effort message extraction; never throws, never leaks Error.cause. */
function errMessage(err: unknown, fallback = 'unknown error'): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return fallback;
}

/** Operating modes — see {@link GeoChatBotElement.setMode}. */
export type GeoChatBotMode = 'full' | 'headless';

/**
 * Typed event map dispatched by {@link GeoChatBotElement}.
 *
 * Every event is dispatched twice on the host: once with the unprefixed
 * key (e.g. `plan`) and once with the namespaced form
 * `geochatbot:<key>`. Hosts may listen on either; the typed `on()` helper
 * uses the namespaced form.
 *
 * - `dataset-loaded` — fires when ingest completes for a file/blob.
 * - `plan`           — Planner produced a Plan; awaiting approve/reject.
 * - `progress`       — per-step status during plan execution. `'rejected'`
 *                      is emitted at plan-level when the user rejects.
 * - `result`         — render.* step produced a payload (one per render step).
 * - `error`          — any ingest, planner, validator, or executor failure.
 *                      We never include raw Error objects; only `message`
 *                      and `code` strings (prevents leaking request URLs /
 *                      Authorization headers via Error.cause).
 */
export type GeoChatBotEvents = {
  'dataset-loaded': {
    name: string;
    source: SourceFormat;
    profile: DatasetProfile;
    engineRegistered: boolean;
  };
  plan: {
    planId: string;
    plan: Plan;
    datasets: ReadonlyArray<PlannerDatasetProfile>;
  };
  progress: {
    planId: string;
    /** Step id from the plan, or undefined for plan-level beats (e.g. `'rejected'`). */
    stepId?: string;
    status: 'running' | 'success' | 'fail' | 'rejected';
    durationMs?: number;
    error?: string;
  };
  result: ExecResultEvent;
  error: {
    message: string;
    code?: string;
    planId?: string;
    stepId?: string;
  };
  critic: {
    planId: string;
    stepId: string;
    /** 1-based attempt number (1 = first try; 2 = first retry; …). */
    attempt: number;
    /** Total budget = maxRetries + 1. */
    maxAttempts: number;
    /** What the critic decided. */
    decision: 'patch' | 'retry' | 'abort';
    /** The original error message (already truncated for the prompt). */
    errorMessage: string;
    /** Args before substitution — what the runner actually saw. */
    beforeArgs: Record<string, unknown>;
    /** Patched args, only when decision==='patch'. */
    afterArgs?: Record<string, unknown>;
  };
};

const EVENT_NAME: Record<keyof GeoChatBotEvents, string> = {
  'dataset-loaded': 'geochatbot:dataset-loaded',
  result: 'geochatbot:result',
  plan: 'geochatbot:plan',
  progress: 'geochatbot:progress',
  error: 'geochatbot:error',
  critic: 'geochatbot:critic',
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
  static styles = [
    tokensCSS,
    css`
      /* The legacy color tokens map onto the new ones so any host page
         that already overrides --gcb-bg / --gcb-fg / etc. still works. */
      :host {
        --gcb-fg: var(--gcb-ink);
        --gcb-muted-fg: var(--gcb-ink-muted);
        --gcb-border: var(--gcb-line);
        --gcb-table-bg: var(--gcb-bg-3);
        --gcb-error-bg: color-mix(in srgb, var(--gcb-accent) 14%, transparent);
        --gcb-error-fg: var(--gcb-accent);
        --gcb-accent-soft-bg: var(--gcb-accent-soft);
        --gcb-accent-badge-bg: var(--gcb-accent-soft);
        --gcb-drop-border: var(--gcb-line);
        --gcb-geom-fg: var(--gcb-accent);
        --gcb-radius: var(--gcb-radius-lg);
        --gcb-shadow: var(--gcb-shadow-1);
        --gcb-font: var(--gcb-font-sans);
        --gcb-map-height: 360px;
        --gcb-max-width: 880px;

        display: block;
        font-family: var(--gcb-font);
        color: var(--gcb-ink);
        background: var(--gcb-bg);
        border: 1px solid var(--gcb-line);
        border-radius: var(--gcb-radius);
        box-shadow: var(--gcb-shadow);
        padding: 16px;
        max-width: var(--gcb-max-width);
      }
      header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
      header h2 { margin: 0; font-size: 16px; font-weight: 600; flex: 1; }
      .status-chip {
        display: inline-flex; align-items: center; gap: 6px;
        font-size: 11px; padding: 3px 8px 3px 6px; border-radius: 999px;
        background: var(--gcb-accent-soft); color: var(--gcb-accent);
        border: 1px solid var(--gcb-line);
      }
      .status-chip.muted { background: transparent; color: var(--gcb-ink-muted); border-color: var(--gcb-line); }
      .status-chip .dot { width: 6px; height: 6px; border-radius: 999px; background: var(--gcb-accent); }
      .status-chip .dot-muted { background: var(--gcb-ink-muted); box-shadow: none; }
      .icon-btn {
        font: inherit; font-size: 16px; line-height: 1;
        padding: 4px 8px; border-radius: var(--gcb-radius-sm);
        border: 1px solid var(--gcb-line);
        background: var(--gcb-bg-2); color: var(--gcb-ink-muted);
        cursor: pointer; transition: background 120ms ease;
      }
      .icon-btn:hover { background: var(--gcb-accent-soft); color: var(--gcb-accent); }
      .drop {
        border: 2px dashed var(--gcb-line); border-radius: var(--gcb-radius);
        padding: 28px; text-align: center; cursor: pointer;
        transition: border-color .15s, background .15s;
      }
      .drop.over { border-color: var(--gcb-accent); background: var(--gcb-accent-soft); }
      .drop p { margin: 0; color: var(--gcb-ink-muted); font-size: 14px; }
      .hint { font-size: 12px; color: var(--gcb-ink-muted); margin-top: 4px; opacity: 0.8; }
      .tables { margin-top: 16px; display: flex; flex-direction: column; gap: 12px; }
      .table-card {
        border: 1px solid var(--gcb-line); border-radius: var(--gcb-radius-sm);
        padding: 12px; background: var(--gcb-bg-3);
      }
      .table-card h3 { margin: 0 0 4px; font-size: 14px; font-weight: 600; }
      .table-card .summary { font-size: 12px; color: var(--gcb-ink-muted); margin-bottom: 8px; }
      table { border-collapse: collapse; font-size: 12px; width: 100%; }
      th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--gcb-line); }
      th { color: var(--gcb-ink-muted); font-weight: 500; }
      .err {
        margin-top: 12px; padding: 10px; border-radius: var(--gcb-radius-sm);
        background: color-mix(in srgb, #ef4444 14%, transparent);
        color: #b91c1c; font-size: 13px;
      }
      .geom { color: var(--gcb-accent); font-weight: 500; }
      gcb-map { margin-top: 12px; }
    `,
  ];

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

  /** Theme mode. `auto` follows OS, otherwise the explicit setting wins.
   *  Reflects to the `theme` attribute so the token sheet's
   *  `:host([theme="dark"])` selector can react. */
  @property({ reflect: true })
  theme: ThemeMode = 'auto';

  /**
   * Explicit acknowledgement that the host accepts the API-key exposure
   * inherent in calling Anthropic directly from the browser. Defaults to
   * `false`, in which case `ask()` emits an `error` event instead of
   * issuing the LLM call. Production deployments should keep this `false`
   * and proxy through a server-side endpoint that injects the key.
   *
   * Settable from HTML as `<geo-chatbot dangerously-allow-browser>`.
   */
  @property({ type: Boolean, attribute: 'dangerously-allow-browser', reflect: true })
  dangerouslyAllowBrowser = false;

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
  /**
   * Active LLM provider id. Defaults to Groq (free tier). Restored from
   * localStorage on connect; updated by the settings drawer on Save.
   */
  private _llmProvider: ProviderId = DEFAULT_PROVIDER_ID;
  private _model = defaultModelFor(DEFAULT_PROVIDER_ID);

  /* -------------------------------------------------------------------- */
  /* Phase 5 executor state                                               */
  /* -------------------------------------------------------------------- */
  /** DuckDB view names registered per logical dataset name. */
  private _execDatasets: ExecDatasetEntry[] = [];
  /** Test-only override; otherwise the executor uses the main-thread DuckDB singleton. */
  private _executorEngine?: ExecutorEngine;

  /* -------------------------------------------------------------------- */
  /* Phase 6 critic state                                                 */
  /* -------------------------------------------------------------------- */
  private _criticOverride?: {
    diagnose: (ctx: StepErrorContext, signal?: AbortSignal) => Promise<CriticDecision>;
  };
  /**
   * Per-execution AbortController. Signal is passed to every Critic LLM
   * call so {@link clear} can cancel in-flight Anthropic round-trips
   * instead of leaving them dangling (and burning tokens) when the user
   * walks away or starts a new ask().
   */
  private _execAbort?: AbortController;

  /** Test-only: substitute the critic for deterministic tests. */
  __setCritic(c: {
    diagnose: (ctx: StepErrorContext, signal?: AbortSignal) => Promise<CriticDecision>;
  }): void {
    this._criticOverride = c;
  }

  /* -------------------------------------------------------------------- */
  /* Settings + chat UI state                                             */
  /* -------------------------------------------------------------------- */
  /** Whether the settings drawer is open. */
  @state() private _settingsOpen = false;
  /** True while a plan is being produced or executed; disables the Ask button. */
  @state() private _agentBusy = false;
  /** Mirrors the persisted key for the masked header chip; never the raw bytes. */
  @state() private _maskedKey: string | null = null;

  /* -------------------------------------------------------------------- */
  /* Persistence                                                          */
  /* -------------------------------------------------------------------- */
  /**
   * localStorage key namespace. Values stored:
   *   geochatbot:provider                — provider id ('groq' | 'gemini' | 'anthropic' | 'openai')
   *   geochatbot:apiKey                  — raw API key for the active provider
   *   geochatbot:model                   — selected model id (provider-specific)
   *   geochatbot:dangerouslyAllowBrowser — '1' or '0' opt-in flag
   *
   * Stored only if the user hits Save in the drawer. Never written from
   * setProvider() so programmatic callers don't accidentally persist a
   * key. Reads silently no-op if localStorage is unavailable (private
   * browsing, hardened CSP) — the widget falls back to in-memory only.
   */
  private static readonly _STORAGE_KEYS = {
    provider: 'geochatbot:provider',
    apiKey: 'geochatbot:apiKey',
    model: 'geochatbot:model',
    dangerouslyAllowBrowser: 'geochatbot:dangerouslyAllowBrowser',
  } as const;

  /** Provider ids the persistence layer knows about. Anything else is ignored. */
  private static readonly _KNOWN_PROVIDERS: ReadonlySet<ProviderId> = new Set([
    'anthropic',
    'groq',
    'openai',
    'gemini',
  ]);

  override connectedCallback(): void {
    super.connectedCallback();
    this._restoreSettings();
    applyTheme(this, this.theme);
    this._unsubscribeTheme = subscribeOSTheme(() => this.requestUpdate(), null);
  }

  /** Read persisted settings on connect; silently no-op if storage is unavailable. */
  private _restoreSettings(): void {
    try {
      const k = GeoChatBotElement._STORAGE_KEYS;
      const persistedProvider = localStorage.getItem(k.provider);
      if (
        persistedProvider &&
        GeoChatBotElement._KNOWN_PROVIDERS.has(persistedProvider as ProviderId)
      ) {
        this._llmProvider = persistedProvider as ProviderId;
      }
      const apiKey = localStorage.getItem(k.apiKey);
      const model = localStorage.getItem(k.model);
      const dangerous = localStorage.getItem(k.dangerouslyAllowBrowser) === '1';
      if (apiKey) {
        this._apiKey = apiKey;
        this._maskedKey = this._maskKey(apiKey);
      }
      if (model) this._model = model;
      if (dangerous) this.dangerouslyAllowBrowser = true;
    } catch {
      // localStorage unavailable — remain in-memory only.
    }
  }

  /** Compact masked form of a key for the header chip. Never reveals the middle. */
  private _maskKey(key: string): string {
    if (!key) return '';
    if (key.length <= 8) return '•'.repeat(key.length);
    return `${key.slice(0, 4)}…${key.slice(-4)}`;
  }

  /** Short, header-friendly label for the active provider. */
  private _providerLabel(): string {
    switch (this._llmProvider) {
      case 'anthropic': return 'Anthropic';
      case 'openai': return 'OpenAI';
      case 'groq': return 'Groq';
      case 'gemini': return 'Gemini';
    }
  }

  private _onSaveSettings = (e: Event) => {
    const detail = (e as CustomEvent<SettingsValue>).detail;
    this._llmProvider = detail.provider;
    this._apiKey = detail.apiKey;
    this._model = detail.model;
    this.dangerouslyAllowBrowser = detail.dangerouslyAllowBrowser;
    this._maskedKey = this._maskKey(detail.apiKey);
    // Force planner rebuild so the next ask() picks up the new
    // provider/model/key tuple.
    delete this._planner;
    try {
      const k = GeoChatBotElement._STORAGE_KEYS;
      localStorage.setItem(k.provider, detail.provider);
      localStorage.setItem(k.apiKey, detail.apiKey);
      localStorage.setItem(k.model, detail.model);
      localStorage.setItem(k.dangerouslyAllowBrowser, detail.dangerouslyAllowBrowser ? '1' : '0');
    } catch {
      // Persistence is best-effort; in-memory state above is authoritative.
    }
    this._settingsOpen = false;
  };

  private _openSettings = () => { this._settingsOpen = true; };
  private _closeSettings = () => { this._settingsOpen = false; };

  /**
   * Compute why the chat input is disabled, or null when ready. The
   * <gcb-ask-input> renders an empty-state CTA based on this so the
   * user never wonders why the box is greyed out.
   */
  private _askDisabledReason(): AskInputDisabledReason {
    if (this.loaded.length === 0) return 'no-data';
    if (!this._apiKey) return 'no-key';
    return null;
  }

  private _exampleQuestions(): string[] {
    if (this.loaded.length === 0) return [];
    const names = this.loaded.map((r) => r.name);
    const first = names[0]!;
    const hasGeom = this.loaded.some((r) => !!r.geometry);
    const out = [
      `How many rows are in ${first}?`,
      `Show a chart of ${first}.`,
    ];
    if (hasGeom) out.push(`Map the ${first} layer.`);
    return out;
  }

  private _onAskFromInput = async (e: Event) => {
    const q = (e as CustomEvent<string>).detail;
    if (!q || this._agentBusy) return;
    this._agentBusy = true;
    try {
      await this.ask(q);
    } finally {
      this._agentBusy = false;
    }
  };

  render() {
    // In headless mode the widget renders nothing — the host owns the UI
    // and listens for typed events. We still render an invisible host so
    // CSS-targeted host queries do not break.
    if (this.mode === 'headless') {
      return html``;
    }
    const disabledReason = this._askDisabledReason();
    return html`
      <header>
        <h2>GeoChatBot</h2>
        ${this._maskedKey
          ? html`<span class="status-chip" title="API key configured">
              <span class="dot"></span>${this._providerLabel()} · ${this._maskedKey}
            </span>`
          : html`<span class="status-chip muted" title="No API key set">
              <span class="dot dot-muted"></span>not connected
            </span>`}
        <button
          class="icon-btn"
          type="button"
          aria-label="Open settings"
          title="Settings"
          @click=${this._openSettings}
        >⚙</button>
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

      <gcb-ask-input
        .disabledReason=${disabledReason}
        .examples=${disabledReason === null ? this._exampleQuestions() : []}
        ?busy=${this._agentBusy}
        @gcb:ask=${this._onAskFromInput}
        @gcb:request-settings=${this._openSettings}
      ></gcb-ask-input>

      ${this._settingsOpen
        ? html`<gcb-settings-drawer
            .value=${{
              provider: this._llmProvider,
              model: this._model,
              apiKey: this._apiKey ?? '',
              dangerouslyAllowBrowser: this.dangerouslyAllowBrowser,
            } as SettingsValue}
            @gcb:settings=${this._onSaveSettings}
            @gcb:settings-close=${this._closeSettings}
          ></gcb-settings-drawer>`
        : null}
    `;
  }

  /* -------------------------------------------------------------------- */
  /* Public API                                                           */
  /* -------------------------------------------------------------------- */

  /**
   * Inline-rows ingest payload for the headless contract (PLAN.md §2):
   *
   *   bot.pushData({ name: 'sales', rows: [...], geometry: {...} })
   *
   * Builds an Apache Arrow table from `rows` and runs the full ingest
   * path (DuckDB registration, profiling, `dataset-loaded` event, and
   * — most importantly — `_execDatasets` binding so subsequent `ask()`
   * calls have a real DuckDB view to query against).
   */
  // public for typedoc + tests; not exported from index.
  // (No JSDoc on the type — kept inline so a single grep finds the contract.)

  /**
   * Ingest data through the same pipeline used by drag-drop / picker.
   *
   * Accepts four shapes:
   *  - {@link File} — browser file
   *  - `{ name, bytes }` — pre-loaded binary
   *  - `{ name, rows, geometry?, source? }` — inline JS rows (headless dashboards)
   *  - {@link PlannerDatasetProfile} — planner-side metadata only (tests, stubs)
   *
   * Always resolves; ingest failures are surfaced via the `error` event
   * and the component's error banner rather than thrown.
   */
  async pushData(
    input:
      | File
      | { name: string; bytes: Uint8Array | ArrayBuffer }
      | {
          name: string;
          rows: ReadonlyArray<Record<string, unknown>>;
          geometry?: GeometryEncoding;
          source?: SourceFormat;
        }
      | PlannerDatasetProfile,
  ): Promise<void> {
    // (1) Inline-rows ingest — must come BEFORE the profile-shape check
    // because both shapes have a `rows` field. The discriminator is
    // Array.isArray(rows): planner profile uses rows: number, this path
    // uses rows: array.
    if (
      input &&
      typeof input === 'object' &&
      !('bytes' in input) &&
      'rows' in (input as object) &&
      Array.isArray((input as { rows: unknown }).rows)
    ) {
      const rowsInput = input as {
        name: string;
        rows: ReadonlyArray<Record<string, unknown>>;
        geometry?: GeometryEncoding;
        source?: SourceFormat;
      };
      await this._ingestRows(rowsInput);
      return;
    }
    // (2) Planner-only profile shape (tests, post-ingest re-pushes).
    if (
      input &&
      typeof input === 'object' &&
      !('bytes' in input) &&
      'kind' in input &&
      'columns' in input &&
      'rows' in input
    ) {
      // Defensive copy + drop the `sample` field. Caller-supplied sample
      // rows are concatenated verbatim into the planner system prompt by
      // `renderDatasetsBlock` and would let a hostile dataset inject text
      // shaped like new tool definitions or instructions ("ignore previous
      // …"). The internal file-drop path already sets sample: [] via
      // toPlannerDatasetProfile; this branch is the remaining ingress and
      // we treat caller `sample` as untrusted.
      const incoming = input as PlannerDatasetProfile;
      this._datasets.push({ ...incoming, sample: [] });
      return;
    }
    // (3) Binary input — File or { bytes }.
    const binary: BinaryInput =
      typeof File !== 'undefined' && input instanceof File
        ? input
        : (input as { name: string; bytes: Uint8Array | ArrayBuffer });
    await this.ingest(binary);
  }

  /**
   * Build an Arrow table from inline JS rows and run it through the full
   * ingest pipeline. Used by the headless `pushData({ rows })` overload
   * so a host page can hand us in-memory data without serialising to a
   * binary format first.
   *
   * Engine registration is best-effort just like the binary path: if the
   * DuckDB-WASM Worker is not available (test envs, hardened CSP), we
   * still publish the dataset to the planner side so `ask()` works
   * against a stubbed engine.
   */
  private async _ingestRows(input: {
    name: string;
    rows: ReadonlyArray<Record<string, unknown>>;
    geometry?: GeometryEncoding;
    source?: SourceFormat;
  }): Promise<void> {
    const gen = this.generation;
    this.busy = true;
    this.error = null;
    try {
      if (!input.rows.length) {
        throw new Error('pushData({ rows }): rows array is empty');
      }
      const table = tableFromJSON(input.rows as Array<Record<string, unknown>>);
      const result: LoadResult = {
        name: input.name,
        table,
        source: input.source ?? 'csv',
        filename: `${input.name}.json`,
        ...(input.geometry ? { geometry: input.geometry } : {}),
      };
      if (gen !== this.generation) return;

      const profile = profileDataset(result);
      this.profiles = { ...this.profiles, [result.name]: profile };

      let engineRegistered = false;
      try {
        const engine = getEngine();
        await engine.init();
        const reg = await engine.registerArrow(result);
        engineRegistered = true;
        // Critical: bind the DuckDB view to the executor's dataset map
        // so the agent loop can resolve `${dataset}` references. This
        // closes the headless-mode gap where pushData({rows}) used to
        // create only a planner-side stub and the executor would throw
        // "unknown dataset" for any step that touched the data.
        this._execDatasets = [
          ...this._execDatasets.filter((d) => d.name !== result.name),
          {
            name: result.name,
            tableName: reg.tableName,
            ...(reg.geomView ? { geomView: reg.geomView } : {}),
            hasGeometry: !!reg.geomView,
          },
        ];
      } catch (err) {
        // Pass only the error code — never the raw Error object, whose
        // `message` / `cause` may carry the request URL or auth header
        // for any provider/network failure that bubbled into engine init.
        // eslint-disable-next-line no-console
        console.warn(
          '[geochatbot] engine registration failed for inline rows; planner-only mode',
          errCode(err),
        );
      }

      if (gen !== this.generation) return;

      // Mirror to the planner-side dataset map so the LLM sees this dataset.
      const plannerProfile = toPlannerDatasetProfile(result.name, profile);
      this._datasets = [
        ...this._datasets.filter((d) => d.name !== result.name),
        plannerProfile,
      ];

      this.loaded = [...this.loaded, result];
      this.dispatch('dataset-loaded', {
        name: result.name,
        source: result.source,
        profile,
        engineRegistered,
      });
    } catch (err) {
      const message = errMessage(err);
      this.error = message;
      this.dispatch('error', { message, code: errCode(err) });
    } finally {
      if (gen === this.generation) this.busy = false;
    }
  }

  /** Set the active LLM provider used by future agent turns. */
  setProvider(provider: ChatProvider): void {
    this.provider = provider;
    setActiveProvider(provider);
    // Phase 4: stash key+model for the Planner. The base ChatProvider type
    // does not carry these fields, but the concrete Anthropic/Gemini/OpenAI
    // option objects do — read them through a structural narrowing rather
    // than `as any`.
    const opts = provider as { apiKey?: unknown; model?: unknown };
    if (typeof opts.apiKey === 'string' && opts.apiKey) this._apiKey = opts.apiKey;
    if (typeof opts.model === 'string' && opts.model) this._model = opts.model;
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
    if (typeof question !== 'string' || !question.trim()) {
      // Empty / whitespace-only questions otherwise reach Anthropic and
      // get an opaque HTTP 400 response. Surface a clean code so the
      // host UI can show a clear "type something first" message.
      this.dispatch('error', {
        code: 'EMPTY_QUESTION',
        message: 'ask(question) requires a non-empty string',
      });
      return;
    }
    if (!this._apiKey) {
      this.dispatch('error', { code: 'NO_KEY', message: 'No provider configured' });
      return;
    }
    // H4: Refuse to plan over a still-pending plan. Without this guard a
    // second `ask()` silently overwrites `_pendingPlan`, the user loses
    // the ability to approve plan #1, and any progress/result events
    // that did fire become orphaned. Hosts must explicitly resolve the
    // first plan (approve / reject) before calling ask() again.
    if (this._pendingPlan) {
      this.dispatch('error', {
        planId: this._pendingPlan.id,
        code: 'PLAN_PENDING',
        message:
          'A plan is awaiting approval; call approvePlan/rejectPlan before ask() again.',
      });
      return;
    }
    // The browser-direct guard in agent/llm.ts is intentional. The widget
    // honors it by routing the host's explicit opt-in via the
    // `dangerouslyAllowBrowser` property (default false). When the test-only
    // llmCall is installed, the guard does not apply because the call never
    // reaches `callPlannerLLM`.
    if (!this._llmCall && !this.dangerouslyAllowBrowser) {
      this.dispatch('error', {
        code: 'BROWSER_KEY_GUARD',
        message:
          `Direct-from-browser ${this._providerLabel()} calls leak the API key. Set the \`dangerously-allow-browser\` attribute (or .dangerouslyAllowBrowser=true) to acknowledge, or proxy through your own server.`,
      });
      return;
    }
    if (!this._planner) {
      this._planner = new Planner({
        provider: this._llmProvider,
        apiKey: this._apiKey,
        model: this._model,
        dangerouslyAllowBrowser: this.dangerouslyAllowBrowser,
        ...(this._llmCall ? { llmCall: this._llmCall } : {}),
      });
    }
    // Capture the generation BEFORE awaiting the planner. If `clear()`
    // (which bumps generation) runs while the planner LLM call is in
    // flight, the resolved plan belongs to a session that no longer
    // exists — we must not set `_pendingPlan` or mount a plan-review on
    // a cleared widget. Multi-tenant correctness: a stale plan from a
    // previous user/session would otherwise be approvable in the new
    // session.
    const gen = this.generation;
    try {
      const plan = await this._planner.plan({ question, datasets: this._datasets });
      if (gen !== this.generation) return; // clear() ran during the planner call
      const id = `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      this._pendingPlan = { id, plan };
      this.dispatch('plan', { planId: id, plan, datasets: this._datasets });
      this._renderPlanIfFull();
    } catch (err) {
      if (gen !== this.generation) return; // clear() ran; suppress error from stale session
      this.dispatch('error', {
        code: errCode(err),
        message: errMessage(err, 'plan failed'),
      });
    }
  }

  approvePlan(id?: string): void {
    if (!this._pendingPlan) return;
    if (id !== undefined && id !== this._pendingPlan.id) return;
    const { plan, id: planId } = this._pendingPlan;
    delete this._pendingPlan;
    // Capture the execution promise so test code can deterministically
    // await completion. Intentional fire-and-forget at runtime — the
    // host doesn't await approvePlan; events are the public contract.
    this.__lastExecution = this._execute(planId, plan);
    void this.__lastExecution;
  }

  /**
   * Test-only: the promise of the most recent `_execute` invocation, or
   * undefined before any plan has been approved. Lets tests
   * `await el.__lastExecution` instead of busy-polling on event order.
   */
  __lastExecution: Promise<void> | undefined;

  rejectPlan(opts?: { id?: string; feedback?: string }): void {
    if (!this._pendingPlan) return;
    if (opts?.id !== undefined && opts.id !== this._pendingPlan.id) return;
    const { id: planId, plan } = this._pendingPlan;
    delete this._pendingPlan;
    this.dispatch('progress', { planId, status: 'rejected' });
    if (!this._planner) {
      this.dispatch('error', {
        planId,
        code: 'NO_PLANNER',
        message: 'rejectPlan called with no active planner',
      });
      return;
    }
    // Same generation guard as ask(): the rephrase planner call is
    // in-flight when clear() can race in. Without the gen check, the
    // newPlan would land in a cleared widget, mount a plan-review, and
    // the previous-session plan would become approvable.
    const gen = this.generation;
    void this._planner.plan({
      question: plan.goal,
      datasets: this._datasets,
      feedback: opts?.feedback ?? 'rejected by user',
    }).then((newPlan) => {
      if (gen !== this.generation) return; // clear() ran during rephrase
      const id = `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      this._pendingPlan = { id, plan: newPlan };
      this.dispatch('plan', { planId: id, plan: newPlan, datasets: this._datasets });
      this._renderPlanIfFull();
    }).catch((err) => {
      if (gen !== this.generation) return; // clear() ran; drop stale-session error
      this.dispatch('error', { code: errCode(err), message: errMessage(err) });
    });
  }

  /**
   * Phase 5: real executor. Pre-validates every `sql` step at the §4
   * boundary (defense-in-depth — the runner re-validates too), then
   * runs the plan via a main-thread Executor against the existing
   * DuckDB-WASM engine. Worker-via-Comlink is wired in
   * `agent/executor/client.ts` and ships in Phase 5 expansion when
   * the engine is moved off the main thread.
   */
  private async _execute(planId: string, plan: Plan): Promise<void> {
    // Pre-validate every `sql` step at the §4 boundary. This is an
    // early-rejection convenience for fast UI feedback only — the
    // canonical gate is `runners/sql.ts`, which validates every SQL
    // body on each call (including critic-patched steps that re-enter
    // the executor mid-flight in Phase 6).
    for (const step of plan.steps) {
      if (step.tool === 'sql') {
        try {
          validateSql((step.args as { query?: unknown })?.query as string);
        } catch (err) {
          const message = errMessage(err);
          this.dispatch('error', { planId, stepId: step.id, code: 'SQL', message });
          this.dispatch('progress', { planId, stepId: step.id, status: 'fail', error: message });
          return;
        }
      }
    }

    const engine = this._resolveExecutorEngine();
    if (!engine) {
      this.dispatch('error', {
        planId,
        code: 'NO_ENGINE',
        message: 'DuckDB engine unavailable in this environment.',
      });
      return;
    }

    // H1: Clear stale renderer panels before every execution. Without
    // this, run #2 visually inherits run #1's chart/table/map/summary
    // panels for any kind it does not re-emit. The canvas may not
    // exist yet (full mode lazily mounts; headless never mounts) — a
    // null-safe call on the optional `clear` keeps both paths working.
    if (this.mode !== 'headless' && this.shadowRoot) {
      const canvas = this.shadowRoot.querySelector('result-canvas') as
        | (HTMLElement & { clear?: () => void })
        | null;
      canvas?.clear?.();
    }

    const exec = new Executor({ engine, datasets: this._execDatasets });
    const critic = this._buildCritic();
    // Fresh controller per execution. clear() / a new ask() before this
    // run completes will fire abort(); the signal is forwarded to every
    // critic.diagnose() call so an in-flight Anthropic fetch can be torn
    // down promptly instead of running to completion in the background.
    const abort = new AbortController();
    this._execAbort = abort;
    try {
      await exec.execute(plan, planId, {
        onProgress: (e: ExecProgressEvent) => {
          this.dispatch('progress', e);
          if (this.mode !== 'headless') this._pushPlanStatus(e);
        },
        onResult: (e: ExecResultEvent) => {
          this.dispatch('result', e);
          if (this.mode !== 'headless') this._mountResult(e);
        },
        onError: (e) => this.dispatch('error', e),
        ...(critic
          ? {
              onStepError: async (ctx: StepErrorContext) => {
                const decision = await critic.diagnose(ctx, abort.signal);
                const detail: GeoChatBotEvents['critic'] = {
                  planId: ctx.planId,
                  stepId: ctx.step.id,
                  attempt: ctx.retryCount + 1,
                  maxAttempts: ctx.maxRetries + 1,
                  decision: decision.action,
                  errorMessage: ctx.error.message,
                  beforeArgs: ctx.resolvedArgs,
                };
                if (decision.action === 'patch') {
                  detail.afterArgs = decision.patchedStep.args;
                }
                this.dispatch('critic', detail);
                if (this.mode !== 'headless') this._pushCriticAttempt(detail, decision);
                return decision;
              },
            }
          : {}),
      });
    } finally {
      // Only clear our reference if THIS execution still owns the controller.
      // A clear() mid-flight may have already swapped in a new one (or
      // aborted ours). Either way, never clobber a successor's controller.
      if (this._execAbort === abort) delete this._execAbort;
    }
  }

  /** Resolve the engine handle: test override → main-thread DuckDB → null. */
  private _resolveExecutorEngine(): ExecutorEngine | null {
    if (this._executorEngine) return this._executorEngine;
    try {
      return toExecutorEngine(getEngine());
    } catch {
      return null;
    }
  }

  /** Test-only: substitute the executor engine for deterministic tests. */
  __setExecutorEngine(engine: ExecutorEngine): void {
    this._executorEngine = engine;
  }

  /** Mount a result payload into <result-canvas> in full mode. */
  private _mountResult(e: ExecResultEvent): void {
    interface CanvasEl extends HTMLElement {
      setResult(p: { kind: string; [k: string]: unknown }): void;
      clear(): void;
    }
    let canvas = this.shadowRoot!.querySelector('result-canvas') as CanvasEl | null;
    if (!canvas) {
      canvas = document.createElement('result-canvas') as CanvasEl;
      this.shadowRoot!.appendChild(canvas);
    }
    // Strip planId/stepId before handing to the canvas — it only cares
    // about the payload shape.
    const { planId: _p, stepId: _s, ...payload } = e;
    void _p; void _s;
    canvas.setResult(payload as { kind: string; [k: string]: unknown });
  }

  private _buildCritic():
    | { diagnose: (ctx: StepErrorContext, signal?: AbortSignal) => Promise<CriticDecision> }
    | null {
    if (this._criticOverride) return this._criticOverride;
    if (!this._apiKey) return null;
    return new Critic({
      provider: this._llmProvider,
      apiKey: this._apiKey,
      model: this._model,
      datasets: this._datasets,
      dangerouslyAllowBrowser: this.dangerouslyAllowBrowser,
    });
  }

  /** Locate the live <plan-review> in shadow DOM. Typed via the imported class
   *  so future renames or property changes surface as compile errors instead
   *  of being silently absorbed by inline `as never` casts. Returns null
   *  in headless mode (no shadow DOM children) or before the first plan. */
  private _planReview(): PlanReview | null {
    return this.shadowRoot?.querySelector('plan-review') ?? null;
  }

  private _pushPlanStatus(e: ExecProgressEvent): void {
    const pr = this._planReview();
    if (!pr) return;
    if (pr.mode !== 'running') pr.mode = 'running';
    if (e.stepId) {
      const next = new Map(pr.stepStatus);
      // ProgressEvent.status is 'running' | 'success' | 'fail'; <plan-review>
      // treats StepStatus as a wider type that also includes 'pending' | 'retry'.
      // The narrower-into-wider assignment is sound; cast to the wider Map
      // so the assignment compiles without `any`.
      next.set(e.stepId, e.status);
      pr.stepStatus = next as Map<string, import('./ui/plan-review.js').StepStatus>;
      if (e.durationMs !== undefined) {
        const d = new Map(pr.stepDurations);
        d.set(e.stepId, Math.round(e.durationMs));
        pr.stepDurations = d;
      }
      pr.requestUpdate();
    }
  }

  private _pushCriticAttempt(
    detail: GeoChatBotEvents['critic'],
    decision: CriticDecision,
  ): void {
    const pr = this._planReview();
    if (!pr) return;
    const ss = new Map(pr.stepStatus);
    ss.set(detail.stepId, 'retry');
    pr.stepStatus = ss;
    const log = new Map(pr.criticAttempts);
    const arr = log.get(detail.stepId) ?? [];
    log.set(detail.stepId, [...arr, {
      attempt: detail.attempt,
      maxAttempts: detail.maxAttempts,
      decision: detail.decision,
      errorMessage: detail.errorMessage,
    }]);
    pr.criticAttempts = log;
    if (decision.action === 'patch') {
      const patches = new Map(pr.criticPatches);
      patches.set(detail.stepId, decision.patchedStep);
      pr.criticPatches = patches;
    }
    pr.requestUpdate();
  }

  private _renderPlanIfFull(): void {
    // Read the property, not the attribute. `setMode('headless')` writes
    // `this.mode` synchronously; the attribute only mirrors back via
    // Lit's `reflect` _after_ the next update, so calling this method
    // before the element has rendered (or before connection in tests)
    // would otherwise miss the headless guard and append a plan-review
    // into a widget that is supposed to be event-only.
    if (this.mode === 'headless') return;
    if (!this._pendingPlan) return;
    // Always reattach listeners against the current plan id. Re-using the
    // same `<plan-review>` instance with stale closures would let a click
    // on an older render approve a newer plan, or vice-versa.
    const planId = this._pendingPlan.id;
    const oldPr = this.shadowRoot!.querySelector('plan-review');
    if (oldPr) oldPr.remove();
    interface PlanReviewEl extends HTMLElement {
      plan?: Plan;
      mode?: 'plan' | 'running';
    }
    const pr = document.createElement('plan-review') as PlanReviewEl;
    pr.addEventListener('plan:approve', () => this.approvePlan(planId));
    pr.addEventListener('plan:reject', () => this.rejectPlan({ id: planId }));
    pr.addEventListener('step:edit', (ev: Event) => {
      const detail = (ev as CustomEvent<{ stepId: string; args: Record<string, unknown> }>).detail;
      this._handleStepEdit(planId, detail, pr);
    });
    this.shadowRoot!.appendChild(pr);
    pr.plan = this._pendingPlan.plan;
    pr.mode = 'plan';
  }

  /**
   * Apply a step edit from `<plan-review>`. Re-runs the full Plan validator
   * against the proposed mutation; on failure the edit is rejected and an
   * `error` event is dispatched. On success the pending plan is replaced
   * with a freshly-cloned Plan so Lit re-renders cleanly and the original
   * (validated) Plan is not mutated in place.
   */
  private _handleStepEdit(
    planId: string,
    detail: { stepId: string; args: Record<string, unknown> },
    pr: HTMLElement & { plan?: Plan },
  ): void {
    if (!this._pendingPlan || this._pendingPlan.id !== planId) return;
    const current = this._pendingPlan.plan;
    const idx = current.steps.findIndex((s) => s.id === detail.stepId);
    if (idx === -1) return;
    const candidate: Plan = {
      ...current,
      steps: current.steps.map((s, i) => (i === idx ? { ...s, args: detail.args } : s)),
    };
    const datasetNames = this._datasets.map((d) => d.name);
    try {
      const revalidated = validatePlan(candidate, datasetNames);
      this._pendingPlan = { id: planId, plan: revalidated };
      pr.plan = revalidated;
    } catch (err) {
      const code = err instanceof PlanValidationError ? 'EDIT_INVALID' : errCode(err);
      this.dispatch('error', {
        planId,
        stepId: detail.stepId,
        code,
        message: errMessage(err, 'edit failed validation'),
      });
    }
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
   * Reset loaded datasets, profiles, errors, and drag state. Also wipes
   * planner state (pending plans, planner-side dataset profiles, cached
   * Planner instance, and the active API key) so a `clear()` between
   * users / tenants does not leak prior session state into the next
   * `setProvider()` + `ask()` round-trip. The operating mode and the
   * `dangerouslyAllowBrowser` opt-in are preserved.
   */
  clear(): void {
    this.generation++;
    this.planCounter = 0;
    this.loaded = [];
    this.profiles = {};
    this.error = null;
    this.dragOver = false;
    this.busy = false;
    this._execDatasets = [];
    // Phase 4 / 5 / 6 state — must be wiped to avoid cross-session leaks.
    this._datasets = [];
    delete this._pendingPlan;
    delete this._planner;
    delete this._apiKey;
    delete this._criticOverride;
    // Cancel any in-flight critic LLM round-trip. The Critic.diagnose
    // catch path re-throws AbortError, the executor maps it to abort,
    // and the host's onError surfaces the original step error — so a
    // clear() during a retry tears down cleanly without leaking tokens
    // or a dangling fetch.
    this._execAbort?.abort();
    delete this._execAbort;
    this.provider = undefined;
    // UI state: drop the masked key chip, close any open drawer, reset
    // busy. The localStorage values are NOT removed — clear() is a
    // session reset, not a "forget my key" affordance. Users opt out
    // of persistence by reopening Settings and saving an empty key.
    this._settingsOpen = false;
    this._agentBusy = false;
    this._maskedKey = null;
    if (this.shadowRoot) {
      const canvas = this.shadowRoot.querySelector('result-canvas') as
        | (HTMLElement & { clear(): void })
        | null;
      canvas?.clear();
      const planReview = this.shadowRoot.querySelector('plan-review');
      planReview?.remove();
    }
  }

  /**
   * Standard custom-element teardown hook. Removing `<geo-chatbot>` from
   * the DOM (SPA navigation, dashboard panel hide, HMR) must abort any
   * in-flight planner/critic LLM call and bump the generation token so
   * a late-resolving promise cannot fire events on the detached element
   * or mount a stale plan-review. We deliberately do NOT dispose the
   * shared DuckDB engine singleton here — other widget instances on the
   * same page still rely on it. Provider / apiKey survive so that
   * re-attaching the element resumes correctly.
   */
  private _unsubscribeTheme?: () => void;

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.generation++;
    this._execAbort?.abort();
    delete this._execAbort;
    delete this._pendingPlan;
    this._unsubscribeTheme?.();
    delete this._unsubscribeTheme;
  }

  /**
   * Internal: dispatch a typed CustomEvent on both the namespaced
   * (`geochatbot:<key>`) and unprefixed (`<key>`) names. The typed `on()`
   * helper subscribes to the namespaced form; raw `addEventListener` calls
   * commonly target the unprefixed form, so we cover both.
   */
  private dispatch<K extends keyof GeoChatBotEvents>(
    event: K,
    detail: GeoChatBotEvents[K],
  ): void {
    const init: CustomEventInit<GeoChatBotEvents[K]> = {
      detail,
      bubbles: true,
      composed: true,
    };
    this.dispatchEvent(new CustomEvent<GeoChatBotEvents[K]>(EVENT_NAME[event], init));
    this.dispatchEvent(new CustomEvent<GeoChatBotEvents[K]>(event, init));
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
        const reg = await engine.registerArrow(result);
        engineRegistered = true;
        // Phase 5: record the executor-facing entry so the agent loop
        // can resolve `${dataset}` references to DuckDB views.
        this._execDatasets = [
          ...this._execDatasets.filter((d) => d.name !== result.name),
          {
            name: result.name,
            tableName: reg.tableName,
            ...(reg.geomView ? { geomView: reg.geomView } : {}),
            hasGeometry: !!reg.geomView,
          },
        ];
      } catch (err) {
        // Same redaction as the inline-rows path above: log code only,
        // never the raw err — keeps any request URL / auth header out
        // of the DevTools console and any console-intercepting telemetry.
        console.warn(
          '[geochatbot] engine registration failed; continuing in JS-only mode',
          errCode(err),
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

      // Phase 4 sync: every ingested file must also become a planner-side
      // DatasetProfile so the Planner can reference it by name from a user
      // question. Without this, ask() after a drop produces an empty
      // dataset_refs check failure. The mapping is intentionally lossy —
      // sample rows are not extracted here (kept empty) to avoid
      // round-tripping potentially sensitive content through the agent
      // unless the host explicitly opts in via pushData(profile).
      this._datasets = [
        ...this._datasets.filter((d) => d.name !== result.name),
        toPlannerDatasetProfile(result.name, profile),
      ];

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
