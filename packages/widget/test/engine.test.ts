import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tableFromJSON } from 'apache-arrow';

import { DuckDBEngine, getEngine, __resetEngineForTests } from '../src/data/engine/index.js';
import type { LoadResult } from '../src/data/contracts.js';

/**
 * duckdb-wasm needs a real `Worker` global. The default vitest 'node'
 * environment does not provide one, so the heavyweight engine tests are
 * skipped in that environment. They run as soon as the suite is executed
 * in a browser-capable environment (e.g. happy-dom or jsdom with worker
 * polyfill).
 */
function canBootDuckdbInNode(): boolean {
  return typeof Worker !== 'undefined' && typeof URL !== 'undefined' && typeof Blob !== 'undefined';
}

describe('DuckDBEngine — API shape (always runs)', () => {
  it('is constructable', () => {
    const eng = new DuckDBEngine();
    expect(eng).toBeInstanceOf(DuckDBEngine);
    expect(typeof eng.init).toBe('function');
    expect(typeof eng.registerArrow).toBe('function');
    expect(typeof eng.query).toBe('function');
    expect(typeof eng.listTables).toBe('function');
    expect(typeof eng.drop).toBe('function');
    expect(typeof eng.dispose).toBe('function');
  });

  it('listTables() starts empty', () => {
    const eng = new DuckDBEngine();
    expect(eng.listTables()).toEqual([]);
  });

  it('dispose() is safe on a never-initialized engine (idempotent)', async () => {
    const eng = new DuckDBEngine();
    await eng.dispose();
    await eng.dispose();
    expect(eng.listTables()).toEqual([]);
  });

  it('getEngine() returns a singleton', () => {
    __resetEngineForTests();
    const a = getEngine();
    const b = getEngine();
    expect(a).toBe(b);
    __resetEngineForTests();
  });
});

const describeIfCanBoot = canBootDuckdbInNode() ? describe : describe.skip;

// TODO: enable when running in browser env (happy-dom / jsdom + Worker polyfill).
describeIfCanBoot('DuckDBEngine — real engine (requires Worker)', () => {
  let eng: DuckDBEngine;

  beforeAll(async () => {
    eng = new DuckDBEngine();
    await eng.init();
  });

  afterAll(async () => {
    if (eng) await eng.dispose();
  });

  it('init() is idempotent', async () => {
    await eng.init();
    await eng.init();
    await Promise.all([eng.init(), eng.init()]);
    // If we reach here, no throw.
    expect(true).toBe(true);
  });

  it('registers an Arrow table and counts rows', async () => {
    const table = tableFromJSON([
      { a: 1, b: 2 },
      { a: 3, b: 4 },
    ]);
    const { tableName } = await eng.registerArrow({
      name: 'demo',
      table,
      source: 'csv',
      filename: 'demo.csv',
    } satisfies LoadResult);
    expect(tableName).toBe('demo');
    expect(eng.listTables()).toContain('demo');

    const result = await eng.query(`SELECT COUNT(*)::INT AS n FROM "${tableName}"`);
    const rows = result.toArray();
    expect(rows).toHaveLength(1);
    expect(Number((rows[0] as { n: number }).n)).toBe(2);
  });

  it('builds a geom view for lonlat geometry', async () => {
    const table = tableFromJSON([
      { id: 1, lon: -82.5, lat: 29.65 },
      { id: 2, lon: -83.0, lat: 30.0 },
    ]);
    const { tableName, geomView } = await eng.registerArrow({
      name: 'pts',
      table,
      source: 'csv',
      filename: 'pts.csv',
      geometry: { kind: 'lonlat', lonColumn: 'lon', latColumn: 'lat' },
    } satisfies LoadResult);
    expect(tableName).toBe('pts');

    if (!eng.hasSpatial) {
      // Spatial unavailable: the view should NOT have been created. Loaders
      // can still query the base table.
      expect(geomView).toBeUndefined();
      return;
    }

    expect(geomView).toBe('pts_geom');
    const result = await eng.query(
      `SELECT ST_X(geom) AS x, ST_Y(geom) AS y FROM "${geomView}" ORDER BY id LIMIT 1`,
    );
    const row = result.toArray()[0] as { x: number; y: number };
    expect(Number(row.x)).toBeCloseTo(-82.5, 5);
    expect(Number(row.y)).toBeCloseTo(29.65, 5);
  });

  it('drop() removes both base table and geom view', async () => {
    const table = tableFromJSON([{ lon: 0, lat: 0 }]);
    const { tableName, geomView } = await eng.registerArrow({
      name: 'tmp',
      table,
      source: 'csv',
      filename: 'tmp.csv',
      geometry: { kind: 'lonlat', lonColumn: 'lon', latColumn: 'lat' },
    } satisfies LoadResult);
    expect(eng.listTables()).toContain(tableName);

    await eng.drop(tableName);
    expect(eng.listTables()).not.toContain(tableName);

    await expect(eng.query(`SELECT * FROM "${tableName}"`)).rejects.toBeDefined();
    if (geomView) {
      await expect(eng.query(`SELECT * FROM "${geomView}"`)).rejects.toBeDefined();
    }
  });

  it('listTables() reflects registrations', async () => {
    // Clean slate: anything registered above will already be dropped or named.
    const before = new Set(eng.listTables());
    const table = tableFromJSON([{ x: 1 }]);
    await eng.registerArrow({
      name: 'rt_test',
      table,
      source: 'csv',
      filename: 'rt.csv',
    });
    expect(eng.listTables()).toContain('rt_test');
    await eng.drop('rt_test');
    expect(new Set(eng.listTables())).toEqual(before);
  });
});
