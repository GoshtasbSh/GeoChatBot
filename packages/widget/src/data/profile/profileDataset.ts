/**
 * profileDataset — compute a typed JSON summary (DatasetProfile) from a LoadResult.
 *
 * v1 design:
 *   - One pass over Arrow vectors via vector.get(i); samples min(rowCount, sampleSize) rows.
 *   - Numeric: streaming min/max/mean (Welford). Integer/float treated identically here.
 *   - String: top-K via Map with periodic compaction so memory stays O(k).
 *   - Date / Timestamp: track min/max as ISO strings.
 *   - Geometry bbox:
 *       lonlat          → scan lon/lat columns directly
 *       geojson-string  → JSON.parse, recursive coord walk; tolerate parse errors per row
 *       wkb             → skipped in v1 (bbox undefined, crsGuess unknown)
 */

import {
  type DataType,
  type Field,
  type Table as ArrowTable,
  type Vector,
  Type as ArrowType,
} from 'apache-arrow';

import type {
  CategoricalStats,
  ColumnProfile,
  DatasetProfile,
  DateRange,
  GeometryProfile,
  LoadResult,
  NumericStats,
  ProfileColumnKind,
} from '../contracts.js';

export interface ProfileOptions {
  /** Max rows to scan for stats. Default: 50_000 (full scan if rowCount smaller). */
  sampleSize?: number;
  /** Max distinct values tracked per categorical column. Default: 10. */
  topK?: number;
}

const DEFAULT_SAMPLE_SIZE = 50_000;
const DEFAULT_TOP_K = 10;

const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

/* ------------------------------------------------------------------ */
/* Type classification                                                */
/* ------------------------------------------------------------------ */

function classifyKind(field: Field, geometryColumn: string | undefined): ProfileColumnKind {
  if (geometryColumn && field.name === geometryColumn) {
    return 'geometry';
  }
  let t = field.type as DataType;
  // Unwrap Dictionary<*, ValueType> — apache-arrow's tableFromJSON encodes
  // strings as Dictionary<Int32, Utf8>, so classify by the underlying value type.
  if (t.typeId === ArrowType.Dictionary) {
    const dict = t as unknown as { dictionary?: DataType };
    if (dict.dictionary) t = dict.dictionary;
  }
  switch (t.typeId) {
    case ArrowType.Int:
      return 'integer';
    case ArrowType.Float:
    case ArrowType.Decimal:
      return 'float';
    case ArrowType.Bool:
      return 'boolean';
    case ArrowType.Utf8:
    case ArrowType.LargeUtf8:
      return 'string';
    case ArrowType.Date:
      return 'date';
    case ArrowType.Timestamp:
      return 'timestamp';
    case ArrowType.Binary:
    case ArrowType.LargeBinary:
    case ArrowType.FixedSizeBinary:
      return 'binary';
    default:
      return 'other';
  }
}

function arrowTypeString(field: Field): string {
  const t = field.type as DataType;
  // toString() on Arrow DataType usually returns something like "Float64" / "Utf8".
  try {
    const s = String(t);
    if (s && s !== '[object Object]') return s;
  } catch {
    /* fall through */
  }
  return ArrowType[t.typeId] ?? 'Unknown';
}

/* ------------------------------------------------------------------ */
/* Helpers for date/timestamp coercion                                */
/* ------------------------------------------------------------------ */

