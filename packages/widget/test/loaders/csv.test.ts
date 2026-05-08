import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Table } from 'apache-arrow';
import { csvLoader } from '../../src/data/loaders/csv';
import { LoaderError } from '../../src/data/contracts';

function fixture(name: string): { name: string; bytes: Uint8Array } {
  const buf = readFileSync(resolve(__dirname, '..', 'fixtures', name));
  return { name, bytes: new Uint8Array(buf) };
}

describe('csvLoader', () => {
  it('loads points.csv into an Arrow table with detected lat/lon', async () => {
    const result = await csvLoader.load(fixture('points.csv'));
    expect(result.table).toBeInstanceOf(Table);
    expect(result.table.numRows).toBe(5);
    const cols = result.table.schema.fields.map((f) => f.name);
    expect(cols).toEqual(expect.arrayContaining(['id', 'name', 'latitude', 'longitude', 'population']));
    expect(result.geometry).toEqual({ kind: 'lonlat', lonColumn: 'longitude', latColumn: 'latitude' });
    expect(result.source).toBe('csv');
    expect(result.name).toBe('points');
  });

  it('returns no geometry when columns lack lat/lon', async () => {
    const result = await csvLoader.load(fixture('no_geo.csv'));
    expect(result.table.numRows).toBe(3);
    expect(result.geometry).toBeUndefined();
  });

  it('honors options.tableName and options.noGeometry', async () => {
    const result = await csvLoader.load(fixture('points.csv'), {
      tableName: '2bad name!',
      noGeometry: true,
    });
    expect(result.geometry).toBeUndefined();
    // sanitized + prefixed because it started with a digit
    expect(result.name).toMatch(/^t_2bad_name/);
  });

  it('throws EMPTY_FILE on an empty buffer', async () => {
    await expect(
      csvLoader.load({ name: 'empty.csv', bytes: new Uint8Array(0) }),
    ).rejects.toMatchObject({ name: 'LoaderError', code: 'EMPTY_FILE' });
  });

  it('canLoad recognizes csv and tsv extensions', () => {
    expect(csvLoader.canLoad('foo.csv')).toBe(true);
    expect(csvLoader.canLoad('foo.tsv')).toBe(true);
    expect(csvLoader.canLoad('foo.txt')).toBe(false);
  });

  it('LoaderError is the error class used', async () => {
    try {
      await csvLoader.load({ name: 'empty.csv', bytes: new Uint8Array(0) });
    } catch (err) {
      expect(err).toBeInstanceOf(LoaderError);
    }
  });
});
