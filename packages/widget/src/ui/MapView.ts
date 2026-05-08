import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import maplibregl, { Map as MlMap, LngLatBoundsLike } from 'maplibre-gl';
// @ts-ignore — vite ?inline returns the raw stylesheet text
import maplibreCss from 'maplibre-gl/dist/maplibre-gl.css?inline';
import type { Table as ArrowTable, Vector } from 'apache-arrow';
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { Layer as DeckLayer } from '@deck.gl/core';
import { ScatterplotLayer, GeoJsonLayer } from '@deck.gl/layers';
import type { GeometryEncoding } from '../data/contracts';

/**
 * Bounding box accumulator: [minX, minY, maxX, maxY] in WGS84.
 */
type Bbox = [number, number, number, number];

interface MapInputLayer {
  name: string;
  table: ArrowTable;
  geometry: GeometryEncoding;
}

const MAX_GEOJSON_FEATURES = 50_000;

/**
 * <gcb-map> renders one or more Apache Arrow tables (with a GeometryEncoding
 * descriptor) on a MapLibre canvas using deck.gl through a MapboxOverlay.
 *
 * - lonlat         → ScatterplotLayer (zero-copy via Arrow Vectors).
 * - geojson-string → GeoJsonLayer (one FeatureCollection, capped at 50k).
 * - wkb            → not yet supported (engine should provide GeoJSON).
 */
@customElement('gcb-map')
export class GcbMap extends LitElement {
  static styles = [
    css`
      :host {
        display: block;
        width: 100%;
        height: var(--gcb-map-height, 360px);
        border-radius: 10px;
        overflow: hidden;
        border: 1px solid #e3e3e3;
        position: relative;
      }
      .root {
        width: 100%;
        height: 100%;
        background: #f4f4f5;
      }
      .err {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        padding: 8px 12px;
        font-size: 12px;
        color: #991b1b;
        background: #fef2f2;
        border-top: 1px solid #fecaca;
      }
    `,
    css`${unsafeCSS(maplibreCss)}`,
  ];

  /** One or more Arrow tables to render. */
  @property({ attribute: false }) layers: MapInputLayer[] = [];

  @state() private err: string | null = null;

  private map: MlMap | undefined = undefined;
  private overlay: MapboxOverlay | undefined = undefined;
  private mapLoaded = false;

  protected firstUpdated() {
    const root = this.renderRoot.querySelector('.root') as HTMLElement;
    this.map = new maplibregl.Map({
      container: root,
      style: 'https://demotiles.maplibre.org/style.json',
      center: [0, 20],
      zoom: 1.2,
      attributionControl: { compact: true },
    });
    this.map.on('load', () => {
      this.mapLoaded = true;
      this.overlay = new MapboxOverlay({ interleaved: false, layers: [] });
      this.map!.addControl(this.overlay);
      this.syncSafely();
    });
  }