function toIsoFromValue(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'bigint') {
    const ms = Number(value);
    if (!Number.isFinite(ms)) return null;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Top-K map with periodic compaction                                  */
/* ------------------------------------------------------------------ */

function compactTopK(map: Map<string, number>, topK: number): void {
  // Sort entries by count desc, keep top K.
  const entries = [...map.entries()].sort((a, b) => b[1] - a[1]);
  map.clear();
  for (let i = 0; i < Math.min(topK, entries.length); i++) {
    const entry = entries[i];
    if (!entry) continue;
    map.set(entry[0], entry[1]);
  }
}

function topKFromMap(map: Map<string, number>, topK: number): CategoricalStats['top'] {
  const entries = [...map.entries()].sort((a, b) => b[1] - a[1]);
  return entries.slice(0, topK).map(([value, count]) => ({ value, count }));
}

/* ------------------------------------------------------------------ */
/* Per-column scanning                                                */
/* ------------------------------------------------------------------ */

interface ColumnScanState {
  nullCount: number;
  // Numeric
  numCount: number;
  numMin: number;
  numMax: number;
  numMean: number;
  // Categorical
  cat: Map<string, number>;
  catDistinctSeen: number; // size of map at peak (approx distinct)
  // Date/timestamp
  rangeCount: number;
  rangeMin: number; // ms
  rangeMax: number; // ms
}

function newScanState(): ColumnScanState {
  return {
    nullCount: 0,
    numCount: 0,
    numMin: Number.POSITIVE_INFINITY,
    numMax: Number.NEGATIVE_INFINITY,
    numMean: 0,
    cat: new Map(),
    catDistinctSeen: 0,
    rangeCount: 0,
    rangeMin: Number.POSITIVE_INFINITY,
    rangeMax: Number.NEGATIVE_INFINITY,
  };
}

/* ------------------------------------------------------------------ */
/* Geometry bbox computation                                          */
/* ------------------------------------------------------------------ */

interface BBoxAccumulator {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  count: number;
}

function newBBox(): BBoxAccumulator {
  return {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    count: 0,
  };
}

function pushCoord(acc: BBoxAccumulator, x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (x < acc.minX) acc.minX = x;
  if (y < acc.minY) acc.minY = y;
  if (x > acc.maxX) acc.maxX = x;
  if (y > acc.maxY) acc.maxY = y;
  return true;
}

function walkCoords(coords: unknown, acc: BBoxAccumulator): boolean {
  if (!Array.isArray(coords) || coords.length === 0) return false;
  // A coordinate is [x, y, ...numbers]; otherwise it's a nested array.
  if (typeof coords[0] === 'number') {
    const x = coords[0] as number;
    const y = (coords[1] as number) ?? Number.NaN;
    return pushCoord(acc, x, y);
  }
  let any = false;
  for (const c of coords) {
    if (walkCoords(c, acc)) any = true;
  }
  return any;
}

function walkGeoJson(geom: unknown, acc: BBoxAccumulator): boolean {
  if (!geom || typeof geom !== 'object') return false;
  const g = geom as { type?: string; coordinates?: unknown; geometries?: unknown[] };
  if (g.type === 'GeometryCollection' && Array.isArray(g.geometries)) {
    let any = false;
    for (const sub of g.geometries) {
      if (walkGeoJson(sub, acc)) any = true;
    }
    return any;
  }
  if (g.coordinates !== undefined) return walkCoords(g.coordinates, acc);
  return false;
}

function isWgs84Range(minX: number, minY: number, maxX: number, maxY: number): boolean {
  return minX >= -180 && maxX <= 180 && minY >= -90 && maxY <= 90;
}

function isClearlyProjected(minX: number, minY: number, maxX: number, maxY: number): boolean {
  return Math.abs(minX) > 180 || Math.abs(maxX) > 180 || Math.abs(minY) > 90 || Math.abs(maxY) > 90;
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */

export function profileDataset(result: LoadResult, options: ProfileOptions = {}): DatasetProfile {
  const t0 = now();
  const sampleSize = options.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  const topK = options.topK ?? DEFAULT_TOP_K;

  const table: ArrowTable = result.table;
  const rowCount = table.numRows;
  const scanRows = Math.min(rowCount, sampleSize);

  const geometry = result.geometry;
  const geomColumnName =
    geometry && geometry.kind !== 'lonlat' ? geometry.column : undefined;

  const fields = table.schema.fields;
  const states = new Map<string, ColumnScanState>();
  const vectors = new Map<string, Vector | null>();
  const kinds = new Map<string, ProfileColumnKind>();

  for (const field of fields) {
    states.set(field.name, newScanState());
    kinds.set(field.name, classifyKind(field, geomColumnName));
    vectors.set(field.name, table.getChild(field.name) ?? null);
  }

  const compactionInterval = topK * 10;

  // Single pass row-major over sampled rows.
  for (let rowIdx = 0; rowIdx < scanRows; rowIdx++) {
    for (const field of fields) {
      const state = states.get(field.name)!;
      const kind = kinds.get(field.name)!;
      const vec = vectors.get(field.name);
      if (!vec) {
        state.nullCount++;
        continue;
      }

      const value: unknown = vec.get(rowIdx);
      if (value == null) {
        state.nullCount++;
        continue;
      }

      switch (kind) {
        case 'integer':
        case 'float': {
          const n =
            typeof value === 'bigint'
              ? Number(value)
              : typeof value === 'number'
                ? value
                : Number(value);
          if (!Number.isFinite(n)) {
            // Treat NaN/Infinity as skipped (not null) for stats, but don't bump nullCount.
            break;
          }
          state.numCount++;
          if (n < state.numMin) state.numMin = n;
          if (n > state.numMax) state.numMax = n;
          // Welford's running mean
          const delta = n - state.numMean;
          state.numMean += delta / state.numCount;
          break;
        }
        case 'string': {
          const s = typeof value === 'string' ? value : String(value);
          state.cat.set(s, (state.cat.get(s) ?? 0) + 1);
          if (state.cat.size > state.catDistinctSeen) {
            state.catDistinctSeen = state.cat.size;
          }
          if (state.cat.size > compactionInterval) {
            compactTopK(state.cat, topK);
          }
          break;
        }
        case 'date':
        case 'timestamp': {
          const iso = toIsoFromValue(value);
          if (!iso) break;
          const ms = new Date(iso).getTime();
          if (!Number.isFinite(ms)) break;
          state.rangeCount++;
          if (ms < state.rangeMin) state.rangeMin = ms;
          if (ms > state.rangeMax) state.rangeMax = ms;
          break;
        }
        default:
          // boolean / binary / geometry / other — only nullCount matters.
          break;
      }
    }
  }

  // Build ColumnProfile[].
  const columns: ColumnProfile[] = fields.map((field) => {
    const state = states.get(field.name)!;
    const kind = kinds.get(field.name)!;

    const profile: ColumnProfile = {
      name: field.name,
      kind,
      arrowType: arrowTypeString(field),
      nullable: field.nullable,
      nullCount: state.nullCount,
    };

    if ((kind === 'integer' || kind === 'float') && state.numCount > 0) {
      const numeric: NumericStats = {
        min: state.numMin,
        max: state.numMax,
        mean: state.numMean,
        count: state.numCount,
      };
      profile.numeric = numeric;
    }

    if (kind === 'string') {
      const top = topKFromMap(state.cat, topK);
      // distinct: when the table fully fit and we never compacted, this is exact;
      // otherwise an approximation (catDistinctSeen is the lower bound peak).
      const distinct = Math.max(state.cat.size, state.catDistinctSeen);
      const categorical: CategoricalStats = { top, distinct };
      profile.categorical = categorical;
    }

    if ((kind === 'date' || kind === 'timestamp') && state.rangeCount > 0) {
      const range: DateRange = {
        min: new Date(state.rangeMin).toISOString(),
        max: new Date(state.rangeMax).toISOString(),
        count: state.rangeCount,
      };
      profile.range = range;
    }

    return profile;
  });

  // Geometry profile.
  let geometryProfile: GeometryProfile | undefined;
  if (geometry) {
    geometryProfile = computeGeometryProfile(table, geometry, scanRows);
  }

  const profileMs = Math.max(0, now() - t0);

  return {
    name: result.name,
    source: result.source,
    rowCount,
    columns,
    ...(geometryProfile ? { geometry: geometryProfile } : {}),
    profileMs,
  };
}

function computeGeometryProfile(
  table: ArrowTable,
  geometry: NonNullable<LoadResult['geometry']>,
  scanRows: number,
): GeometryProfile {
  if (geometry.kind === 'lonlat') {
    const lonVec = table.getChild(geometry.lonColumn);
    const latVec = table.getChild(geometry.latColumn);
    const acc = newBBox();
    if (lonVec && latVec) {
      for (let i = 0; i < scanRows; i++) {
        const lon = lonVec.get(i) as unknown;
        const lat = latVec.get(i) as unknown;
        if (lon == null || lat == null) continue;
        const x = typeof lon === 'number' ? lon : Number(lon);
        const y = typeof lat === 'number' ? lat : Number(lat);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        pushCoord(acc, x, y);
        acc.count++;
      }
    }
    const hasBox = acc.count > 0 && Number.isFinite(acc.minX);
    return {
      column: `${geometry.lonColumn},${geometry.latColumn}`,
      encoding: 'lonlat',
      ...(hasBox
        ? { bbox: [acc.minX, acc.minY, acc.maxX, acc.maxY] as [number, number, number, number] }
        : {}),
      sampledCount: acc.count,
      crsGuess: 'wgs84',
    };
  }

  if (geometry.kind === 'geojson-string') {
    const vec = table.getChild(geometry.column);
    const acc = newBBox();
    if (vec) {
      for (let i = 0; i < scanRows; i++) {
        const raw = vec.get(i) as unknown;
        if (raw == null) continue;
        const str = typeof raw === 'string' ? raw : String(raw);
        let parsed: unknown;
        try {
          parsed = JSON.parse(str);
        } catch {
          continue;
        }
        if (walkGeoJson(parsed, acc)) {
          acc.count++;
        }
      }
    }
    const hasBox = acc.count > 0 && Number.isFinite(acc.minX);
    let crsGuess: GeometryProfile['crsGuess'] = 'unknown';
    if (hasBox) {
      if (isClearlyProjected(acc.minX, acc.minY, acc.maxX, acc.maxY)) {
        crsGuess = 'projected';
      } else if (isWgs84Range(acc.minX, acc.minY, acc.maxX, acc.maxY)) {
        crsGuess = 'wgs84';
      }
    }
    return {
      column: geometry.column,
      encoding: 'geojson-string',
      ...(hasBox
        ? { bbox: [acc.minX, acc.minY, acc.maxX, acc.maxY] as [number, number, number, number] }
        : {}),
      sampledCount: acc.count,
      crsGuess,
    };
  }

  // wkb — v1: skip bbox computation.
  // Still report the sampled non-null count so callers know the column has data.
  let sampledCount = 0;
  const vec = table.getChild(geometry.column);
  if (vec) {
    for (let i = 0; i < scanRows; i++) {
      const v = vec.get(i) as unknown;
      if (v != null) sampledCount++;
    }
  }
  return {
    column: geometry.column,
    encoding: 'wkb',
    sampledCount,
    crsGuess: 'unknown',
  };
}
