import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderDatasetsBlock, renderToolsBlock, renderPrompt } from '../../../src/agent/prompts/builders.js';
import { _resetRegistry, registerTool } from '../../../src/agent/tools/registry.js';
import { z } from 'zod';

beforeEach(() => _resetRegistry());
afterEach(() => _resetRegistry());

describe('renderDatasetsBlock', () => {
  it('renders a single dataset', () => {
    const out = renderDatasetsBlock([{
      name: 'sales', kind: 'table', rows: 412309, geometry: { kind: 'point', column: 'geom', crs: 'EPSG:4326', bbox: [-74, 40, -73, 41] },
      columns: [{ name: 'price', type: 'number', nulls: 0 }], sample: [],
    }]);
    expect(out).toMatch(/sales \(table\)/);
    expect(out).toMatch(/EPSG:4326/);
    expect(out).toMatch(/price: number/);
  });

  it('caps datasets at 5', () => {
    const ds = Array.from({ length: 8 }, (_, i) => ({
      name: `d${i}`, kind: 'table' as const, rows: 0, columns: [], sample: [],
    }));
    const out = renderDatasetsBlock(ds);
    expect(out.match(/^## d\d+/gm)?.length).toBe(5);
  });
});

describe('renderToolsBlock', () => {
  it('groups by namespace and renders descriptions + examples', () => {
    registerTool({
      id: 'geometry.buffer', description: 'expand', args: z.object({}), output_kind: 'layer',
      examples: [{ when: 'X', args: {} }],
    });
    registerTool({
      id: 'render.map', description: 'show', args: z.object({}), output_kind: 'rendered',
    });
    const out = renderToolsBlock();
    expect(out).toMatch(/^## geometry\.\*/m);
    expect(out).toMatch(/^## render\.\*/m);
    expect(out).toMatch(/expand/);
  });
});

describe('renderPrompt', () => {
  it('substitutes the three slots', () => {
    const out = renderPrompt({
      datasets: 'D-BLOCK',
      tools: 'T-BLOCK',
      examples: 'E-BLOCK',
    });
    expect(out).toContain('D-BLOCK');
    expect(out).toContain('T-BLOCK');
    expect(out).toContain('E-BLOCK');
    expect(out).not.toContain('{{datasets_block}}');
  });
});
