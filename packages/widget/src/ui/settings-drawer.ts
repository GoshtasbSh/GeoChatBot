import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  PROVIDER_CATALOGUE,
  DEFAULT_PROVIDER_ID,
  defaultModelFor,
  getProviderInfo,
  type ProviderId,
} from '../agent/forced-tool/index.js';

/**
 * <gcb-settings-drawer>
 *
 * Multi-provider settings panel:
 *   - Provider dropdown (Groq default — free tier; Gemini also free; Anthropic + OpenAI paid)
 *   - Model dropdown (auto-populated from the selected provider's catalogue)
 *   - API key input (type="password", masked display)
 *   - Per-provider "get a key here" link (signupUrl)
 *   - "Allow direct browser calls" opt-in (mirrors agent/forced-tool/* guards)
 *
 * Stateless re: storage — persistence lives in the host <geo-chatbot>.
 * On Save, dispatches a typed `gcb:settings` CustomEvent. On Cancel /
 * close, dispatches `gcb:settings-close`.
 */

export interface SettingsValue {
  provider: ProviderId;
  model: string;
  apiKey: string;
  dangerouslyAllowBrowser: boolean;
  /** Multi-turn ReAct loop with inspection tools. Default off. */
  agenticMode?: 'single-shot' | 'agentic';
  /** RAG retrieval over corpus + examples + memory. Default 'auto'. */
  retrievalMode?: 'auto' | 'on' | 'off';
}

@customElement('gcb-settings-drawer')
export class GcbSettingsDrawer extends LitElement {
  static override styles = css`
    :host {
      display: block;
      font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
      color: var(--gcb-fg, #1a1a1a);
    }
    .scrim {
      position: fixed;
      inset: 0;
      background: rgba(15, 18, 28, 0.45);
      backdrop-filter: blur(2px);
      z-index: 1000;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 8vh 16px 16px;
      animation: fade-in 160ms ease-out;
    }
    @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
    .panel {
      background: var(--gcb-bg, #fff);
      color: var(--gcb-fg, #1a1a1a);
      border: 1px solid var(--gcb-border, #e3e3e3);
      border-radius: 12px;
      padding: 18px 20px;
      width: 100%;
      max-width: 480px;
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.18);
      animation: pop-in 200ms cubic-bezier(.34, 1.56, .64, 1);
    }
    @keyframes pop-in { from { transform: translateY(-6px) scale(.985); } to { transform: none; } }
    h3 { margin: 0 0 4px; font-size: 16px; }
    p.note {
      margin: 0 0 14px;
      font-size: 12px;
      color: var(--gcb-muted-fg, #555);
      line-height: 1.45;
    }
    label.row {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin: 12px 0;
      font-size: 12px;
      color: var(--gcb-muted-fg, #555);
    }
    label.row > span.label-text { font-weight: 500; }
    select, input[type='password'] {
      font: inherit;
      padding: 8px 10px;
      border: 1px solid var(--gcb-border, #d0d0d0);
      border-radius: 6px;
      background: var(--gcb-bg, #fff);
      color: var(--gcb-fg, #1a1a1a);
      width: 100%;
      box-sizing: border-box;
    }
    select:focus-visible, input:focus-visible {
      outline: 2px solid var(--gcb-accent, #4338ca);
      outline-offset: -1px;
    }
    .free-badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 999px;
      background: var(--gcb-geom-fg, #047857);
      color: #fff;
      margin-left: 6px;
      vertical-align: middle;
    }
    .signup-hint {
      font-size: 11px;
      color: var(--gcb-muted-fg, #555);
      margin: -4px 0 0;
    }
    .signup-hint a {
      color: var(--gcb-accent, #4338ca);
      text-decoration: underline;
    }
    .toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 12px 0;
      font-size: 12px;
      color: var(--gcb-muted-fg, #555);
    }
    .toggle input[type='checkbox'] { margin: 0; transform: translateY(1px); }
    .privacy {
      font-size: 11px;
      background: var(--gcb-accent-soft-bg, #f5f3ff);
      color: var(--gcb-fg, #1a1a1a);
      border-left: 3px solid var(--gcb-accent, #4338ca);
      padding: 8px 10px;
      border-radius: 4px;
      line-height: 1.5;
      margin: 14px 0 4px;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 16px;
    }
    button {
      font: inherit;
      padding: 8px 14px;
      border-radius: 6px;
      border: 1px solid var(--gcb-border, #d0d0d0);
      background: var(--gcb-bg, #fff);
      color: var(--gcb-fg, #1a1a1a);
      cursor: pointer;
      transition: background 120ms ease, transform 120ms ease;
    }
    button:hover:not(:disabled) { background: var(--gcb-accent-soft-bg, #f5f3ff); }
    button:active:not(:disabled) { transform: translateY(1px); }
    button.primary {
      background: var(--gcb-accent, #4338ca);
      border-color: var(--gcb-accent, #4338ca);
      color: #fff;
    }
    button.primary:hover:not(:disabled) { filter: brightness(1.05); background: var(--gcb-accent, #4338ca); }
    button:disabled { opacity: .5; cursor: not-allowed; }
    .key-mask {
      display: block;
      font-family: ui-monospace, monospace;
      font-size: 11px;
      color: var(--gcb-muted-fg, #555);
      margin-top: 4px;
    }
  `;

