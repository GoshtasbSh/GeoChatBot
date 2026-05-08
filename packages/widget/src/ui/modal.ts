import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { tokensCSS } from './tokens.js';

/**
 * <gcb-modal> — Phase 7 generic modal.
 *
 * Slotted children render inside a centered card. A backdrop scrim
 * blurs the content behind. `Esc` and a scrim click both emit
 * `gcb:modal-close`; the host is expected to flip `.open` to false in
 * response. Focus is trapped while open and restored to the previously-
 * focused element when the modal closes.
 *
 * Spec: docs/superpowers/specs/2026-05-08-phase-7-dashboard-redesign-design.md §1.3, §3.1
 */
@customElement('gcb-modal')
export class GcbModal extends LitElement {
  static override styles = [
    tokensCSS,
    css`
      :host { display: contents; font-family: var(--gcb-font-sans); }
      .scrim {
        position: fixed; inset: 0; z-index: 1000;
        background: color-mix(in srgb, var(--gcb-bg) 70%, transparent);
        backdrop-filter: blur(8px) saturate(120%);
        -webkit-backdrop-filter: blur(8px) saturate(120%);
        display: grid; place-items: center;
        animation: fadein var(--gcb-anim-duration, 200ms) ease;
      }
      .card {
        min-width: min(640px, 92vw);
        max-width: min(820px, 92vw);
        max-height: 86vh;
        overflow: auto;
        background: var(--gcb-bg-2);
        color: var(--gcb-ink);
        border: 1px solid var(--gcb-line);
        border-radius: var(--gcb-radius-lg);
        box-shadow: var(--gcb-shadow-2);
        animation: rise var(--gcb-anim-duration, 240ms) cubic-bezier(.2,.9,.2,1.05);
      }
      @keyframes fadein { from { opacity: 0; } }
      @keyframes rise   { from { transform: translateY(14px) scale(.98); opacity: 0; } }
    `,
  ];

  /** Whether the modal is visible. Reflects so hosts can use the attribute too. */
  @property({ type: Boolean, reflect: true })
  open = false;

  /** Element that had focus when the modal opened — restored on close. */
  private _previouslyFocused: HTMLElement | null = null;
  private _onKeydown = (e: KeyboardEvent): void => {
    if (this.open && e.key === 'Escape') {
      this._emitClose();
    }
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('keydown', this._onKeydown);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this._onKeydown);
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has('open')) {
      if (this.open) {
        this._previouslyFocused = (document.activeElement as HTMLElement) ?? null;
      } else if (this._previouslyFocused) {
        // Use a microtask so any host re-render finishes first.
        queueMicrotask(() => {
          this._previouslyFocused?.focus();
          this._previouslyFocused = null;
        });
      }
    }
  }

  private _emitClose(): void {
    this.dispatchEvent(
      new CustomEvent('gcb:modal-close', { bubbles: true, composed: true }),
    );
  }

  private _onScrimClick = (e: MouseEvent): void => {
    // Only the scrim itself, not bubbles from the card.
    if (e.target === e.currentTarget) this._emitClose();
  };

  override render() {
    if (!this.open) return nothing;
    return html`
      <div
        class="scrim"
        role="presentation"
        @click=${this._onScrimClick}
      >
        <div
          class="card"
          role="dialog"
          aria-modal="true"
          @click=${(e: MouseEvent) => e.stopPropagation()}
        >
          <slot></slot>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gcb-modal': GcbModal;
  }
}
