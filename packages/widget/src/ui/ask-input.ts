import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

/**
 * <gcb-ask-input>
 *
 * Chat-style entry row: a single-line text input + Ask button, plus an
 * optional row of clickable example-prompt chips. Disabled when the
 * widget has no datasets or no API key.
 *
 * On submit (Enter key OR Ask click), dispatches `gcb:ask` with the
 * trimmed question. Clears its own input afterwards. The host listens
 * and calls element.ask(detail).
 *
 * Empty state surfaces:
 *   - "Drop a file to start." when no datasets.
 *   - "Set your API key to chat." when datasets present but no key.
 * Each empty state's CTA emits `gcb:request-settings` so the host can
 * open the settings drawer.
 */

export type AskInputDisabledReason = "no-data" | "no-key" | null;

@customElement("gcb-ask-input")
export class GcbAskInput extends LitElement {
	static override styles = css`
    :host {
      display: block;
      font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
      color: var(--gcb-fg, #1a1a1a);
    }
    .wrap {
      margin: 16px 0 4px;
    }
    .row {
      display: flex;
      gap: 8px;
      background: var(--gcb-bg, #fff);
      border: 1px solid var(--gcb-border, #d0d0d0);
      border-radius: 10px;
      padding: 6px 6px 6px 12px;
      transition: border-color 120ms ease, box-shadow 120ms ease;
    }
    .row:focus-within {
      border-color: var(--gcb-accent, #4338ca);
      box-shadow: 0 0 0 3px rgba(67, 56, 202, .12);
    }
    input[type='text'] {
      font: inherit;
      flex: 1;
      border: 0;
      outline: 0;
      background: transparent;
      color: var(--gcb-fg, #1a1a1a);
      padding: 8px 0;
      min-width: 0;
    }
    input[type='text']::placeholder { color: var(--gcb-muted-fg, #888); }
    button.ask {
      font: inherit;
      font-weight: 500;
      padding: 8px 14px;
      border-radius: 6px;
      border: 0;
      background: var(--gcb-accent, #4338ca);
      color: #fff;
      cursor: pointer;
      transition: filter 120ms ease, transform 120ms ease;
    }
    button.ask:hover:not(:disabled) { filter: brightness(1.05); }
    button.ask:active:not(:disabled) { transform: translateY(1px); }
    button.ask:disabled { opacity: .5; cursor: not-allowed; }
    .examples {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .chip {
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 999px;
      border: 1px solid var(--gcb-border, #d0d0d0);
      background: var(--gcb-bg, #fff);
      color: var(--gcb-muted-fg, #555);
      cursor: pointer;
      transition: background 120ms ease, color 120ms ease;
    }
    .chip:hover { background: var(--gcb-accent-soft-bg, #f5f3ff); color: var(--gcb-accent, #4338ca); }
    .empty {
      font-size: 13px;
      color: var(--gcb-muted-fg, #555);
      padding: 14px 16px;
      border: 1px dashed var(--gcb-border, #d0d0d0);
      border-radius: 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .empty button {
      font: inherit;
      font-size: 12px;
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid var(--gcb-accent, #4338ca);
      background: var(--gcb-bg, #fff);
      color: var(--gcb-accent, #4338ca);
      cursor: pointer;
    }
    .empty button:hover { background: var(--gcb-accent-soft-bg, #f5f3ff); }

    /* ── Clarification mode ── */
    .clarify-banner {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .clarify-label {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      background: var(--gcb-accent-soft-bg, #f5f3ff);
      border: 1.5px solid var(--gcb-accent, #4338ca);
      border-radius: 10px 10px 0 0;
      padding: 10px 14px;
      font-size: 13px;
      line-height: 1.5;
    }
    .clarify-icon {
      font-size: 16px;
      flex-shrink: 0;
      margin-top: 1px;
    }
    .clarify-question {
      color: var(--gcb-fg, #1a1a1a);
      font-weight: 500;
    }
    .clarify-hint {
      font-size: 11px;
      color: var(--gcb-muted-fg, #666);
      margin-top: 2px;
    }
    .clarify-row {
      display: flex;
      gap: 8px;
      background: var(--gcb-bg, #fff);
      border: 1.5px solid var(--gcb-accent, #4338ca);
      border-top: none;
      border-radius: 0 0 10px 10px;
      padding: 6px 6px 6px 12px;
      box-shadow: 0 0 0 3px rgba(67, 56, 202, .12);
    }
    .clarify-row input[type='text'] {
      font: inherit;
      flex: 1;
      border: 0;
      outline: 0;
      background: transparent;
      color: var(--gcb-fg, #1a1a1a);
      padding: 8px 0;
      min-width: 0;
    }
    .clarify-row input[type='text']::placeholder { color: var(--gcb-muted-fg, #888); }
    button.answer {
      font: inherit;
      font-weight: 600;
      padding: 8px 14px;
      border-radius: 6px;
      border: 0;
      background: var(--gcb-accent, #4338ca);
      color: #fff;
      cursor: pointer;
      transition: filter 120ms ease;
    }
    button.answer:hover:not(:disabled) { filter: brightness(1.08); }
    button.answer:disabled { opacity: .5; cursor: not-allowed; }
  `;

