import { css } from 'lit';

/**
 * Phase 7 design tokens. Light is the default; `:host([theme="dark"])`
 * and `(prefers-color-scheme: dark)` (when `theme="auto"`) flip to dark.
 *
 * Spec: docs/superpowers/specs/2026-05-08-phase-7-dashboard-redesign-design.md §2
 */
export const tokensCSS = css`
  :host {
    /* Type stack */
    --gcb-font-sans: "Geist", system-ui, -apple-system, "Segoe UI", sans-serif;
    --gcb-font-display: "Newsreader", "Times New Roman", Georgia, serif;
    --gcb-font-mono: "JetBrains Mono", ui-monospace, Menlo, monospace;

    /* Radii + shape */
    --gcb-radius-sm: 6px;
    --gcb-radius: 10px;
    --gcb-radius-lg: 14px;

    /* Light tokens (defaults) */
    --gcb-bg: #fbfaf7;
    --gcb-bg-2: #ffffff;
    --gcb-bg-3: #f3f1ec;
    --gcb-line: #e5e1d8;
    --gcb-line-soft: #efece5;
    --gcb-ink: #1a1a1a;
    --gcb-ink-soft: #4a4a4a;
    --gcb-ink-muted: #757575;
    --gcb-ink-dim: #a8a8a8;
    --gcb-accent: #0e7a5f;
    --gcb-accent-fg: #ffffff;
    --gcb-accent-soft: #d8eee5;
    --gcb-shadow-1: 0 1px 2px rgba(20,20,20,0.04), 0 4px 12px rgba(20,20,20,0.04);
    --gcb-shadow-2: 0 8px 32px rgba(20,20,20,0.08);

    color-scheme: light;
  }

  :host([theme="dark"]) {
    --gcb-bg: #0c0e12;
    --gcb-bg-2: #14171c;
    --gcb-bg-3: #1b1f25;
    --gcb-line: #25292f;
    --gcb-line-soft: #1d2127;
    --gcb-ink: #e7e9ee;
    --gcb-ink-soft: #b6bbc4;
    --gcb-ink-muted: #767c87;
    --gcb-ink-dim: #525861;
    --gcb-accent: #c4f042;
    --gcb-accent-fg: #0c0e12;
    --gcb-accent-soft: rgba(196,240,66,0.10);
    --gcb-shadow-1: 0 1px 0 rgba(255,255,255,.04), 0 18px 36px -16px rgba(0,0,0,.6);
    --gcb-shadow-2: 0 24px 64px -24px rgba(0,0,0,.7);

    color-scheme: dark;
  }

  @media (prefers-color-scheme: dark) {
    :host([theme="auto"]) {
      --gcb-bg: #0c0e12;
      --gcb-bg-2: #14171c;
      --gcb-bg-3: #1b1f25;
      --gcb-line: #25292f;
      --gcb-line-soft: #1d2127;
      --gcb-ink: #e7e9ee;
      --gcb-ink-soft: #b6bbc4;
      --gcb-ink-muted: #767c87;
      --gcb-ink-dim: #525861;
      --gcb-accent: #c4f042;
      --gcb-accent-fg: #0c0e12;
      --gcb-accent-soft: rgba(196,240,66,0.10);
      --gcb-shadow-1: 0 1px 0 rgba(255,255,255,.04), 0 18px 36px -16px rgba(0,0,0,.6);
      --gcb-shadow-2: 0 24px 64px -24px rgba(0,0,0,.7);

      color-scheme: dark;
    }
  }

  /* Default animation duration. Declared BEFORE the reduced-motion
     media query so the @media block can override it — source-order
     resolution would otherwise let the unconditional rule win. */
  :host {
    --gcb-anim-duration: 200ms;
  }
  @media (prefers-reduced-motion: reduce) {
    :host {
      --gcb-anim-duration: 0ms;
    }
  }
`;
