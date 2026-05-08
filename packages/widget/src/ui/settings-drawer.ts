import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

/**
 * <gcb-settings-drawer>
 *
 * Self-contained Lit component for the GeoChatBot settings panel:
 *   - provider dropdown (Anthropic only for v1; others labelled "soon")
 *   - model dropdown (a small allowlist; matches the planner's expectations)
 *   - API key input (type="password", masked display)
 *   - "Allow direct browser calls" opt-in (mirrors the agent/llm.ts guard)
 *
 * Stateless re: storage — persistence lives in the host <geo-chatbot>.
 * On Save, dispatches a typed `gcb:settings` CustomEvent. On Cancel /
 * close, dispatches `gcb:settings-close`. Keeps the host element thin.
 */

const MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (recommended)' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (cheaper)' },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7 (heaviest)' },
];

export interface SettingsValue {
  provider: 'anthropic';
  model: string;
  apiKey: string;
  dangerouslyAllowBrowser: boolean;
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
      max-width: 460px;
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

  /** Pre-fill the form with these values (e.g. restored from localStorage). */
  @property({ attribute: false }) value: SettingsValue = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    apiKey: '',
    dangerouslyAllowBrowser: false,
  };

  @state() private _draft: SettingsValue = this.value;

  override connectedCallback(): void {
    super.connectedCallback();
    this._draft = { ...this.value };
  }

  override willUpdate(changed: Map<string, unknown>): void {
    // Use willUpdate (pre-render) rather than updated (post-render) so a
    // re-seeded draft does NOT trigger a second render cycle. Lit warns
    // about state writes from updated() because it indicates avoidable
    // double-render work; willUpdate is the documented escape hatch.
    if (changed.has('value')) {
      this._draft = { ...this.value };
    }
  }

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

  private _onSave = () => {
    // Trim the key — pasted keys often arrive with surrounding whitespace.
    const detail: SettingsValue = { ...this._draft, apiKey: this._draft.apiKey.trim() };
    this.dispatchEvent(new CustomEvent<SettingsValue>('gcb:settings', { detail }));
  };

  private _onClose = () => {
    this.dispatchEvent(new CustomEvent('gcb:settings-close'));
  };

  private _onScrimClick = (e: MouseEvent) => {
    // Only close on backdrop click, never on panel click bubbled up.
    if (e.target === e.currentTarget) this._onClose();
  };

  override render() {
    const canSave = this._draft.apiKey.trim().length > 0;
    const masked = this._draft.apiKey
      ? this._draft.apiKey.length > 8
        ? `${this._draft.apiKey.slice(0, 4)}…${this._draft.apiKey.slice(-4)}`
        : '•'.repeat(this._draft.apiKey.length)
      : '';
    return html`
      <div class="scrim" @click=${this._onScrimClick} role="dialog" aria-modal="true" aria-label="GeoChatBot settings">
        <div class="panel">
          <h3>Connect a model</h3>
          <p class="note">
            GeoChatBot calls the LLM directly from your browser. Your API key
            is stored in this browser's <code>localStorage</code> and sent only
            to the provider you choose.
          </p>

          <label class="row">
            <span class="label-text">Provider</span>
            <select disabled aria-label="Provider">
              <option value="anthropic" selected>Anthropic</option>
              <option disabled>OpenAI · soon</option>
              <option disabled>Gemini · soon</option>
            </select>
          </label>

          <label class="row">
            <span class="label-text">Model</span>
            <select aria-label="Model" .value=${this._draft.model} @change=${this._onModel}>
              ${MODELS.map((m) => html`
                <option value=${m.id} ?selected=${m.id === this._draft.model}>${m.label}</option>
              `)}
            </select>
          </label>

          <label class="row">
            <span class="label-text">API key</span>
            <input
              type="password"
              autocomplete="off"
              spellcheck="false"
              placeholder="sk-ant-…"
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
            <span>I acknowledge that calling Anthropic from the browser exposes my API key to scripts on this page (<a href="https://docs.anthropic.com/en/api/getting-started#making-requests-from-the-browser" target="_blank" rel="noopener">why</a>).</span>
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
}

declare global {
  interface HTMLElementTagNameMap {
    'gcb-settings-drawer': GcbSettingsDrawer;
  }
}