	/**
	 * Why the input is disabled, or null when ready to accept questions.
	 * The host computes this from its own state (datasets loaded, key set).
	 */
	@property({ attribute: false }) disabledReason: AskInputDisabledReason = null;

	/**
	 * Optional example prompts shown as clickable chips beneath the input.
	 * Click → fills the input AND submits, so the user has zero-friction
	 * "click and watch the agent run" demo path.
	 */
	@property({ attribute: false }) examples: ReadonlyArray<string> = [];

	/** Whether a plan is currently in flight. When true, Ask is disabled. */
	@property({ type: Boolean }) busy = false;

	/**
	 * When set, the input switches to clarification mode: a highlighted
	 * banner shows the model's question and the input/button prompt the
	 * user to answer it. The host clears this once the answer is routed
	 * back to the agentic loop.
	 */
	@property({ attribute: false }) clarifyQuestion: string | null = null;

	@state() private _value = "";

	private _onInput = (e: Event) => {
		this._value = (e.target as HTMLInputElement).value;
	};

	private _onKeydown = (e: KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			this._submit();
		}
	};

	private _submit() {
		const q = this._value.trim();
		if (!q) return;
		// When the model is asking a clarification question, dispatch a
		// dedicated event so the host can route it directly to the loop
		// without touching _agentBusy or any other ask() lifecycle state.
		// This completely separates clarification routing from normal ask routing.
		const eventName = this.clarifyQuestion ? "gcb:clarify-answer" : "gcb:ask";
		if (!this.clarifyQuestion && (this.disabledReason !== null || this.busy)) return;
		this.dispatchEvent(new CustomEvent<string>(eventName, { detail: q }));
		this._value = "";
	}

	private _onChip = (q: string) => {
		if (this.disabledReason !== null || this.busy) return;
		this.dispatchEvent(new CustomEvent<string>("gcb:ask", { detail: q }));
	};

	private _requestSettings = () => {
		this.dispatchEvent(new CustomEvent("gcb:request-settings"));
	};

	override render() {
		// ── Clarification mode ────────────────────────────────────────────────
		// The agentic loop has called ask_user and is paused. Show the model's
		// question prominently and transform the input+button into an "Answer"
		// slot. The user's input is submitted like a normal Ask — the host
		// intercepts it and routes it to the loop instead of starting a new ask.
		if (this.clarifyQuestion) {
			return html`
        <div class="wrap">
          <div class="clarify-banner">
            <div class="clarify-label">
              <span class="clarify-icon">❓</span>
              <div>
                <div class="clarify-question">${this.clarifyQuestion}</div>
                <div class="clarify-hint">Type your answer below and press Answer to continue.</div>
              </div>
            </div>
            <div class="clarify-row">
              <input
                type="text"
                placeholder="Type your answer…"
                .value=${this._value}
                @input=${this._onInput}
                @keydown=${this._onKeydown}
                aria-label="Answer the model's question"
              />
              <button
                type="button"
                class="answer"
                ?disabled=${!this._value.trim()}
                @click=${() => this._submit()}
              >Answer</button>
            </div>
          </div>
        </div>
      `;
		}

		if (this.disabledReason === "no-data") {
			return html`
        <div class="wrap">
          <div class="empty" role="status">
            <span>Drop a CSV or GeoJSON file above to start.</span>
          </div>
        </div>
      `;
		}
		if (this.disabledReason === "no-key") {
			return html`
        <div class="wrap">
          <div class="empty" role="status">
            <span>Set your Anthropic API key to start chatting.</span>
            <button type="button" @click=${this._requestSettings}>Open settings</button>
          </div>
        </div>
      `;
		}
		return html`
      <div class="wrap">
        <div class="row">
          <input
            type="text"
            placeholder=${this.busy ? "Thinking…" : "Ask a question about your data…"}
            .value=${this._value}
            ?disabled=${this.busy}
            @input=${this._onInput}
            @keydown=${this._onKeydown}
            aria-label="Ask GeoChatBot a question"
          />
          <button
            type="button"
            class="ask"
            ?disabled=${this.busy || !this._value.trim()}
            @click=${() => this._submit()}
          >Ask</button>
        </div>
        ${
					this.examples.length
						? html`
              <div class="examples" role="list" aria-label="Example questions">
                ${this.examples.map(
									(ex) => html`
                    <button
                      class="chip"
                      type="button"
                      role="listitem"
                      ?disabled=${this.busy}
                      @click=${() => this._onChip(ex)}
                    >${ex}</button>
                  `,
								)}
              </div>
            `
						: nothing
				}
      </div>
    `;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"gcb-ask-input": GcbAskInput;
	}
}
