import { css } from "lit";

/**
 * Phase 7 design tokens — Combined design (mockups/I-combined.html).
 *
 * Light  = Meridian: warm paper bg, white surfaces, emerald accent.
 * Dark   = GIS Pro:  navy-slate bg, lighter slate surfaces, amber accent.
 *
 * Spec: docs/superpowers/specs/2026-05-08-phase-7-dashboard-redesign-design.md §2
 */
export const tokensCSS = css`
  :host {
    /* Type stack */
    --gcb-font-sans: "Geist", "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
    --gcb-font-display: "Newsreader", "Times New Roman", Georgia, serif;
    --gcb-font-mono: "JetBrains Mono", ui-monospace, Menlo, monospace;

    /* Radii + shape */
    --gcb-radius-sm: 6px;
    --gcb-radius: 10px;
    --gcb-radius-lg: 14px;

    /* ── LIGHT (Meridian: warm paper + emerald) ─────────────────── */
    --gcb-bg: #f7f5ef;
    --gcb-bg-rail: #edeae0;
    --gcb-bg-2: #ffffff;
    --gcb-bg-3: #f3f0e8;
    --gcb-bg-4: #ede9df;
    --gcb-line: #e5e0d5;
    --gcb-line-strong: #d0cbc0;
    --gcb-line-soft: #efece5;

    --gcb-ink: #1c1917;
    --gcb-ink-soft: #44403c;
    --gcb-ink-muted: #78716c;
    --gcb-ink-dim: #a8a29e;

    --gcb-accent: #059669;
    --gcb-accent-fg: #ffffff;
    --gcb-accent-ink: #065f46;
    --gcb-accent-soft: rgba(5,150,105,0.09);
    --gcb-accent-ring: rgba(5,150,105,0.25);

    --gcb-user-bg: #0369a1;

    --gcb-ocean: #d9edf7;
    --gcb-land: #c3dcbe;
    --gcb-grid-line: #aac8dc;

    --gcb-shadow-1: 0 1px 2px rgba(20,20,20,0.06), 0 4px 12px rgba(20,20,20,0.04);
    --gcb-shadow-2: 0 8px 32px rgba(20,20,20,0.10);

    color-scheme: light;
  }

  /* ── DARK (GIS Pro: navy-slate + amber) ──────────────────────── */
  :host([theme="dark"]) {
    --gcb-bg: #1a2033;
    --gcb-bg-rail: #141b2b;
    --gcb-bg-2: #242b3d;
    --gcb-bg-3: #2d3751;
    --gcb-bg-4: #374564;
    --gcb-line: #3d4d63;
    --gcb-line-strong: #4a5e78;
    --gcb-line-soft: #2d3751;

    --gcb-ink: #e2e8f0;
    --gcb-ink-soft: #b0bec5;
    --gcb-ink-muted: #647891;
    --gcb-ink-dim: #4a5e78;

    --gcb-accent: #f59e0b;
    --gcb-accent-fg: #1a2033;
    --gcb-accent-ink: #fbbf24;
    --gcb-accent-soft: rgba(245,158,11,0.10);
    --gcb-accent-ring: rgba(245,158,11,0.28);

    --gcb-user-bg: #1e40af;

    --gcb-ocean: #0d1c2f;
    --gcb-land: #1a3352;
    --gcb-grid-line: #1e3a5f;

    --gcb-shadow-1: 0 1px 2px rgba(0,0,0,.25), 0 4px 16px rgba(0,0,0,.15);
    --gcb-shadow-2: 0 8px 32px rgba(0,0,0,.35);

    color-scheme: dark;
  }

  @media (prefers-color-scheme: dark) {
    :host([theme="auto"]) {
      --gcb-bg: #1a2033;
      --gcb-bg-rail: #141b2b;
      --gcb-bg-2: #242b3d;
      --gcb-bg-3: #2d3751;
      --gcb-bg-4: #374564;
      --gcb-line: #3d4d63;
      --gcb-line-strong: #4a5e78;
      --gcb-line-soft: #2d3751;
      --gcb-ink: #e2e8f0;
      --gcb-ink-soft: #b0bec5;
      --gcb-ink-muted: #647891;
      --gcb-ink-dim: #4a5e78;
      --gcb-accent: #f59e0b;
      --gcb-accent-fg: #1a2033;
      --gcb-accent-ink: #fbbf24;
      --gcb-accent-soft: rgba(245,158,11,0.10);
      --gcb-accent-ring: rgba(245,158,11,0.28);
      --gcb-user-bg: #1e40af;
      --gcb-ocean: #0d1c2f;
      --gcb-land: #1a3352;
      --gcb-grid-line: #1e3a5f;
      --gcb-shadow-1: 0 1px 2px rgba(0,0,0,.25), 0 4px 16px rgba(0,0,0,.15);
      --gcb-shadow-2: 0 8px 32px rgba(0,0,0,.35);
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
