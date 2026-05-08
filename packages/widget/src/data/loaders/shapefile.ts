import { tableFromJSON } from 'apache-arrow';
import { parse } from '@loaders.gl/core';
import { SHPLoader, DBFLoader } from '@loaders.gl/shapefile';
import { convertBinaryGeometryToGeometry } from '@loaders.gl/gis';
import JSZip from 'jszip';
import type { BinaryInput, DataLoader, LoaderOptions, LoadResult } from '../contracts';
import { LoaderError } from '../contracts';
import { assertNonEmpty, deriveTableName, normalizeRows, toArrayBuffer } from './_util';

const EXT_RE = /\.(zip|shp)$/i;

export const shapefileLoader: DataLoader = {
  id: 'shapefile',
  canLoad(filename: string): boolean {
    return EXT_RE.test(filename);
  },
  async load(file: BinaryInput, options: LoaderOptions = {}): Promise<LoadResult> {
    const { name, buffer } = await toArrayBuffer(file);
    assertNonEmpty(buffer, name);

    const isZip = /\.zip$/i.test(name);
    let shpBuf: ArrayBuffer | undefined;
    let dbfBuf: ArrayBuffer | undefined;

    if (isZip) {
      try {
        const zip = await JSZip.loadAsync(buffer);
        const entries: Array<[string, JSZip.JSZipObject]> = [];
        zip.forEach((path, entry) => {
          if (!entry.dir) entries.push([path, entry]);
        });
        const findExt = (ext: string) =>
          entries.find(([p]) => p.toLowerCase().endsWith(ext))?.[1];
        const shpEntry = findExt('.shp');
        const dbfEntry = findExt('.dbf');
        if (!shpEntry) {
          throw new LoaderError('PARSE_ERROR', `${name}: zip does not contain a .shp file.`);
        }
        shpBuf = await shpEntry.async('arraybuffer');
        if (dbfEntry) {
          dbfBuf = await dbfEntry.async('arraybuffer');
        }
      } catch (err) {
        if (err instanceof LoaderError) throw err;
        throw new LoaderError('PARSE_ERROR', `Failed to extract ${name}: ${describe(err)}`, { cause: err });
      }
    } else {
      // raw .shp upload — no companion DBF available
      shpBuf = buffer;
    }

    if (!shpBuf || shpBuf.byteLength === 0) {
      throw new LoaderError('EMPTY_FILE', `${name}: empty .shp content.`);
    }

    let shpResult: { geometries: unknown[] };
    try {
      shpResult = (await parse(shpBuf, SHPLoader, { worker: false } as never)) as { geometries: unknown[] };
    } catch (err) {
      throw new LoaderError('PARSE_ERROR', `SHP parse failed for ${name}: ${describe(err)}`, { cause: err });
    }
    const geometries = Array.isArray(shpResult?.geometries) ? shpResult.geometries : [];
    if (geometries.length === 0) {
      throw new LoaderError('INVALID_GEOMETRY', `${name}: no geometries found in shapefile.`);
    }

    let propertyRows: Array<Record<string, unknown>> = [];
    if (dbfBuf && dbfBuf.byteLength > 0) {
      try {
        const dbfParsed = (await parse(dbfBuf, DBFLoader, {
          worker: false,
          dbf: { shape: 'object-row-table', encoding: 'latin1' },
        } as never)) as unknown;
        propertyRows = extractRows(dbfParsed);
      } catch (err) {
        throw new LoaderError('PARSE_ERROR', `DBF parse failed for ${name}: ${describe(err)}`, { cause: err });
      }
    }

    const rows: Array<Record<string, unknown>> = geometries.map((g, i) => {
      let geojson: unknown = null;
      try {
        geojson = convertBinaryGeometryToGeometry(g as never);
      } catch {
        geojson = null;
      }
      const props = propertyRows[i] ?? {};
      return {
        ...props,
        geometry: geojson == null ? null : JSON.stringify(geojson),
      };
    });

    const normalized = normalizeRows(rows);
    let table;
    try {
      table = tableFromJSON(normalized as Record<string, unknown>[]);
    } catch (err) {
      throw new LoaderError('PARSE_ERROR', `Shapefile → Arrow conversion failed for ${name}: ${describe(err)}`, { cause: err });
    }

    return {
      name: deriveTableName(name, options.tableName),
      table,
      geometry: { kind: 'geojson-string', column: 'geometry' },
      source: 'shapefile',
      filename: name,
    };
  },
};

function extractRows(parsed: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { data?: unknown }).data)) {
    return (parsed as { data: Array<Record<string, unknown>> }).data;
  }
  return [];
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