  protected updated(changed: Map<string, unknown>) {
    if (changed.has('layers') && this.mapLoaded) {
      this.syncSafely();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    try {
      this.overlay?.finalize?.();
    } catch {
      /* ignore */
    }
    this.overlay = undefined;
    this.map?.remove();
    this.map = undefined;
    this.mapLoaded = false;
  }

  render() {
    return html`
      <div class="root"></div>
      ${this.err ? html`<div class="err">${this.err}</div>` : null}
    `;
  }

  private syncSafely() {
    try {
      this.err = null;
      this.syncLayers();
    } catch (err) {
      console.error('[gcb-map] failed to sync layers', err);
      this.err = err instanceof Error ? err.message : String(err);
      try {
        this.overlay?.setProps({ layers: [] });
      } catch {
        /* ignore */
      }
    }
  }

  private syncLayers() {
    if (!this.overlay || !this.map) return;

    if (!this.layers.length) {
      this.overlay.setProps({ layers: [] });
      return;
    }

    const deckLayers: DeckLayer[] = [];
    const bbox: Bbox = [Infinity, Infinity, -Infinity, -Infinity];

    for (const input of this.layers) {
      const built = buildLayer(input, bbox);
      if (built) deckLayers.push(built);
    }

    this.overlay.setProps({ layers: deckLayers });

    if (
      Number.isFinite(bbox[0]) &&
      Number.isFinite(bbox[1]) &&
      Number.isFinite(bbox[2]) &&
      Number.isFinite(bbox[3])
    ) {
      this.map.fitBounds(
        [
          [bbox[0], bbox[1]],
          [bbox[2], bbox[3]],
        ] as LngLatBoundsLike,
        { padding: 28, maxZoom: 14, duration: 600 },
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Layer builders                                                             */
/* -------------------------------------------------------------------------- */

function buildLayer(input: MapInputLayer, bbox: Bbox): DeckLayer | null {
  const { name, table, geometry } = input;

  switch (geometry.kind) {
    case 'lonlat':
      return buildScatterplot(name, table, geometry.lonColumn, geometry.latColumn, bbox);
    case 'geojson-string':
      return buildGeoJson(name, table, geometry.column, bbox);
    case 'wkb':
      console.warn(
        '[gcb-map] WKB rendering not yet supported; expecting engine to provide GeoJSON',
      );
      return null;
    default:
      return null;
  }
}

function buildScatterplot(
  name: string,
  table: ArrowTable,
  lonColumn: string,
  latColumn: string,
  bbox: Bbox,
): DeckLayer | null {
  const lonVec = table.getChild(lonColumn) as Vector | null;
  const latVec = table.getChild(latColumn) as Vector | null;
  if (!lonVec || !latVec) {
    console.warn(
      `[gcb-map] layer "${name}": missing lon/lat columns ` +
        `(lon="${lonColumn}", lat="${latColumn}") — skipping`,
    );
    return null;
  }

  const rowCount = table.numRows;

  for (let i = 0; i < rowCount; i++) {
    const lon = lonVec.get(i) as number | null | undefined;
    const lat = latVec.get(i) as number | null | undefined;
    if (lon == null || lat == null) continue;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (lon < bbox[0]) bbox[0] = lon;
    if (lat < bbox[1]) bbox[1] = lat;
    if (lon > bbox[2]) bbox[2] = lon;
    if (lat > bbox[3]) bbox[3] = lat;
  }

  return new ScatterplotLayer({
    id: `gcb-scatter-${name}`,
    data: { length: rowCount } as unknown as Iterable<unknown>,
    getPosition: ((
      _: unknown,
      info: { index: number; data: unknown; target: number[] },
    ) => {
      const { index, target } = info;
      const lon = lonVec.get(index) as number | null | undefined;
      const lat = latVec.get(index) as number | null | undefined;
      target[0] = typeof lon === 'number' ? lon : 0;
      target[1] = typeof lat === 'number' ? lat : 0;
      target[2] = 0;
      return target as unknown as [number, number, number];
    }) as unknown as never,
    getFillColor: [245, 158, 11],
    getRadius: 4,
    radiusMinPixels: 4,
    pickable: true,
  });
}

function buildGeoJson(
  name: string,
  table: ArrowTable,
  column: string,
  bbox: Bbox,
): DeckLayer | null {
  const geomVec = table.getChild(column) as Vector | null;
  if (!geomVec) {
    console.warn(`[gcb-map] layer "${name}": geojson-string column "${column}" missing — skipping`);
    return null;
  }

  const rowCount = table.numRows;
  const features: GeoJSON.Feature[] = [];
  let truncated = false;

  for (let i = 0; i < rowCount; i++) {
    if (features.length >= MAX_GEOJSON_FEATURES) {
      truncated = true;
      break;
    }
    const raw = geomVec.get(i);
    if (raw == null) continue;
    const text = typeof raw === 'string' ? raw : String(raw);
    let geometry: GeoJSON.Geometry;
    try {
      geometry = JSON.parse(text) as GeoJSON.Geometry;
    } catch {
      continue;
    }
    if (!geometry || typeof (geometry as { type?: unknown }).type !== 'string') continue;
    expandBboxFromGeoJSON(geometry, bbox);
    features.push({
      type: 'Feature',
      geometry,
      properties: { __row: i },
    });
  }

  if (truncated) {
    console.warn(
      `[gcb-map] layer "${name}": exceeded ${MAX_GEOJSON_FEATURES} features; truncated for v1`,
    );
  }

  return new GeoJsonLayer({
    id: `gcb-geojson-${name}`,
    data: { type: 'FeatureCollection', features },
    stroked: true,
    filled: true,
    pointRadiusMinPixels: 4,
    getLineColor: [67, 56, 202, 255],
    getFillColor: [67, 56, 202, 64], // ~25% opacity
    getLineWidth: 1.5,
    lineWidthMinPixels: 1.5,
    getPointRadius: 4,
    pickable: true,
  });
}

/* -------------------------------------------------------------------------- */
/* Bbox helpers                                                               */
/* -------------------------------------------------------------------------- */

function expandBboxFromGeoJSON(geom: GeoJSON.Geometry, bbox: Bbox): void {
  switch (geom.type) {
    case 'Point':
      expandPoint(geom.coordinates as number[], bbox);
      break;
    case 'MultiPoint':
    case 'LineString':
      for (const c of geom.coordinates as number[][]) expandPoint(c, bbox);
      break;
    case 'MultiLineString':
    case 'Polygon':
      for (const ring of geom.coordinates as number[][][]) {
        for (const c of ring) expandPoint(c, bbox);
      }
      break;
    case 'MultiPolygon':
      for (const poly of geom.coordinates as number[][][][]) {
        for (const ring of poly) {
          for (const c of ring) expandPoint(c, bbox);
        }
      }
      break;
    case 'GeometryCollection':
      for (const g of geom.geometries) expandBboxFromGeoJSON(g, bbox);
      break;
    default:
      break;
  }
}

function expandPoint(coord: number[], bbox: Bbox): void {
  const x = coord?.[0];
  const y = coord?.[1];
  if (typeof x !== 'number' || typeof y !== 'number') return;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  if (x < bbox[0]) bbox[0] = x;
  if (y < bbox[1]) bbox[1] = y;
  if (x > bbox[2]) bbox[2] = x;
  if (y > bbox[3]) bbox[3] = y;
}

declare global {
  interface HTMLElementTagNameMap {
    'gcb-map': GcbMap;
  }
}
