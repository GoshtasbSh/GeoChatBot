import { describe, expect, it } from 'vitest';
import { detectLatLon } from '../../src/data/loaders/_util.js';

describe('detectLatLon', () => {
  it('detects classic latitude/longitude column names', () => {
    const enc = detectLatLon([
      { latitude: 29.6, longitude: -82.3, x: 1 },
      { latitude: 30.0, longitude: -83.0, x: 2 },
    ]);
    expect(enc).toEqual({ kind: 'lonlat', latColumn: 'latitude', lonColumn: 'longitude' });
  });

  it('detects short lat/lon synonyms case-insensitively', () => {
    const enc = detectLatLon([
      { LAT: 1, LON: 2 },
      { LAT: 3, LON: 4 },
    ]);
    expect(enc?.kind).toBe('lonlat');
    if (enc?.kind === 'lonlat') {
      expect(enc.latColumn).toBe('LAT');
      expect(enc.lonColumn).toBe('LON');
    }
  });

  it('detects the `lng` synonym for longitude', () => {
    const enc = detectLatLon([
      { lat: 0.5, lng: 1.5 },
    ]);
    expect(enc).toEqual({ kind: 'lonlat', latColumn: 'lat', lonColumn: 'lng' });
  });

  it('detects the `long` synonym for longitude', () => {
    const enc = detectLatLon([
      { Latitude: 5, Long: -120 },
    ]);
    expect(enc?.kind).toBe('lonlat');
  });

  it('detects x/y when no other names are present', () => {
    const enc = detectLatLon([
      { id: 1, x: 10, y: 20 },
      { id: 2, x: 11, y: 21 },
    ]);
    expect(enc).toEqual({ kind: 'lonlat', lonColumn: 'x', latColumn: 'y' });
  });

  it('accepts numeric strings ("29.6") as valid lat/lon', () => {
    const enc = detectLatLon([
      { lat: '29.6', lon: '-82.3' },
      { lat: '30.0', lon: '-83.0' },
    ]);
    expect(enc?.kind).toBe('lonlat');
  });

  it('rejects when only one of lat/lon is present', () => {
    expect(detectLatLon([{ latitude: 29.6 }])).toBeUndefined();
    expect(detectLatLon([{ longitude: -82.3 }])).toBeUndefined();
  });

  it('rejects when latitude is out of range', () => {
    expect(
      detectLatLon([
        { lat: 95, lon: -82 },
      ]),
    ).toBeUndefined();
  });

  it('rejects when longitude is out of range', () => {
    expect(
      detectLatLon([
        { lat: 29, lon: 200 },
      ]),
    ).toBeUndefined();
  });

  it('rejects when values are non-numeric strings', () => {
    expect(
      detectLatLon([
        { lat: 'north', lon: 'west' },
      ]),
    ).toBeUndefined();
  });

  it('rejects when noGeometry option is set even if columns match', () => {
    expect(
      detectLatLon(
        [{ lat: 1, lon: 2 }],
        { noGeometry: true },
      ),
    ).toBeUndefined();
  });

  it('honors explicit latColumn/lonColumn overrides', () => {
    const enc = detectLatLon(
      [{ a: 29, b: -82, lat: 0, lon: 0 }],
      { latColumn: 'a', lonColumn: 'b' },
    );
    expect(enc).toEqual({ kind: 'lonlat', latColumn: 'a', lonColumn: 'b' });
  });

  it('returns undefined when overrides reference non-existent columns', () => {
    expect(
      detectLatLon(
        [{ a: 29, b: -82 }],
        { latColumn: 'nope', lonColumn: 'b' },
      ),
    ).toBeUndefined();
  });

  it('returns undefined for empty input', () => {
    expect(detectLatLon([])).toBeUndefined();
  });

  it('returns undefined when all sampled rows have null lat/lon', () => {
    expect(
      detectLatLon([
        { lat: null, lon: null },
        { lat: null, lon: null },
      ]),
    ).toBeUndefined();
  });

  it('skips rows with one null side and detects geometry from valid rows', () => {
    // Regression for the `lat == null && lon == null` bug: a footer or
    // sparse row with only one populated coord must not poison the
    // detection of an otherwise-valid dataset.
    const enc = detectLatLon([
      { lat: 29.6, lon: -82.3 },
      { lat: 30.1, lon: -82.4 },
      { lat: null, lon: -82.0 }, // half-populated row — must be skipped
      { lat: 30.2, lon: null }, // half-populated row — must be skipped
      { lat: 30.5, lon: -82.5 },
    ]);
    expect(enc).toEqual({ kind: 'lonlat', latColumn: 'lat', lonColumn: 'lon' });
  });

  it('detects underscore-suffixed variants used by USGS / Census exports', () => {
    expect(
      detectLatLon([
        { latitude_dd: 29.6, longitude_dd: -82.3 },
      ]),
    ).toEqual({ kind: 'lonlat', latColumn: 'latitude_dd', lonColumn: 'longitude_dd' });
  });

  it('detects the ArcGIS POINT_X / POINT_Y export convention', () => {
    expect(
      detectLatLon([
        { POINT_X: -82.3, POINT_Y: 29.6 },
      ]),
    ).toEqual({ kind: 'lonlat', latColumn: 'POINT_Y', lonColumn: 'POINT_X' });
  });

  it('detects y_coord / x_coord', () => {
    expect(
      detectLatLon([
        { x_coord: -82.3, y_coord: 29.6 },
      ]),
    ).toEqual({ kind: 'lonlat', latColumn: 'y_coord', lonColumn: 'x_coord' });
  });
});
