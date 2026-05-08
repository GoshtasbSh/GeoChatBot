import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

async function loadRender() {
  await import('../../../src/agent/tools/render.js');
  return await import('../../../src/agent/tools/registry.js');
}

describe('render.* tools', () => {
  it('registers 4 render tools', async () => {
    const { listTools } = await loadRender();
    expect(listTools().map((t) => t.id).sort()).toEqual([
      'render.chart', 'render.map', 'render.summary', 'render.table',
    ]);
  });

  it('all render tools have output_kind=rendered', async () => {
    const { listTools } = await loadRender();
    for (const t of listTools()) expect(t.output_kind).toBe('rendered');
  });

  it('render.chart enforces kind enum', async () => {
    const { getTool } = await loadRender();
    const t = getTool('render.chart')!;
    expect(t.args.safeParse({ table: 't', kind: 'bar', x: 'a', y: 'b' }).success).toBe(true);
    expect(t.args.safeParse({ table: 't', kind: 'sankey', x: 'a', y: 'b' }).success).toBe(false);
  });

  it('render.summary requires non-empty text', async () => {
    const { getTool } = await loadRender();
    const t = getTool('render.summary')!;
    expect(t.args.safeParse({ text: '' }).success).toBe(false);
  });
});
