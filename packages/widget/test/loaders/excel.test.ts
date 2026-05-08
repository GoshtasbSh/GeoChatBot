import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Table } from 'apache-arrow';
import { excelLoader } from '../../src/data/loaders/excel';

function fixture(name: string): { name: string; bytes: Uint8Array } {
  const buf = readFileSync(resolve(__dirname, '..', 'fixtures', name));
  return { name, bytes: new Uint8Array(buf) };
}

describe('excelLoader', () => {
  it('loads points.xlsx into an Arrow table with detected lat/lon', async () => {
    const result = await excelLoader.load(fixture('points.xlsx'));
    expect(result.table).toBeInstanceOf(Table);
    expect(result.table.numRows).toBe(5);
    const cols = result.table.schema.fields.map((f) => f.name);
    expect(cols).toEqual(expect.arrayContaining(['id', 'name', 'latitude', 'longitude', 'population']));
    expect(result.source).toBe('excel');
    expect(result.geometry).toEqual({ kind: 'lonlat', lonColumn: 'longitude', latColumn: 'latitude' });
  });

  it('honors options.noGeometry', async () => {
    const result = await excelLoader.load(fixture('points.xlsx'), { noGeometry: true });
    expect(result.geometry).toBeUndefined();
  });

  it('throws EMPTY_FILE on an empty buffer', async () => {
    await expect(
      excelLoader.load({ name: 'empty.xlsx', bytes: new Uint8Array(0) }),
    ).rejects.toMatchObject({ code: 'EMPTY_FILE' });
  });

  it('canLoad recognizes xlsx/xls', () => {
    expect(excelLoader.canLoad('a.xlsx')).toBe(true);
    expect(excelLoader.canLoad('a.xls')).toBe(true);
    expect(excelLoader.canLoad('a.csv')).toBe(false);
  });
});
