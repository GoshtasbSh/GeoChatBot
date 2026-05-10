/**
 * Runner unit tests — verify the SQL emitted by each runner against a
 * spy engine. We don't need a real DuckDB to assert that buffer / join /
 * aggregate produce the correct SQL shape.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { tableFromJSON, type Table as ArrowTable } from 'apache-arrow';

import '../../../src/agent/executor/runners/index.js';
import { Executor } from '../../../src/agent/executor/executor.js';
import type {
  DatasetEntry,
  ExecutorEngine,
} from '../../../src/agent/executor/types.js';
import type { Plan } from '../../../src/agent/types.js';

class SpyEngine implements ExecutorEngine {
  hasSpatial = true;
  public sqls: string[] = [];
  public mockResponse: ArrowTable = tableFromJSON([{ ok: 1 }]);
  async query(sql: string): Promise<ArrowTable> {
    this.sqls.push(sql);
    return this.mockResponse;
  }
}

const sales: DatasetEntry = {
  name: 'sales',
  tableName: 'sales',
  geomView: 'sales_geom',
  hasGeometry: true,
};
const hoods: DatasetEntry = {
  name: 'hoods',
  tableName: 'hoods',
  geomView: 'hoods_geom',
  hasGeometry: true,
};

let engine: SpyEngine;
beforeEach(() => {
  engine = new SpyEngine();
});

async function runOneStep(toolId: string, args: Record<string, unknown>): Promise<void> {
  const plan: Plan = {
    goal: 'g',
    assumptions: [],
    dataset_refs: ['sales'],
    steps: [
      { id: 's1', tool: toolId, args, output_var: 'a', why: 'go' },
      { id: 's2', tool: 'render.summary', args: { text: 'x' }, why: 'final' },
    ],
  };
  const exec = new Executor({ engine, datasets: [sales, hoods] });
  await exec.execute(plan, 'pid');
}

describe('runner: sql', () => {
  it('creates a temp view from a SELECT', async () => {
    await runOneStep('sql', { query: 'SELECT * FROM sales WHERE price > 100' });
    expect(engine.sqls.some((s) => /CREATE OR REPLACE TEMPORARY VIEW/.test(s))).toBe(true);
    expect(engine.sqls.some((s) => /SELECT \* FROM sales WHERE price > 100/.test(s))).toBe(true);
  });

  it('rejects forbidden SQL and reports an error', async () => {
    const plan: Plan = {
      goal: 'g',
      assumptions: [],
      dataset_refs: ['sales'],
      steps: [
        { id: 's1', tool: 'sql', args: { query: 'DROP TABLE sales' }, why: 'bad' },
        { id: 's2', tool: 'render.summary', args: { text: 'x' }, why: 'final' },
      ],
    };
    const errs: unknown[] = [];
    await new Executor({ engine, datasets: [sales] }).execute(plan, 'pid', {
      onError: (e) => errs.push(e),
    });
    expect(errs).toHaveLength(1);
  });
});

describe('runner: geometry.buffer', () => {
  it('uses ST_Buffer with meters when units=meters', async () => {
    await runOneStep('geometry.buffer', { layer: 'sales', distance: 500, units: 'meters' });
    const view = engine.sqls.find((s) => /ST_Buffer/.test(s))!;
    expect(view).toBeDefined();
    expect(view).toContain('ST_Buffer(geom, 500)');
    expect(view).toContain('"sales_geom"');
  });

  it('converts kilometers to meters', async () => {
    await runOneStep('geometry.buffer', { layer: 'sales', distance: 2, units: 'kilometers' });
    const view = engine.sqls.find((s) => /ST_Buffer/.test(s))!;
    expect(view).toContain('ST_Buffer(geom, 2000)');
  });

  it('rejects datasets without geometry', async () => {
    const errs: unknown[] = [];
    const noGeom: DatasetEntry = {
      name: 'flat',
      tableName: 'flat',
      hasGeometry: false,
    };
    await new Executor({ engine, datasets: [noGeom] }).execute(
      {
        goal: 'g',
        assumptions: [],
        dataset_refs: ['flat'],
        steps: [
          { id: 's1', tool: 'geometry.buffer', args: { layer: 'flat', distance: 1, units: 'meters' }, why: 'no' },
          { id: 's2', tool: 'render.summary', args: { text: 'x' }, why: 'final' },
        ],
      },
      'pid',
      { onError: (e) => errs.push(e) },
    );
    expect(errs).toHaveLength(1);
  });

  it('rejects a non-layer OutputRef from a prior step (kind discriminator)', async () => {
    // Regression for NH3: a `kind:'table'` OutputRef (e.g. from
    // stats.aggregate) must not be silently accepted as a layer arg.
    // Without the kind check, DuckDB would throw an opaque binder error
    // on `<view>.geom` instead of a clean tool-level message.
    const errs: Array<{ message: string }> = [];
    const plan: Plan = {
      goal: 'g',
      assumptions: [],
      dataset_refs: ['sales'],
      steps: [
        // Aggregate produces a `kind:'table'` OutputRef.
        {
          id: 's1',
          tool: 'stats.aggregate',
          args: { layer: 'sales', group_by: 'region', value_col: 'amt', agg_fn: 'sum' },
          output_var: 'agg',
          why: 'a',
        },
        // Buffer expects a layer arg — passing the table-kind ref must fail clean.
        {
          id: 's2',
          tool: 'geometry.buffer',
          args: { layer: '${agg}', distance: 100, units: 'meters' },
          why: 'b',
        },
        { id: 's3', tool: 'render.summary', args: { text: 'x' }, why: 'final' },
      ],
    };
    await new Executor({ engine, datasets: [sales] }).execute(plan, 'pid', {
      onError: (e) => errs.push(e),
    });
    expect(errs).toHaveLength(1);
    expect(errs[0]!.message).toMatch(/expected layer OutputRef/i);
  });
});

describe('runner: geometry.centroid', () => {
  it('emits ST_Centroid', async () => {
    await runOneStep('geometry.centroid', { layer: 'sales' });
    expect(engine.sqls.some((s) => /ST_Centroid\(geom\)/.test(s))).toBe(true);
  });
});

describe('runner: geometry.intersect/union/difference', () => {
  it('intersect emits ST_Intersection', async () => {
    await runOneStep('geometry.intersect', { a: 'sales', b: 'hoods' });
    expect(engine.sqls.some((s) => /ST_Intersection/.test(s))).toBe(true);
  });
  it('union emits UNION ALL of geom', async () => {
    await runOneStep('geometry.union', { a: 'sales', b: 'hoods' });
    expect(engine.sqls.some((s) => /UNION ALL/.test(s))).toBe(true);
  });
  it('difference emits ST_Difference', async () => {
    await runOneStep('geometry.difference', { a: 'sales', b: 'hoods' });
    expect(engine.sqls.some((s) => /ST_Difference/.test(s))).toBe(true);
  });
});

describe('runner: geometry.dissolve / simplify / convex_hull', () => {
  it('dissolve uses ST_Union_Agg and groups when by_field given', async () => {
    await runOneStep('geometry.dissolve', { layer: 'sales', by_field: 'state' });
    const sql = engine.sqls.find((s) => /ST_Union_Agg/.test(s))!;
    expect(sql).toMatch(/GROUP BY "state"/);
  });
  it('simplify uses ST_Simplify with tolerance', async () => {
    await runOneStep('geometry.simplify', { layer: 'sales', tolerance: 0.01 });
    expect(engine.sqls.some((s) => /ST_Simplify\(geom, 0\.01\)/.test(s))).toBe(true);
  });
  it('convex_hull uses ST_ConvexHull', async () => {
    await runOneStep('geometry.convex_hull', { layer: 'sales', mode: 'convex' });
    expect(engine.sqls.some((s) => /ST_ConvexHull/.test(s))).toBe(true);
  });
});

describe('runner: joins.spatial_join', () => {
  it('uses ST_Within for predicate=within', async () => {
    await runOneStep('joins.spatial_join', { a: 'sales', b: 'hoods', predicate: 'within' });
    expect(engine.sqls.some((s) => /ST_Within\(a\.geom, b\.geom\)/.test(s))).toBe(true);
  });
  it('uses ST_Intersects for predicate=intersects', async () => {
    await runOneStep('joins.spatial_join', { a: 'sales', b: 'hoods', predicate: 'intersects' });
    expect(engine.sqls.some((s) => /ST_Intersects\(a\.geom, b\.geom\)/.test(s))).toBe(true);
  });
});

describe('runner: joins.point_in_polygon', () => {
  it('aliases to spatial_join with within predicate', async () => {
    await runOneStep('joins.point_in_polygon', { points: 'sales', polygons: 'hoods' });
    expect(engine.sqls.some((s) => /ST_Within\(a\.geom, b\.geom\)/.test(s))).toBe(true);
  });
});

describe('runner: joins.nearest_neighbor', () => {
  it('uses window function with rn <= k', async () => {
    await runOneStep('joins.nearest_neighbor', { a: 'sales', b: 'hoods', k: 3 });
    expect(engine.sqls.some((s) => /rn <= 3/.test(s))).toBe(true);
    expect(engine.sqls.some((s) => /ROW_NUMBER\(\)/.test(s))).toBe(true);
  });
});

describe('runner: stats.aggregate', () => {
  it('emits GROUP BY with the right agg fn', async () => {
    await runOneStep('stats.aggregate', {
      layer: 'sales',
      group_by: 'neighborhood',
      agg_fn: 'sum',
      value_col: 'price',
    });
    const sql = engine.sqls.find((s) => /GROUP BY "neighborhood"/.test(s))!;
    expect(sql).toContain('SUM("price")');
  });

  it('handles a multi-column group_by', async () => {
    await runOneStep('stats.aggregate', {
      layer: 'sales',
      group_by: ['city', 'state'],
      agg_fn: 'count',
      value_col: 'id',
    });
    const sql = engine.sqls.find((s) => /GROUP BY "city", "state"/.test(s))!;
    expect(sql).toBeDefined();
    expect(sql).toContain('COUNT("id")');
  });
});

describe('runner: stats.summary_stats', () => {
  it('emits a UNION ALL with one stats row per column', async () => {
    await runOneStep('stats.summary_stats', { layer: 'sales', columns: ['price', 'sqft'] });
    const sql = engine.sqls.find((s) => /UNION ALL/.test(s))!;
    expect(sql).toMatch(/'price'/);
    expect(sql).toMatch(/'sqft'/);
    expect(sql).toMatch(/STDDEV_POP/);
  });
});

describe('runner: stats.distance_matrix', () => {
  it('cross-joins and computes ST_Distance', async () => {
    await runOneStep('stats.distance_matrix', { a: 'sales', b: 'hoods' });
    const sql = engine.sqls.find((s) => /CROSS JOIN/.test(s))!;
    expect(sql).toContain('ST_Distance(a.geom, b.geom)');
  });
  it('caps to k smallest distances per a when k is given', async () => {
    await runOneStep('stats.distance_matrix', { a: 'sales', b: 'hoods', k: 5 });
    const sql = engine.sqls.find((s) => /rn <= 5/.test(s))!;
    expect(sql).toBeDefined();
  });
});

describe('runner: render.summary', () => {
  it('passes text through verbatim', async () => {
    const exec = new Executor({ engine, datasets: [sales] });
    let payload: any;
    await exec.execute(
      {
        goal: 'g',
        assumptions: [],
        dataset_refs: ['sales'],
        steps: [
          { id: 's1', tool: 'render.summary', args: { text: 'Hello.' }, why: 'final' },
        ],
      },
      'pid',
      { onResult: (e) => (payload = e) },
    );
    expect(payload).toMatchObject({ kind: 'summary', text: 'Hello.' });
  });
});

describe('runner: render.table', () => {
  it('returns rows + columns from the source view', async () => {
    engine.mockResponse = tableFromJSON([{ a: 1, b: 'x' }, { a: 2, b: 'y' }]);
    const exec = new Executor({ engine, datasets: [sales] });
    let payload: any;
    await exec.execute(
      {
        goal: 'g',
        assumptions: [],
        dataset_refs: ['sales'],
        steps: [
          { id: 's1', tool: 'render.table', args: { table: 'sales' }, why: 'final' },
        ],
      },
      'pid',
      { onResult: (e) => (payload = e) },
    );
    expect(payload.kind).toBe('table');
    expect(payload.rows).toHaveLength(2);
    expect(payload.columns).toContain('a');
    expect(payload.columns).toContain('b');
  });
});

describe('runner: render.chart', () => {
  it('builds a chart spec with kind/x/y/data', async () => {
    engine.mockResponse = tableFromJSON([
      { x: 'A', y: 10 },
      { x: 'B', y: 20 },
    ]);
    const exec = new Executor({ engine, datasets: [sales] });
    let payload: any;
    await exec.execute(
      {
        goal: 'g',
        assumptions: [],
        dataset_refs: ['sales'],
        steps: [
          {
            id: 's1',
            tool: 'render.chart',
            args: { table: 'sales', kind: 'bar', x: 'name', y: 'value' },
            why: 'final',
          },
        ],
      },
      'pid',
      { onResult: (e) => (payload = e) },
    );
    expect(payload).toMatchObject({
      kind: 'chart',
      spec: { kind: 'bar', x: 'name', y: 'value' },
    });
    expect(payload.spec.data).toHaveLength(2);
  });
});

describe('runner: render.map', () => {
  it('builds a GeoJSON FeatureCollection from ST_AsGeoJSON output', async () => {
    engine.mockResponse = tableFromJSON([
      { __geom_json__: '{"type":"Point","coordinates":[-82,29]}', name: 'A' },
    ]);
    const exec = new Executor({ engine, datasets: [sales] });
    let payload: any;
    await exec.execute(
      {
        goal: 'g',
        assumptions: [],
        dataset_refs: ['sales'],
        steps: [
          { id: 's1', tool: 'render.map', args: { layer: 'sales' }, why: 'final' },
        ],
      },
      'pid',
      { onResult: (e) => (payload = e) },
    );
    expect(payload.kind).toBe('layer');
    expect(payload.geojson.type).toBe('FeatureCollection');
    expect(payload.geojson.features).toHaveLength(1);
    expect(payload.geojson.features[0].geometry.type).toBe('Point');
    expect(payload.geojson.features[0].properties.name).toBe('A');
  });

  it('M7: payload.name uses step.output_var, not the internal view id', async () => {
    engine.mockResponse = tableFromJSON([
      { __geom_json__: '{"type":"Point","coordinates":[-82,29]}', name: 'A' },
    ]);
    const exec = new Executor({ engine, datasets: [sales] });
    let payload: any;
    await exec.execute(
      {
        goal: 'g',
        assumptions: [],
        dataset_refs: ['sales'],
        steps: [
          {
            id: 's1',
            tool: 'render.map',
            args: { layer: 'sales' },
            output_var: 'sales_layer',
            why: 'final',
          },
        ],
      },
      'pid',
      { onResult: (e) => (payload = e) },
    );
    expect(payload.name).toBe('sales_layer');
  });

  it('M7: falls back to logical layer name when output_var is absent', async () => {
    engine.mockResponse = tableFromJSON([
      { __geom_json__: '{"type":"Point","coordinates":[-82,29]}' },
    ]);
    const exec = new Executor({ engine, datasets: [sales] });
    let payload: any;
    await exec.execute(
      {
        goal: 'g',
        assumptions: [],
        dataset_refs: ['sales'],
        steps: [
          { id: 's1', tool: 'render.map', args: { layer: 'sales' }, why: 'final' },
        ],
      },
      'pid',
      { onResult: (e) => (payload = e) },
    );
    expect(payload.name).toBe('sales');
  });
});

describe('runner: render.summary (M2 length cap)', () => {
  it('rejects text over 10 KB', async () => {
    const tooLong = 'x'.repeat(10_001);
    const errs: unknown[] = [];
    await new Executor({ engine, datasets: [sales] }).execute(
      {
        goal: 'g',
        assumptions: [],
        dataset_refs: ['sales'],
        steps: [
          { id: 's1', tool: 'render.summary', args: { text: tooLong }, why: 'too long' },
        ],
      },
      'pid',
      { onError: (e) => errs.push(e) },
    );
    expect(errs).toHaveLength(1);
  });

  it('accepts text exactly at 10_000 chars', async () => {
    const justRight = 'x'.repeat(10_000);
    const results: unknown[] = [];
    await new Executor({ engine, datasets: [sales] }).execute(
      {
        goal: 'g',
        assumptions: [],
        dataset_refs: ['sales'],
        steps: [
          { id: 's1', tool: 'render.summary', args: { text: justRight }, why: 'ok' },
        ],
      },
      'pid',
      { onResult: (e) => results.push(e) },
    );
    expect(results).toHaveLength(1);
  });
});

describe('runner: render.table fallback (M6)', () => {
  it('retries without EXCLUDE only on missing-geom errors', async () => {
    let call = 0;
    const flakyEngine: ExecutorEngine = {
      hasSpatial: true,
      async query(sql: string) {
        call++;
        if (call === 1 && /EXCLUDE \(geom\)/.test(sql)) {
          throw new Error('Binder Error: Referenced column "geom" not found in FROM clause');
        }
        return tableFromJSON([{ id: 1 }]);
      },
    };
    const exec = new Executor({ engine: flakyEngine, datasets: [sales] });
    const results: unknown[] = [];
    await exec.execute(
      {
        goal: 'g',
        assumptions: [],
        dataset_refs: ['sales'],
        steps: [
          { id: 's1', tool: 'render.table', args: { table: 'sales' }, why: 'final' },
        ],
      },
      'pid',
      { onResult: (e) => results.push(e) },
    );
    expect(results).toHaveLength(1);
    expect(call).toBe(2);
  });

  it('does NOT retry on unrelated engine errors (e.g. engine offline)', async () => {
    let call = 0;
    const offlineEngine: ExecutorEngine = {
      hasSpatial: true,
      async query() {
        call++;
        throw new Error('engine offline');
      },
    };
    const exec = new Executor({ engine: offlineEngine, datasets: [sales] });
    const errs: Array<{ message: string }> = [];
    await exec.execute(
      {
        goal: 'g',
        assumptions: [],
        dataset_refs: ['sales'],
        steps: [
          { id: 's1', tool: 'render.table', args: { table: 'sales' }, why: 'final' },
        ],
      },
      'pid',
      { onError: (e) => errs.push(e) },
    );
    // Only one query attempt; the original error surfaces, not a misleading second one.
    expect(call).toBe(1);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.message).toBe('engine offline');
  });
});

describe('runner: render.map fallback (no geom + no lat/lon)', () => {
  it('returns a summary payload pointing at address columns when present', async () => {
    let call = 0;
    const engine2: ExecutorEngine = {
      hasSpatial: true,
      async query(sql: string) {
        call++;
        if (/EXCLUDE \(geom\)/.test(sql)) {
          throw new Error('Binder Error: Column "geom" in EXCLUDE list not found in FROM clause');
        }
        if (/pragma_table_info/i.test(sql)) {
          return tableFromJSON([
            { name: 'Address' },
            { name: 'First attempt' },
          ]);
        }
        return tableFromJSON([{ ok: 1 }]);
      },
    };
    const exec = new Executor({ engine: engine2, datasets: [sales] });
    let payload: any;
    await exec.execute(
      {
        goal: 'g',
        assumptions: [],
        dataset_refs: ['sales'],
        steps: [
          { id: 's1', tool: 'render.map', args: { layer: 'sales' }, why: 'final' },
        ],
      },
      'pid',
      { onResult: (e) => (payload = e) },
    );
    expect(payload.kind).toBe('summary');
    expect(payload.text).toMatch(/address-like columns/);
    expect(payload.text).toMatch(/"Address"/);
    expect(call).toBeGreaterThanOrEqual(2); // first try (EXCLUDE), then pragma_table_info
  });

  it('returns a non-mappable summary when no address columns either', async () => {
    const engine3: ExecutorEngine = {
      hasSpatial: true,
      async query(sql: string) {
        if (/EXCLUDE \(geom\)/.test(sql)) {
          throw new Error('Binder Error: Column "geom" in EXCLUDE list not found in FROM clause');
        }
        if (/pragma_table_info/i.test(sql)) {
          return tableFromJSON([{ name: 'price' }, { name: 'rating' }]);
        }
        return tableFromJSON([{ ok: 1 }]);
      },
    };
    const exec = new Executor({ engine: engine3, datasets: [sales] });
    let payload: any;
    await exec.execute(
      {
        goal: 'g',
        assumptions: [],
        dataset_refs: ['sales'],
        steps: [
          { id: 's1', tool: 'render.map', args: { layer: 'sales' }, why: 'final' },
        ],
      },
      'pid',
      { onResult: (e) => (payload = e) },
    );
    expect(payload.kind).toBe('summary');
    expect(payload.text).toMatch(/no geometry column, no lat\/lon columns, and no address-like columns/);
    expect(payload.text).toMatch(/"price"/);
  });

  it('drops null-geometry rows from the FeatureCollection', async () => {
    const engine4: ExecutorEngine = {
      hasSpatial: true,
      async query() {
        return tableFromJSON([
          { __geom_json__: '{"type":"Point","coordinates":[-82,29]}', name: 'A' },
          { __geom_json__: null, name: 'B' },
          { __geom_json__: '{"type":"Point","coordinates":[-82.5,29.5]}', name: 'C' },
        ]);
      },
    };
    const exec = new Executor({ engine: engine4, datasets: [sales] });
    let payload: any;
    await exec.execute(
      {
        goal: 'g',
        assumptions: [],
        dataset_refs: ['sales'],
        steps: [
          { id: 's1', tool: 'render.map', args: { layer: 'sales' }, why: 'final' },
        ],
      },
      'pid',
      { onResult: (e) => (payload = e) },
    );
    expect(payload.kind).toBe('layer');
    expect(payload.geojson.features).toHaveLength(2);
    expect(payload.geojson.features.map((f: any) => f.properties.name)).toEqual(['A', 'C']);
  });
});
