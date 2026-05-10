// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import '../../src/ui/result-canvas.js';
import type { ResultPayload } from '../../src/agent/executor/types.js';

interface Turn {
  id: string;
  question: string;
  results: ResultPayload[];
}

interface CanvasEl extends HTMLElement {
  updateComplete: Promise<unknown>;
  setResult(p: ResultPayload | unknown): void;
  beginTurn(q: string): void;
  setOrigin(o: { planId: string; stepId: string; question: string }): void;
  clear(): void;
  _turns: Turn[];
}

function mount(): CanvasEl {
  const el = document.createElement('result-canvas') as unknown as CanvasEl;
  document.body.appendChild(el);
  return el;
}

describe('<result-canvas>', () => {
  it('starts empty (no turns rendered)', async () => {
    const el = mount();
    await el.updateComplete;
    expect(el._turns.length).toBe(0);
    // Empty state shown
    expect(el.shadowRoot?.querySelector('.empty')).toBeTruthy();
  });

  it('appends results to a single turn (auto-creates turn for legacy callers)', async () => {
    const el = mount();
    el.setResult({ kind: 'summary', text: 'hello' });
    el.setResult({ kind: 'table', rows: [{ a: 1 }], columns: ['a'] });
    await el.updateComplete;
    expect(el._turns.length).toBe(1);
    expect(el._turns[0]!.results.length).toBe(2);
    expect(el._turns[0]!.results[0]!).toMatchObject({ kind: 'summary', text: 'hello' });
    expect(el._turns[0]!.results[1]!).toMatchObject({ kind: 'table' });
  });

  it('beginTurn creates a new user turn with question', async () => {
    const el = mount();
    el.beginTurn('How many rows?');
    el.setResult({ kind: 'summary', text: '5 rows' });
    await el.updateComplete;
    expect(el._turns.length).toBe(1);
    expect(el._turns[0]!.question).toBe('How many rows?');
    expect(el._turns[0]!.results[0]!).toMatchObject({ kind: 'summary' });
  });

  it('clear() drops all turns', async () => {
    const el = mount();
    el.setResult({ kind: 'summary', text: 'hi' });
    el.clear();
    await el.updateComplete;
    expect(el._turns.length).toBe(0);
  });

  it('does not crash on a malformed chart payload missing spec.data', async () => {
    const el = mount();
    el.setResult({ kind: 'chart', spec: { kind: 'bar' } });
    await expect(el.updateComplete).resolves.toBeDefined();
    expect(el._turns[0]!.results[0]!).toMatchObject({ kind: 'chart' });
    expect(el.shadowRoot).toBeTruthy();
  });

  it('does not crash on a malformed layer payload missing geojson.features', async () => {
    const el = mount();
    el.setResult({ kind: 'layer', geojson: { type: 'FeatureCollection' } });
    await expect(el.updateComplete).resolves.toBeDefined();
    expect(el._turns[0]!.results[0]!).toMatchObject({ kind: 'layer' });
    expect(el.shadowRoot).toBeTruthy();
  });
});
