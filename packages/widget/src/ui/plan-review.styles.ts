import { css } from 'lit';

export const planReviewStyles = css`
  :host {
    --bg-base: #0a0d12;
    --text: #e7eaf0;
    --text-2: #98a1b0;
    --muted: #5a6373;
    --glass-bg: rgba(14, 18, 24, 0.72);
    --glass-edge: rgba(255, 255, 255, 0.06);
    --glass-edge-hi: rgba(255, 255, 255, 0.14);
    --code-bg: rgba(0, 0, 0, 0.45);
    --accent: #4ade80;
    --accent-2: #38bdf8;
    --good: #4ade80;
    --warn: #fbbf24;
    --bad: #f87171;
    --t-fast: 160ms;
    --t-med: 240ms;
    --spring: cubic-bezier(.34, 1.56, .64, 1);
    --ease: cubic-bezier(.2, .8, .2, 1);
    --font-sans: Inter, -apple-system, system-ui, sans-serif;
    --font-mono: 'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace;

    display: block;
    color: var(--text);
    font-family: var(--font-sans);
    -webkit-font-smoothing: antialiased;
    letter-spacing: -.003em;
  }
  @media (prefers-reduced-motion: reduce) {
    :host { --t-fast: 0ms; --t-med: 0ms; }
    *, *::before, *::after { animation-duration: .001ms !important; transition-duration: .001ms !important; }
  }

  .glass {
    position: relative;
    background: var(--glass-bg);
    border: 1px solid var(--glass-edge);
    border-radius: 12px;
    backdrop-filter: blur(24px) saturate(130%);
    -webkit-backdrop-filter: blur(24px) saturate(130%);
    box-shadow: 0 0 0 1px var(--glass-edge), 0 20px 50px -16px rgba(0,0,0,.6);
    overflow: hidden;
  }

  .head { padding: 22px 22px 14px; border-bottom: 1px solid var(--glass-edge); }
  .title { margin: 0; font: 700 16px/1.3 var(--font-sans); letter-spacing: -.02em; }
  .meta { margin-top: 6px; color: var(--text-2); font-size: 12.5px; display: flex; gap: 10px; flex-wrap: wrap; }
  .chip { padding: 3px 9px; border-radius: 6px; background: rgba(255,255,255,.05); border: 1px solid var(--glass-edge); font: 500 11.5px/1 var(--font-mono); color: var(--text-2); font-variant-numeric: tabular-nums; }
  .chip.accent { background: rgba(74,222,128,.12); border-color: rgba(74,222,128,.35); color: var(--accent); }

  .assumptions { padding: 12px 22px; background: rgba(255,255,255,.025); border-bottom: 1px solid var(--glass-edge); font-size: 12.5px; color: var(--text-2); display: flex; gap: 12px; }
  .assumptions ul { margin: 0; padding-left: 18px; }
  .assumptions code { color: var(--accent-2); font-family: var(--font-mono); }

  .steps { padding: 6px 0; }
  .step { padding: 14px 22px; display: grid; grid-template-columns: 32px 1fr auto; gap: 12px; align-items: start; }
  .step + .step { border-top: 1px dashed rgba(255,255,255,.08); }
  .orb {
    width: 28px; height: 28px; border-radius: 8px;
    display: inline-flex; align-items: center; justify-content: center;
    font: 600 12px/1 var(--font-mono); font-variant-numeric: tabular-nums;
    background: rgba(255,255,255,.06); border: 1px solid var(--glass-edge);
    color: var(--text-2);
  }
  .orb.success { background: rgba(74,222,128,.14); border-color: rgba(74,222,128,.45); color: var(--good); }
  .orb.running { background: rgba(56,189,248,.14); border-color: rgba(56,189,248,.45); color: var(--accent-2); }
  .orb.retry   { background: rgba(251,191,36,.14); border-color: rgba(251,191,36,.45); color: var(--warn); }
  .orb.fail    { background: rgba(248,113,113,.14); border-color: rgba(248,113,113,.45); color: var(--bad); }

  .tool { font: 700 13px/1 var(--font-mono); color: var(--accent); letter-spacing: -.005em; }
  .tool::before { content: '$'; color: var(--muted); margin-right: 4px; }
  .why { color: var(--text); margin: 4px 0 8px; font-size: 13.5px; line-height: 1.45; }
  .args { background: var(--code-bg); border: 1px solid var(--glass-edge); border-radius: 6px; padding: 10px 12px; font: 12.5px/1.55 var(--font-mono); white-space: pre-wrap; display: grid; gap: 2px; }
  .args .row { display: grid; grid-template-columns: 96px 1fr; gap: 10px; }
  .args .k { color: var(--muted); }
  .args .v { color: var(--text); word-break: break-word; }
  .var { color: var(--accent-2); }
  .str { color: var(--accent-2); }
  .num { color: var(--warn); font-variant-numeric: tabular-nums; }
  .out { margin-top: 8px; font-size: 12.5px; color: var(--text-2); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .out b { color: var(--text); font-weight: 600; }

  .step-actions { display: flex; flex-direction: column; gap: 6px; }
  .iconbtn {
    min-height: 28px; padding: 4px 10px;
    background: rgba(255,255,255,.04);
    border: 1px solid var(--glass-edge);
    border-radius: 6px;
    color: var(--text-2); font: 500 11.5px/1 var(--font-sans); cursor: pointer;
    transition: transform var(--t-fast) var(--spring), background var(--t-fast) var(--ease);
  }
  .iconbtn:hover { color: var(--text); background: rgba(255,255,255,.08); }
  .iconbtn:active { transform: scale(.94); }

  .foot { padding: 14px 22px; background: rgba(0,0,0,.18); border-top: 1px solid var(--glass-edge); display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  button.btn { min-height: 40px; padding: 10px 18px; border-radius: 6px; font: 600 13px/1 var(--font-sans); cursor: pointer; border: 1px solid var(--glass-edge); background: rgba(255,255,255,.04); color: var(--text); transition: transform var(--t-fast) var(--spring), background var(--t-fast) var(--ease); display: inline-flex; align-items: center; gap: 8px; }
  button.btn:hover { background: rgba(255,255,255,.08); }
  button.btn:active { transform: scale(.97); }
  button.btn.ghost { background: transparent; border-color: transparent; color: var(--text-2); }
  button.btn.run { background: var(--accent); color: #04060e; border-color: var(--accent); font-weight: 700; }
  button.btn.run:hover { background: color-mix(in srgb, var(--accent) 90%, white); }

  .critic { margin-top: 8px; padding: 10px 12px; background: rgba(251,191,36,.10); border: 1px solid rgba(251,191,36,.35); border-radius: 6px; font-size: 12.5px; color: var(--warn); }
`;
