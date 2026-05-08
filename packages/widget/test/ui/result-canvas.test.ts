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
});
