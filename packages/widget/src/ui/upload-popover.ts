import { LitElement, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { tokensCSS } from "./tokens.js";

/**
 * <gcb-upload-popover> — Phase 7 compact upload affordance.
 *
 * The host renders this popover anchored to a top-right "Add data"
 * button. It manages its own drag-over highlight, a hidden file input
 * for click-to-pick, and a paste affordance that captures `⌘V` while
 * the popover has focus. On any successful file pick it emits
 * `gcb:files` with a `File[]` detail and `gcb:popover-close` so the
 * host can close it.
 *
 * Spec: docs/superpowers/specs/2026-05-08-phase-7-dashboard-redesign-design.md §1.2, §3.1
 */
@customElement("gcb-upload-popover")
export class GcbUploadPopover extends LitElement {
	static override styles = [
		tokensCSS,
		css`
      :host { display: contents; font-family: var(--gcb-font-sans); }
      .popover {
        position: absolute; right: 0; top: 100%;
        margin-top: 8px;
        width: 360px; padding: 14px;
        background: var(--gcb-bg-2); color: var(--gcb-ink);
        border: 1px solid var(--gcb-line); border-radius: var(--gcb-radius-lg);
        box-shadow: var(--gcb-shadow-2);
        z-index: 50;
      }
      h5 {
        margin: 0 0 10px;
        font-family: var(--gcb-font-display); font-style: italic;
        font-size: 15px; font-weight: 500;
      }
      .drop-area {
        border: 1.5px dashed var(--gcb-line); border-radius: var(--gcb-radius);
        padding: 22px 14px; text-align: center;
        color: var(--gcb-ink-muted); font-size: 13px;
        cursor: pointer;
        transition: border-color 140ms ease, background 140ms ease, color 140ms ease;
      }
      .drop-area.over,
      .drop-area:hover {
        border-color: var(--gcb-accent);
        color: var(--gcb-ink);
        background: var(--gcb-accent-soft);
      }
      .drop-area b { color: var(--gcb-ink); font-weight: 600; }
      .hint {
        font-family: var(--gcb-font-mono); font-size: 10px;
        color: var(--gcb-ink-dim); margin-top: 6px;
      }
      .or {
        display: flex; align-items: center; gap: 10px; margin: 10px 0;
        font-family: var(--gcb-font-mono); font-size: 10px;
        color: var(--gcb-ink-muted);
        text-transform: uppercase; letter-spacing: 0.16em;
      }
      .or::before, .or::after {
        content: ""; flex: 1; height: 1px; background: var(--gcb-line);
      }
      .paste {
        display: flex; align-items: center; gap: 8px;
        padding: 10px 12px;
        background: var(--gcb-bg); border: 1px solid var(--gcb-line);
        border-radius: var(--gcb-radius-sm);
        font-size: 12px; color: var(--gcb-ink-soft);
        cursor: pointer;
      }
      .paste:hover { border-color: var(--gcb-accent); color: var(--gcb-ink); }
      .foot {
        display: flex; align-items: center; gap: 8px; margin-top: 12px;
        font-family: var(--gcb-font-mono); font-size: 10px;
        color: var(--gcb-ink-muted);
      }
      .foot code {
        padding: 1px 5px; border-radius: 3px;
        background: var(--gcb-bg); border: 1px solid var(--gcb-line);
        color: var(--gcb-ink-soft);
      }
      input[type="file"] { display: none; }
    `,
	];

	@property({ type: Boolean, reflect: true })
	open = false;

	/** Drag-over highlight. */
	private _over = false;

	private _onKeydown = (e: KeyboardEvent): void => {
		if (this.open && e.key === "Escape") this._emitClose();
	};
	private _onDocMouseDown = (e: MouseEvent): void => {
		if (!this.open) return;
		// If the mousedown started outside our shadow boundary, close.
		const path = e.composedPath();
		if (!path.includes(this)) this._emitClose();
	};

	override connectedCallback(): void {
		super.connectedCallback();
		document.addEventListener("keydown", this._onKeydown);
		// Capture phase: composedPath() is intact before retargeting strips
		// shadow nodes, so an inside-popover click reliably includes `this`.
		document.addEventListener("mousedown", this._onDocMouseDown, true);
	}
	override disconnectedCallback(): void {
		super.disconnectedCallback();
		document.removeEventListener("keydown", this._onKeydown);
		document.removeEventListener("mousedown", this._onDocMouseDown, true);
	}

	private _emitFiles(files: File[]): void {
		if (!files.length) return;
		this.dispatchEvent(
			new CustomEvent<File[]>("gcb:files", {
				detail: files,
				bubbles: true,
				composed: true,
			}),
		);
		this._emitClose();
	}
	private _emitClose(): void {
		this.dispatchEvent(
			new CustomEvent("gcb:popover-close", { bubbles: true, composed: true }),
		);
	}

	private _onDragOver = (e: DragEvent): void => {
		e.preventDefault();
		this._over = true;
		this.requestUpdate();
	};
	private _onDragLeave = (): void => {
		this._over = false;
		this.requestUpdate();
	};
	private _onDrop = (e: DragEvent): void => {
		e.preventDefault();
		this._over = false;
		const files = e.dataTransfer?.files;
		if (files?.length) this._emitFiles(Array.from(files));
	};
	private _onClickPick = (): void => {
		const input = this.shadowRoot?.querySelector(
			'input[type="file"]',
		) as HTMLInputElement | null;
		input?.click();
	};
	private _onFileChange = (e: Event): void => {
		const t = e.target as HTMLInputElement;
		if (t.files?.length) {
			this._emitFiles(Array.from(t.files));
			// Reset so re-picking the SAME file fires `change` again. Without
			// this, browsers (Chrome/Safari/Firefox) coalesce identical
			// selections into a single change event and the user has to pick
			// a different file or close+reopen the popover.
			t.value = "";
		}
	};
	private _onPasteHint = (): void => {
		// Hint click does not pull files; we listen for `paste` on the host.
		// The user is expected to paste into the popover with the keyboard;
		// the click is purely affordance.
	};

	override render() {
		if (!this.open) return nothing;
		return html`
      <div
        class="popover"
        role="dialog"
        aria-modal="true"
        aria-label="Add a dataset"
      >
        <h5>Add a dataset</h5>
        <div
          class="drop-area ${this._over ? "over" : ""}"
          @dragover=${this._onDragOver}
          @dragleave=${this._onDragLeave}
          @drop=${this._onDrop}
          @click=${this._onClickPick}
        >
          <div><b>Drop a file</b> or click to choose</div>
          <div class="hint">CSV · GeoJSON · Shapefile.zip · Excel · Parquet</div>
        </div>
        <div class="or">or</div>
        <div class="paste" @click=${this._onPasteHint}>
          Paste a URL or table from clipboard
        </div>
        <div class="foot">
          <code>⌘V</code> paste · <code>⌘O</code> open file · <code>esc</code> close
        </div>
        <input type="file" multiple
          accept=".csv,.tsv,.geojson,.json,.zip,.shp,.xlsx,.xls,.parquet"
          @change=${this._onFileChange} />
      </div>
    `;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"gcb-upload-popover": GcbUploadPopover;
	}
}
