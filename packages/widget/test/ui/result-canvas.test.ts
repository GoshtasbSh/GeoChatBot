// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import '../../src/ui/result-canvas.js';
import type { ResultPayload } from '../../src/agent/executor/types.js';

describe('<result-canvas>', () => {
  it('starts empty (no panels rendered)', async () => {
    const el = document.createElement('result-canvas') as unknown as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    document.body.appendChild(el);
    await el.updateComplete;
    expect(el.shadowRoot?.querySelectorAll('.panel').length ?? 0).toBe(0);
  });

  it('keeps the last payload of each kind independently', async () => {
    const el = document.createElement('result-canvas') as unknown as HTMLElement & {
      updateComplete: Promise<unknown>;
      setResult(p: ResultPayload): void;
      _summary: ResultPayload | null;
      _table: ResultPayload | null;
    };
    document.body.appendChild(el);
    el.setResult({ kind: 'summary', text: 'hello' });
    el.setResult({
      kind: 'table',
      rows: [{ a: 1 }],
      columns: ['a'],
    });
    await el.updateComplete;
    expect(el._summary).toMatchObject({ kind: 'summary', text: 'hello' });
    expect(el._table).toMatchObject({ kind: 'table' });
  });

  it('clear() drops all kinds', async () => {
    const el = document.createElement('result-canvas') as unknown as HTMLElement & {
      updateComplete: Promise<unknown>;
      setResult(p: ResultPayload): void;
      clear(): void;
      _summary: ResultPayload | null;
    };
    document.body.appendChild(el);
    el.setResult({ kind: 'summary', text: 'hi' });
    el.clear();
    await el.updateComplete;
    expect(el._summary).toBeNull();
  });

  it('does not crash on a malformed chart payload missing spec.data', async () => {
    // Defensive regression: a critic-patched step or host-injected event
    // could deliver a chart payload without `data`. The renderer must
    // coerce to safe defaults rather than throw inside Lit's render cycle.
    // Pre-fix, `this._chart.spec.data.length` threw; the entire shadow
    // root render aborted. Post-fix, render completes cleanly. Asserting
    // that updateComplete resolves and the payload is stored proves no
    // exception escaped Lit's render loop.
    const el = document.createElement('result-canvas') as unknown as HTMLElement & {
      updateComplete: Promise<unknown>;
      setResult(p: unknown): void;
      _chart: unknown;
    };
    document.body.appendChild(el);
    // Bypass the typed setResult signature to simulate malformed input.
    el.setResult({ kind: 'chart', spec: { kind: 'bar' } });
    await expect(el.updateComplete).resolves.toBeDefined();
    expect(el._chart).toMatchObject({ kind: 'chart' });
    expect(el.shadowRoot).toBeTruthy();
  });

  it('does not crash on a malformed layer payload missing geojson.features', async () => {
    const el = document.createElement('result-canvas') as unknown as HTMLElement & {
      updateComplete: Promise<unknown>;
      setResult(p: unknown): void;
      _layer: unknown;
    };
    document.body.appendChild(el);
    el.setResult({ kind: 'layer', geojson: { type: 'FeatureCollection' } });
    await expect(el.updateComplete).resolves.toBeDefined();
    expect(el._layer).toMatchObject({ kind: 'layer' });
    expect(el.shadowRoot).toBeTruthy();
  });
});