  /** Pre-fill the form (e.g. restored from localStorage). */
  @property({ attribute: false }) value: SettingsValue = {
    provider: DEFAULT_PROVIDER_ID,
    model: defaultModelFor(DEFAULT_PROVIDER_ID),
    apiKey: '',
    dangerouslyAllowBrowser: false,
    agenticMode: 'single-shot',
    retrievalMode: 'auto',
  };

  @state() private _draft: SettingsValue = this.value;

  override connectedCallback(): void {
    super.connectedCallback();
    this._draft = { ...this.value };
  }

  override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('value')) {
      this._draft = { ...this.value };
    }
  }

  private _onProvider = (e: Event) => {
    const target = e.target as HTMLSelectElement;
    const provider = target.value as ProviderId;
    // Reset model to the new provider's default — the previous model id
    // is almost certainly wrong for the new provider's API.
    this._draft = {
      ...this._draft,
      provider,
      model: defaultModelFor(provider),
    };
  };

  private _onModel = (e: Event) => {
    const target = e.target as HTMLSelectElement;
    this._draft = { ...this._draft, model: target.value };
  };

  private _onKey = (e: Event) => {
    const target = e.target as HTMLInputElement;
    this._draft = { ...this._draft, apiKey: target.value };
  };

  private _onDangerous = (e: Event) => {
    const target = e.target as HTMLInputElement;
    this._draft = { ...this._draft, dangerouslyAllowBrowser: target.checked };
  };

  private _onAgentic = (e: Event) => {
    const checked = (e.target as HTMLInputElement).checked;
    this._draft = { ...this._draft, agenticMode: checked ? 'agentic' : 'single-shot' };
  };

  private _onRetrieval = (e: Event) => {
    const checked = (e.target as HTMLInputElement).checked;
    this._draft = { ...this._draft, retrievalMode: checked ? 'on' : 'off' };
  };

  private _onSave = () => {
    const detail: SettingsValue = { ...this._draft, apiKey: this._draft.apiKey.trim() };
    this.dispatchEvent(new CustomEvent<SettingsValue>('gcb:settings', { detail }));
  };

  private _onClose = () => {
    this.dispatchEvent(new CustomEvent('gcb:settings-close'));
  };

  private _onScrimClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget) this._onClose();
  };

  override render() {
    const canSave = this._draft.apiKey.trim().length > 0;
    const masked = this._draft.apiKey
      ? this._draft.apiKey.length > 8
        ? `${this._draft.apiKey.slice(0, 4)}…${this._draft.apiKey.slice(-4)}`
        : '•'.repeat(this._draft.apiKey.length)
      : '';
    const providerInfo = getProviderInfo(this._draft.provider);
    return html`
      <div class="scrim" @click=${this._onScrimClick} role="dialog" aria-modal="true" aria-label="GeoChatBot settings">
        <div class="panel">
          <h3>Connect a model</h3>
          <p class="note">
            GeoChatBot calls the LLM directly from your browser. Your API key
            is stored in this browser's <code>localStorage</code> and sent only
            to the provider you choose. Pick Groq or Gemini for a free tier.
          </p>

          <label class="row">
            <span class="label-text">Provider</span>
            <select aria-label="Provider" .value=${this._draft.provider} @change=${this._onProvider}>
              ${PROVIDER_CATALOGUE.map(
                (p) => html`
                  <option value=${p.id} ?selected=${p.id === this._draft.provider}>
                    ${p.label}${p.free ? ' · free' : ''}
                  </option>
                `,
              )}
            </select>
            ${providerInfo.signupUrl
              ? html`<p class="signup-hint">
                  ${providerInfo.free
                    ? html`<span class="free-badge">FREE</span>`
                    : nothing}
                  Get a key:
                  <a href=${providerInfo.signupUrl} target="_blank" rel="noopener">${providerInfo.signupUrl}</a>
                </p>`
              : nothing}
          </label>

          <label class="row">
            <span class="label-text">Model</span>
            <select aria-label="Model" .value=${this._draft.model} @change=${this._onModel}>
              ${providerInfo.models.map(
                (m) => html`
                  <option value=${m.id} ?selected=${m.id === this._draft.model}>${m.label}</option>
                `,
              )}
            </select>
          </label>

          <label class="row">
            <span class="label-text">API key</span>
            <input
              type="password"
              autocomplete="off"
              spellcheck="false"
              placeholder=${this._placeholderFor(this._draft.provider)}
              .value=${this._draft.apiKey}
              @input=${this._onKey}
            />
            ${masked ? html`<span class="key-mask">stored as <b>${masked}</b></span>` : nothing}
          </label>

          <label class="toggle">
            <input
              type="checkbox"
              .checked=${this._draft.dangerouslyAllowBrowser}
              @change=${this._onDangerous}
            />
            <span>I acknowledge that calling ${providerInfo.label} from the browser exposes my API key to scripts on this page.</span>
          </label>

          <label class="toggle">
            <input
              type="checkbox"
              .checked=${this._draft.agenticMode === 'agentic'}
              @change=${this._onAgentic}
            />
            <span>
              <b>Agentic mode</b> — the model runs a multi-turn ReAct loop
              with inspection tools (sample_rows, distinct_values, …) before
              committing to a plan. Slower but much better on unfamiliar
              datasets. Requires Groq or OpenAI.
            </span>
          </label>

          <label class="toggle">
            <input
              type="checkbox"
              .checked=${(this._draft.retrievalMode ?? 'auto') !== 'off'}
              @change=${this._onRetrieval}
            />
            <span>
              <b>RAG retrieval</b> — embed each question and pull the most
              relevant docs + past plans from a local IndexedDB vector
              store. First call downloads a small embedding model (~22 MB).
            </span>
          </label>

          <div class="privacy">
            <b>Files never leave your browser.</b> All ingest + analysis runs
            locally via DuckDB-WASM. The LLM only sees the dataset profile
            (column names + types), not the rows.
          </div>

          <div class="actions">
            <button type="button" @click=${this._onClose}>Cancel</button>
            <button
              type="button"
              class="primary"
              ?disabled=${!canSave || !this._draft.dangerouslyAllowBrowser}
              @click=${this._onSave}
            >Save</button>
          </div>
        </div>
      </div>
    `;
  }

  private _placeholderFor(p: ProviderId): string {
    switch (p) {
      case 'anthropic': return 'sk-ant-…';
      case 'openai': return 'sk-…';
      case 'groq': return 'gsk_…';
      case 'gemini': return 'AIza…';
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gcb-settings-drawer': GcbSettingsDrawer;
  }
}
