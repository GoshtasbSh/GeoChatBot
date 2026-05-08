/**
 * Internal helpers shared by the loaders. Not part of the public surface.
 */
import type { BinaryInput, GeometryEncoding, LoaderOptions } from '../contracts';
import { LoaderError } from '../contracts';

export function stripExt(name: string): string {
  return name.replace(/\.[^./\\]+$/, '');
}

export function sanitizeIdent(raw: string): string {
  let s = (raw ?? '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) s = `t_${Math.random().toString(36).slice(2, 10)}`;
  if (/^[0-9]/.test(s)) s = `t_${s}`;
  return s;
}

export function deriveTableName(filename: string, override?: string): string {
  return sanitizeIdent(override ?? stripExt(filename));
}

export async function toArrayBuffer(file: BinaryInput): Promise<{ name: string; buffer: ArrayBuffer }> {
  if (typeof File !== 'undefined' && file instanceof File) {
    const buf = await file.arrayBuffer();
    return { name: file.name, buffer: buf };
  }
  const f = file as { name: string; bytes: Uint8Array | ArrayBuffer };
  let buffer: ArrayBuffer;
  if (f.bytes instanceof ArrayBuffer) {
    buffer = f.bytes;
  } else {
    // copy into a fresh ArrayBuffer to drop any SharedArrayBuffer typing
    const u = f.bytes as Uint8Array;
    const ab = new ArrayBuffer(u.byteLength);
    new Uint8Array(ab).set(u);
    buffer = ab;
  }
  return { name: f.name, buffer };
}

export function assertNonEmpty(buffer: ArrayBuffer, filename: string): void {
  if (!buffer || buffer.byteLength === 0) {
    throw new LoaderError('EMPTY_FILE', `${filename}: file is empty.`);
  }
}

const LAT_NAMES = ['latitude', 'lat', 'y'];
const LON_NAMES = ['longitude', 'lon', 'lng', 'long', 'x'];

function findColumn(columns: string[], candidates: string[]): string | undefined {
  const lower = columns.map((c) => ({ orig: c, lc: c.toLowerCase() }));
  for (const cand of candidates) {
    const m = lower.find((c) => c.lc === cand);
    if (m) return m.orig;
  }
  return undefined;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Detect lat/lon geometry in tabular row data.
 * Returns a `lonlat` GeometryEncoding when both columns are present, numeric,
 * and within plausible WGS84 ranges. Honors options.latColumn/lonColumn
 * overrides and options.noGeometry.
 */
export function detectLatLon(
  rows: ReadonlyArray<Record<string, unknown>>,
  options: LoaderOptions = {},
): GeometryEncoding | undefined {
  if (options.noGeometry) return undefined;
  if (!rows || rows.length === 0) return undefined;
  const columns = Object.keys(rows[0] ?? {});
  if (columns.length === 0) return undefined;

  const latColumn = options.latColumn ?? findColumn(columns, LAT_NAMES);
  const lonColumn = options.lonColumn ?? findColumn(columns, LON_NAMES);
  if (!latColumn || !lonColumn) return undefined;
  if (!columns.includes(latColumn) || !columns.includes(lonColumn)) return undefined;

  // Sample first 50 non-null rows; require all to be numeric and in range.
  const sample: Array<{ lat: unknown; lon: unknown }> = [];
  for (const row of rows) {
    if (sample.length >= 50) break;
    const lat = row[latColumn];
    const lon = row[lonColumn];
    if (lat == null && lon == null) continue;
    sample.push({ lat, lon });
  }
  if (sample.length === 0) return undefined;
  for (const { lat, lon } of sample) {
    const latN = typeof lat === 'string' ? Number(lat) : lat;
    const lonN = typeof lon === 'string' ? Number(lon) : lon;
    if (!isFiniteNumber(latN) || !isFiniteNumber(lonN)) return undefined;
    if (latN < -90 || latN > 90) return undefined;
    if (lonN < -180 || lonN > 180) return undefined;
  }
  return { kind: 'lonlat', lonColumn, latColumn };
}

/**
 * Normalize rows so every row has every column key (apache-arrow's tableFromJSON
 * infers schema from the first row). Coerces undefined → null.
 */
export function normalizeRows(rows: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> {
  if (!rows || rows.length === 0) return [];
  const keys = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) keys.add(k);
  const cols = Array.from(keys);
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const k of cols) out[k] = r[k] ?? null;
    return out;
  });
}
