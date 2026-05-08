import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Table } from 'apache-arrow';
import { parquetLoader } from '../../src/data/loaders/parquet';

function fixture(name: string): { name: string; bytes: Uint8Array } {
  const buf = readFileSync(resolve(__dirname, '..', 'fixtures', name));
  return { name, bytes: new Uint8Array(buf) };
}

describe('parquetLoader', () => {
  it('loads points.parquet into an Arrow table with detected lat/lon', async () => {
    const result = await parquetLoader.load(fixture('points.parquet'));
    expect(result.table).toBeInstanceOf(Table);
    expect(result.table.numRows).toBe(5);
    const cols = result.table.schema.fields.map((f) => f.name);
    expect(cols).toEqual(expect.arrayContaining(['id', 'name', 'latitude', 'longitude', 'population']));
    expect(result.source).toBe('parquet');
    expect(result.geometry).toEqual({ kind: 'lonlat', lonColumn: 'longitude', latColumn: 'latitude' });
  });

  it('honors options.noGeometry', async () => {
    const result = await parquetLoader.load(fixture('points.parquet'), { noGeometry: true });
    expect(result.geometry).toBeUndefined();
  });

  it('throws EMPTY_FILE on an empty buffer', async () => {
    await expect(
      parquetLoader.load({ name: 'empty.parquet', bytes: new Uint8Array(0) }),
    ).rejects.toMatchObject({ code: 'EMPTY_FILE' });
  });

  it('canLoad recognizes parquet extension', () => {
    expect(parquetLoader.canLoad('a.parquet')).toBe(true);
    expect(parquetLoader.canLoad('a.csv')).toBe(false);
  });
});
