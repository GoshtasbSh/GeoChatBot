import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Table } from 'apache-arrow';
import { geojsonLoader } from '../../src/data/loaders/geojson';

function fixture(name: string): { name: string; bytes: Uint8Array } {
  const buf = readFileSync(resolve(__dirname, '..', 'fixtures', name));
  return { name, bytes: new Uint8Array(buf) };
}

describe('geojsonLoader', () => {
  it('loads a FeatureCollection into Arrow with geometry as JSON string', async () => {
    const result = await geojsonLoader.load(fixture('points.geojson'));
    expect(result.table).toBeInstanceOf(Table);
    expect(result.table.numRows).toBe(3);
    const cols = result.table.schema.fields.map((f) => f.name);
    expect(cols).toEqual(expect.arrayContaining(['name', 'value', 'geometry']));
    expect(result.geometry).toEqual({ kind: 'geojson-string', column: 'geometry' });
    expect(result.source).toBe('geojson');

    // First geometry should be parseable JSON
    const first = result.table.getChild('geometry')?.get(0);
    expect(typeof first).toBe('string');
    const parsed = JSON.parse(first as string);
    expect(parsed.type).toBe('Point');
    expect(parsed.coordinates).toEqual([-82.3248, 29.6516]);
  });

  it('wraps a single Feature into a one-row table', async () => {
    const single = JSON.stringify({
      type: 'Feature',
      properties: { name: 'X' },
      geometry: { type: 'Point', coordinates: [0, 0] },
    });
    const result = await geojsonLoader.load({
      name: 'one.geojson',
      bytes: new TextEncoder().encode(single),
    });
    expect(result.table.numRows).toBe(1);
    expect(result.geometry?.kind).toBe('geojson-string');
  });

  it('throws INVALID_GEOMETRY when there are no features', async () => {
    const empty = JSON.stringify({ type: 'FeatureCollection', features: [] });
    await expect(
      geojsonLoader.load({ name: 'empty.geojson', bytes: new TextEncoder().encode(empty) }),
    ).rejects.toMatchObject({ code: 'INVALID_GEOMETRY' });
  });

  it('throws EMPTY_FILE on an empty buffer', async () => {
    await expect(
      geojsonLoader.load({ name: 'empty.geojson', bytes: new Uint8Array(0) }),
    ).rejects.toMatchObject({ code: 'EMPTY_FILE' });
  });

  it('honors options.tableName', async () => {
    const result = await geojsonLoader.load(fixture('points.geojson'), { tableName: 'my-points' });
    expect(result.name).toBe('my_points');
  });
});
