import type { Layer as DeckLayer } from "@deck.gl/core";
import { GeoJsonLayer, ScatterplotLayer } from "@deck.gl/layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Table as ArrowTable, Vector } from "apache-arrow";
import { LitElement, css, html, unsafeCSS } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import maplibregl, {
	type Map as MlMap,
	type LngLatBoundsLike,
	type StyleSpecification,
} from "maplibre-gl";
// @ts-ignore — vite ?inline returns the raw stylesheet text
import maplibreCss from "maplibre-gl/dist/maplibre-gl.css?inline";
import type { GeometryEncoding } from "../data/contracts";

/* -------------------------------------------------------------------------- */
/* Basemaps                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A selectable basemap. `style` is a key-free MapLibre raster style — no API
 * token required. Each source carries its provider attribution so the
 * MapLibre attribution control stays correct as the user switches basemaps.
 */
export interface Basemap {
	id: BasemapId;
	label: string;
	style: StyleSpecification;
}

export type BasemapId = "light" | "osm" | "satellite" | "dark";

/** Build a single-layer raster style from a tile URL template (or templates). */
function rasterStyle(
	id: string,
	tiles: string[],
	attribution: string,
	maxzoom = 19,
): StyleSpecification {
	return {
		version: 8,
		sources: {
			[id]: {
				type: "raster",
				tiles,
				tileSize: 256,
				attribution,
				maxzoom,
			},
		},
		layers: [{ id, type: "raster", source: id }],
	};
}

const CARTO_ATTRIB =
	'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>';
const OSM_ATTRIB =
	'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const ESRI_ATTRIB =
	"Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community";

/**
 * The selectable basemaps, in display order. `light` (Carto Positron) is the
 * default — a clean grey street map that lets data overlays read clearly.
 */
export const BASEMAPS: ReadonlyArray<Basemap> = [
	{
		id: "light",
		label: "Light",
		style: rasterStyle(
			"carto-light",
			[
				"https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
				"https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
				"https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
				"https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
			],
			CARTO_ATTRIB,
			20,
		),
	},
	{
		id: "osm",
		label: "OSM Streets",
		style: rasterStyle(
			"osm",
			["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
			OSM_ATTRIB,
			19,
		),
	},
	{
		id: "satellite",
		label: "Satellite",
		style: rasterStyle(
			"esri-imagery",
			[
				"https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
			],
			ESRI_ATTRIB,
			19,
		),
	},
	{
		id: "dark",
		label: "Dark",
		style: rasterStyle(
			"carto-dark",
			[
				"https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
				"https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
				"https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
				"https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
			],
			CARTO_ATTRIB,
			20,
		),
	},
];

export const DEFAULT_BASEMAP_ID: BasemapId = "light";

const BASEMAPS_BY_ID: Record<BasemapId, Basemap> = Object.fromEntries(
	BASEMAPS.map((b) => [b.id, b]),
) as Record<BasemapId, Basemap>;

/** Expand-to-fullscreen icon (four outward arrows). */
const EXPAND_ICON = html`
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="15 3 21 3 21 9" />
    <polyline points="9 21 3 21 3 15" />
    <line x1="21" y1="3" x2="14" y2="10" />
    <line x1="3" y1="21" x2="10" y2="14" />
  </svg>
`;
/** Close / exit-fullscreen icon (✕). */
const CLOSE_ICON = html`
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
`;

/**
 * Bounding box accumulator: [minX, minY, maxX, maxY] in WGS84.
 */
type Bbox = [number, number, number, number];

interface MapInputLayer {
	name: string;
	table: ArrowTable;
	geometry: GeometryEncoding;
}

/** A pre-built GeoJSON FeatureCollection to render directly (e.g. from render.map). */
export interface GeoJsonInputLayer {
	name: string;
	geojson: { type: "FeatureCollection"; features: unknown[] };
	/** Optional rendering style. The planner emits this when the user
	 *  asks for color-coded / sized maps ("color by category", "choropleth
	 *  by population"). Fields are best-effort — unknown keys are ignored. */
	style?: {
		/** Feature property to color-code by. Categorical strings get a
		 *  hash-based palette; numeric values get a quintile color scale. */
		colorBy?: string;
		/** Feature property to size point radius by (numeric only).
		 *  Values are min-max normalized to a 3-12 px radius. */
		radiusBy?: string;
		/** Override the classification strategy (default: auto-detect
		 *  from values). */
		classification?: "categorical" | "quantile" | "linear";
	};
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
@customElement("gcb-map")
export class GcbMap extends LitElement {
	static styles = [
		css`
      :host {
        display: block;
        width: 100%;
        height: var(--gcb-map-height, 360px);
        border-radius: 10px;
        overflow: hidden;
        border: 1px solid var(--gcb-border, #e3e3e3);
        position: relative;
      }
      /* In-app fullscreen: promote the host to a viewport-filling overlay.
         position:fixed is relative to the viewport (no ancestor here uses
         transform/filter/will-change, which are the only things that would
         re-anchor it), so it escapes the chat card's overflow:hidden. */
      :host(.fullscreen) {
        position: fixed;
        inset: 0;
        /* !important: the host's consumer (result-canvas) sets an explicit
           "gcb-map { height: 340px }" from the OUTER tree, which by the shadow
           cascade rules beats a plain :host() height. Importance wins it back
           so fullscreen actually fills the viewport, not just its width. */
        width: 100vw !important;
        height: 100vh !important;
        z-index: 2147483000;
        border-radius: 0;
        border: 0;
      }
      .root {
        width: 100%;
        height: 100%;
        background: var(--gcb-map-bg, #f4f4f5);
      }
      .err {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        padding: 8px 12px;
        font-size: 12px;
        color: var(--gcb-error-fg, #991b1b);
        background: var(--gcb-error-bg, #fef2f2);
        border-top: 1px solid var(--gcb-border, #fecaca);
      }

      /* Control cluster — top-right, overlaid on the map canvas. Sits to the
         left of MapLibre's NavigationControl (which we nudge down below). */
      .controls {
        position: absolute;
        top: 10px;
        right: 10px;
        z-index: 5;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .basemap-select {
        appearance: none;
        font: inherit;
        font-size: 12px;
        line-height: 1;
        padding: 6px 24px 6px 9px;
        border-radius: 7px;
        border: 1px solid var(--gcb-border, rgba(0, 0, 0, 0.12));
        background-color: var(--gcb-bg-2, #fff);
        color: var(--gcb-ink, #18181b);
        cursor: pointer;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
        /* chevron */
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23737373' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 7px center;
      }
      .basemap-select:focus-visible {
        outline: 2px solid var(--gcb-accent, #f59e0b);
        outline-offset: 1px;
      }
      .map-btn {
        display: grid;
        place-items: center;
        width: 30px;
        height: 30px;
        padding: 0;
        border-radius: 7px;
        border: 1px solid var(--gcb-border, rgba(0, 0, 0, 0.12));
        background: var(--gcb-bg-2, #fff);
        color: var(--gcb-ink, #18181b);
        cursor: pointer;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
        transition: background 120ms ease, color 120ms ease;
      }
      .map-btn:hover {
        background: var(--gcb-accent-soft, #fff7ed);
        color: var(--gcb-accent, #b45309);
      }
      .map-btn:focus-visible {
        outline: 2px solid var(--gcb-accent, #f59e0b);
        outline-offset: 1px;
      }
      .map-btn svg {
        width: 16px;
        height: 16px;
      }
      /* Push MapLibre's zoom control below our control cluster. */
      :host .maplibregl-ctrl-top-right {
        top: 48px;
      }
    `,
		css`${unsafeCSS(maplibreCss)}`,
	];

	/** One or more Arrow tables to render. */
	@property({ attribute: false }) layers: MapInputLayer[] = [];
	/** Pre-built GeoJSON FeatureCollections to render (e.g. from render.map results). */
	@property({ attribute: false }) geojsonLayers: GeoJsonInputLayer[] = [];

	@state() private err: string | null = null;
	/** Currently selected basemap. Defaults to the clean Light (Positron) style. */
	@state() private basemapId: BasemapId = DEFAULT_BASEMAP_ID;
	/** Whether the map is expanded to a viewport-filling in-app overlay. */
	@state() private fullscreen = false;

	private map: MlMap | undefined = undefined;
	private overlay: MapboxOverlay | undefined = undefined;
	private mapLoaded = false;
	/** Last set of deck layers — re-applied after a basemap (setStyle) swap. */
	private deckLayers: DeckLayer[] = [];
	private readonly onKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Escape" && this.fullscreen) {
			e.stopPropagation();
			this.fullscreen = false;
		}
	};

	override connectedCallback(): void {
		super.connectedCallback();
		window.addEventListener("keydown", this.onKeyDown);
	}

	protected firstUpdated() {
		const root = this.renderRoot.querySelector(".root") as HTMLElement;
		try {
			this.map = new maplibregl.Map({
				container: root,
				style: BASEMAPS_BY_ID[this.basemapId].style,
				center: [0, 20],
				zoom: 1.2,
				attributionControl: { compact: true },
			});
			this.map.addControl(
				new maplibregl.NavigationControl({ showCompass: false }),
				"top-right",
			);
			this.map.on("load", () => {
				this.mapLoaded = true;
				this.overlay = new MapboxOverlay({ interleaved: false, layers: [] });
				this.map?.addControl(this.overlay);
				this.syncSafely();
			});
		} catch (err) {
			// MapLibre throws synchronously when WebGL can't initialize
			// (headless test envs, WebGL-disabled browsers, blocklisted GPUs).
			// Surface it in the error banner instead of leaking an unhandled
			// rejection through Lit's async update cycle and leaving a blank box.
			console.error("[gcb-map] failed to initialize map", err);
			this.map = undefined;
			this.err =
				err instanceof Error
					? `Map unavailable: ${err.message}`
					: "Map unavailable (WebGL could not initialize)";
		}
	}

	protected updated(changed: Map<string, unknown>) {
		if (
			(changed.has("layers") || changed.has("geojsonLayers")) &&
			this.mapLoaded
		) {
			this.syncSafely();
		}
		// Reflect fullscreen onto the host so :host(.fullscreen) CSS applies,
		// then let MapLibre pick up the new container size.
		if (changed.has("fullscreen")) {
			this.classList.toggle("fullscreen", this.fullscreen);
			requestAnimationFrame(() => this.map?.resize());
		}
	}

	disconnectedCallback() {
		super.disconnectedCallback();
		window.removeEventListener("keydown", this.onKeyDown);
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

	/** Swap the basemap style, preserving the deck overlay and viewport. */
	private setBasemap(id: BasemapId): void {
		if (id === this.basemapId || !BASEMAPS_BY_ID[id] || !this.map) return;
		this.basemapId = id;
		this.map.setStyle(BASEMAPS_BY_ID[id].style);
		// setStyle reloads the GL style; in overlaid mode the deck canvas
		// survives, but re-apply the layers once the new style is live so
		// nothing flickers out. Do NOT re-fit bounds — keep the user's view.
		this.map.once("styledata", () => {
			try {
				this.overlay?.setProps({ layers: this.deckLayers });
			} catch {
				/* ignore */
			}
		});
	}

	render() {
		return html`
      <div class="root"></div>
      <div class="controls">
        <select
          class="basemap-select"
          aria-label="Basemap"
          .value=${this.basemapId}
          @change=${(e: Event) =>
						this.setBasemap((e.target as HTMLSelectElement).value as BasemapId)}
        >
          ${BASEMAPS.map(
						(b) =>
							html`<option value=${b.id} ?selected=${b.id === this.basemapId}>${b.label}</option>`,
					)}
        </select>
        <button
          class="map-btn"
          type="button"
          aria-label=${this.fullscreen ? "Exit fullscreen" : "Expand map to fullscreen"}
          title=${this.fullscreen ? "Exit fullscreen (Esc)" : "Expand map"}
          @click=${() => {
						this.fullscreen = !this.fullscreen;
					}}
        >
          ${this.fullscreen ? CLOSE_ICON : EXPAND_ICON}
        </button>
      </div>
      ${this.err ? html`<div class="err">${this.err}</div>` : null}
    `;
	}

	private syncSafely() {
		try {
			this.err = null;
			this.syncLayers();
		} catch (err) {
			console.error("[gcb-map] failed to sync layers", err);
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

		// Early-out only when BOTH input sources are empty. The original
		// `this.layers.length` check skipped past geojsonLayers entirely, so
		// result-canvas (which only sets geojsonLayers) silently rendered an
		// empty map even though MapLibre's basemap was visible.
		if (!this.layers.length && !this.geojsonLayers.length) {
			this.deckLayers = [];
			this.overlay.setProps({ layers: [] });
			return;
		}

		const deckLayers: DeckLayer[] = [];
		const bbox: Bbox = [
			Number.POSITIVE_INFINITY,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		];

		for (const input of this.layers) {
			const built = buildLayer(input, bbox);
			if (built) deckLayers.push(built);
		}

		for (const src of this.geojsonLayers) {
			const raw = src.geojson as { type: string; features: GeoJSON.Feature[] };
			const features = Array.isArray(raw?.features) ? raw.features : [];
			const limited = features.slice(0, MAX_GEOJSON_FEATURES);
			const colorAccessor = buildColorAccessor(limited, src.style);
			const radiusAccessor = buildRadiusAccessor(limited, src.style);
			deckLayers.push(
				new GeoJsonLayer({
					id: `gcb-geojson-result-${src.name}`,
					data: {
						type: "FeatureCollection",
						features: limited,
					},
					stroked: true,
					filled: true,
					pointRadiusMinPixels: 4,
					getLineColor: [67, 56, 202, 255],
					getFillColor: colorAccessor,
					getLineWidth: 1.5,
					lineWidthMinPixels: 1.5,
					getPointRadius: radiusAccessor,
					pickable: true,
					// updateTriggers ensures deck.gl recomputes per-feature colors
					// when the colorBy column changes (e.g. user runs a new query
					// against the same layer name).
					updateTriggers: {
						getFillColor: [src.style?.colorBy, src.style?.classification],
						getPointRadius: [src.style?.radiusBy],
					},
				}),
			);
			// AUDIT-015 (perf): walk only the displayed (capped) feature
			// set when expanding the bbox so a 200k-feature input doesn't
			// pay the bbox cost AND zoom-to features that aren't rendered.
			for (const feat of limited as GeoJSON.Feature[]) {
				if (feat?.geometry) expandBboxFromGeoJSON(feat.geometry, bbox);
			}
		}

		this.deckLayers = deckLayers;
		this.overlay.setProps({ layers: deckLayers });

		if (
			Number.isFinite(bbox[0]) &&
			Number.isFinite(bbox[1]) &&
			Number.isFinite(bbox[2]) &&
			Number.isFinite(bbox[3])
		) {
			// Antimeridian guard: a dataset spanning the Pacific (e.g.
			// points clustered near +170° and -170°) accumulates a bbox like
			// [-170, ..., 170, ...] which describes the *long* way around the
			// world, causing fitBounds to zoom to the Atlantic. We can't
			// reliably distinguish a genuine cross-meridian dataset from a
			// global one without per-row analysis, so we conservatively skip
			// the fit when the implied longitudinal span is > 270° and let
			// the map keep its previous viewport (or initial world view).
			// Most legitimate datasets fit in <= 180° of longitude.
			const lonSpan = bbox[2] - bbox[0];
			if (lonSpan <= 270) {
				this.map.fitBounds(
					[
						[bbox[0], bbox[1]],
						[bbox[2], bbox[3]],
					] as LngLatBoundsLike,
					{ padding: 28, maxZoom: 14, duration: 600 },
				);
			} else {
				// Fall back to a global view so the user still sees something
				// rather than the wrong hemisphere.
				this.map.fitBounds(
					[
						[-180, Math.max(bbox[1], -85)],
						[180, Math.min(bbox[3], 85)],
					] as LngLatBoundsLike,
					{ padding: 28, maxZoom: 14, duration: 600 },
				);
			}
		}
	}
}

/* -------------------------------------------------------------------------- */
/* Layer builders                                                             */
/* -------------------------------------------------------------------------- */

function buildLayer(input: MapInputLayer, bbox: Bbox): DeckLayer | null {
	const { name, table, geometry } = input;

	switch (geometry.kind) {
		case "lonlat":
			return buildScatterplot(
				name,
				table,
				geometry.lonColumn,
				geometry.latColumn,
				bbox,
			);
		case "geojson-string":
			return buildGeoJson(name, table, geometry.column, bbox);
		case "wkb":
			console.warn(
				"[gcb-map] WKB rendering not yet supported; expecting engine to provide GeoJSON",
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

	// Pre-collect indices of rows with finite numeric lon AND lat.
	// ScatterplotLayer iterates the `data` collection 1:1 — without this
	// filter, rows with missing/non-finite coords would render at
	// ScatterplotLayer's `getPosition` fallback `[0, 0]` (Null Island in
	// the Gulf of Guinea). Real-world CSVs commonly have footer/summary
	// rows with no coordinates, so this matters in practice.
	const validIdx: number[] = [];
	for (let i = 0; i < rowCount; i++) {
		const lon = lonVec.get(i) as number | null | undefined;
		const lat = latVec.get(i) as number | null | undefined;
		if (lon == null || lat == null) continue;
		if (typeof lon !== "number" || typeof lat !== "number") continue;
		if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
		validIdx.push(i);
		if (lon < bbox[0]) bbox[0] = lon;
		if (lat < bbox[1]) bbox[1] = lat;
		if (lon > bbox[2]) bbox[2] = lon;
		if (lat > bbox[3]) bbox[3] = lat;
	}

	if (validIdx.length === 0) {
		console.warn(
			`[gcb-map] layer "${name}": no rows with finite lon/lat — skipping`,
		);
		return null;
	}

	return new ScatterplotLayer({
		id: `gcb-scatter-${name}`,
		data: validIdx,
		getPosition: ((rowIdx: number, info: { target: number[] }) => {
			const { target } = info;
			// rowIdx is the validIdx[i] value — guaranteed numeric & finite.
			target[0] = lonVec.get(rowIdx) as number;
			target[1] = latVec.get(rowIdx) as number;
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
		console.warn(
			`[gcb-map] layer "${name}": geojson-string column "${column}" missing — skipping`,
		);
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
		const text = typeof raw === "string" ? raw : String(raw);
		let geometry: GeoJSON.Geometry;
		try {
			geometry = JSON.parse(text) as GeoJSON.Geometry;
		} catch {
			continue;
		}
		if (!geometry || typeof (geometry as { type?: unknown }).type !== "string")
			continue;
		expandBboxFromGeoJSON(geometry, bbox);
		features.push({
			type: "Feature",
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
		data: { type: "FeatureCollection", features },
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
		case "Point":
			expandPoint(geom.coordinates as number[], bbox);
			break;
		case "MultiPoint":
		case "LineString":
			for (const c of geom.coordinates as number[][]) expandPoint(c, bbox);
			break;
		case "MultiLineString":
		case "Polygon":
			for (const ring of geom.coordinates as number[][][]) {
				for (const c of ring) expandPoint(c, bbox);
			}
			break;
		case "MultiPolygon":
			for (const poly of geom.coordinates as number[][][][]) {
				for (const ring of poly) {
					for (const c of ring) expandPoint(c, bbox);
				}
			}
			break;
		case "GeometryCollection":
			for (const g of geom.geometries) expandBboxFromGeoJSON(g, bbox);
			break;
		default:
			break;
	}
}

function expandPoint(coord: number[], bbox: Bbox): void {
	const x = coord?.[0];
	const y = coord?.[1];
	if (typeof x !== "number" || typeof y !== "number") return;
	if (!Number.isFinite(x) || !Number.isFinite(y)) return;
	if (x < bbox[0]) bbox[0] = x;
	if (y < bbox[1]) bbox[1] = y;
	if (x > bbox[2]) bbox[2] = x;
	if (y > bbox[3]) bbox[3] = y;
}

/* -------------------------------------------------------------------------- */
/* Color / size accessors for color-coded maps                                */
/* -------------------------------------------------------------------------- */

type Rgba = [number, number, number, number];

/** A small, color-blind-friendly categorical palette (ColorBrewer Set2 / Set3
 *  blended). Indexed via stable string-hash so the same category gets the same
 *  color across re-renders. */
const CATEGORICAL_PALETTE: ReadonlyArray<Rgba> = [
	[31, 119, 180, 200],
	[255, 127, 14, 200],
	[44, 160, 44, 200],
	[214, 39, 40, 200],
	[148, 103, 189, 200],
	[140, 86, 75, 200],
	[227, 119, 194, 200],
	[127, 127, 127, 200],
	[188, 189, 34, 200],
	[23, 190, 207, 200],
];

/** 5-class sequential quantile palette (viridis-ish). Lighter → darker as
 *  values increase. The fixed-alpha (180-220) lets overlapping polygons
 *  still read against the basemap. */
const QUANTILE_PALETTE: ReadonlyArray<Rgba> = [
	[253, 231, 37, 200], // q1 (lowest)  — yellow
	[122, 209, 81, 200], // q2           — green
	[33, 144, 141, 200], // q3           — teal
	[59, 82, 139, 200], // q4           — blue
	[68, 1, 84, 220], // q5 (highest) — purple
];

const DEFAULT_COLOR: Rgba = [67, 56, 202, 64];

/**
 * Deterministic category → palette-color assignment by frequency rank.
 *
 * 2026-05-30 collision fix: the previous design indexed the palette with
 * `stableHash(label) % CATEGORICAL_PALETTE.length` independently per label.
 * Distinct categories whose hashes landed in the same bucket got the SAME
 * color — e.g. a 6-status survey rendered "no answer", "completed", and
 * "inaccessible" (264 of 306 points) all in one gray, producing a
 * near-uniform blob with no visible status distinction.
 *
 * Assigning by frequency rank (most-frequent first, ties broken by label
 * for stability) guarantees the top {@link CATEGORICAL_PALETTE}.length
 * categories receive DISTINCT colors. Colors only repeat once there are
 * more categories than palette entries — and the legend caps + reports
 * those via `hiddenCategoryCount`. Both {@link computeLegend} and
 * {@link buildColorAccessor} call this so fills and swatches always agree.
 *
 * Exported for unit tests that pin the no-collision guarantee.
 */
export function assignCategoryColors(
	features: ReadonlyArray<GeoJSON.Feature>,
	colorBy: string,
): { ordered: Array<[string, number]>; colorOf: Map<string, Rgba> } {
	const counts = new Map<string, number>();
	for (const f of features) {
		const raw = (f.properties as Record<string, unknown> | null)?.[colorBy];
		if (raw === null || raw === undefined) continue;
		counts.set(String(raw), (counts.get(String(raw)) ?? 0) + 1);
	}
	const ordered = [...counts.entries()].sort(
		(a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
	);
	const colorOf = new Map<string, Rgba>();
	ordered.forEach(([label], i) => {
		colorOf.set(
			label,
			CATEGORICAL_PALETTE[i % CATEGORICAL_PALETTE.length] ?? DEFAULT_COLOR,
		);
	});
	return { ordered, colorOf };
}

function readNumericValues(
	features: ReadonlyArray<GeoJSON.Feature>,
	colorBy: string,
): number[] {
	const out: number[] = [];
	for (const f of features) {
		const v = (f.properties as Record<string, unknown> | null)?.[colorBy];
		if (v === null || v === undefined) continue;
		const n = typeof v === "string" ? Number(v) : (v as number);
		if (Number.isFinite(n)) out.push(n);
	}
	return out;
}

/** Determine whether `colorBy` looks categorical or numeric on this
 *  feature set. Honors an explicit `classification` override. */
function pickStrategy(
	features: ReadonlyArray<GeoJSON.Feature>,
	style: GeoJsonInputLayer["style"],
): "categorical" | "quantile" | "linear" | "none" {
	if (!style?.colorBy) return "none";
	if (style.classification) return style.classification;
	const numeric = readNumericValues(features, style.colorBy);
	const totalNonNull = features.filter(
		(f) =>
			(f.properties as Record<string, unknown> | null)?.[
				style.colorBy as string
			] != null,
	).length;
	// >= 80% of non-null values are numeric → treat as quantile.
	return totalNonNull > 0 && numeric.length / totalNonNull >= 0.8
		? "quantile"
		: "categorical";
}

// Exported so unit tests (test/ui/mapview-color.test.ts) can lock the
// AUDIT-013 / AUDIT-014 math without bringing up MapLibre + deck.gl.
export function computeQuantileBreaks(values: number[]): number[] {
	return _computeQuantileBreaks(values);
}
export function bucketIndexQuantile(value: number, breaks: number[]): number {
	let bucket = 0;
	for (const b of breaks) {
		if (value > b) bucket++;
		else break;
	}
	return Math.min(QUANTILE_PALETTE.length - 1, bucket);
}
export function bucketIndexLinear(
	value: number,
	min: number,
	max: number,
): number {
	const span = max - min;
	const t = span > 0 ? (value - min) / span : 0;
	return Math.min(
		QUANTILE_PALETTE.length - 1,
		Math.max(0, Math.floor(t * QUANTILE_PALETTE.length)),
	);
}
export const _PALETTE_SIZE_FOR_TEST = QUANTILE_PALETTE.length;

/* -------------------------------------------------------------------------- */
/* Legend computation                                                         */
/* -------------------------------------------------------------------------- */

export interface LegendEntry {
	label: string;
	swatch: Rgba;
	count?: number;
}

export interface LegendSpec {
	kind: "categorical" | "quantile" | "linear" | "none";
	colorBy?: string;
	entries: LegendEntry[];
	/** For quantile/linear: numeric [min,max] across the dataset. */
	range?: [number, number];
	/** For categorical: distinct values not shown (we cap at the palette size). */
	hiddenCategoryCount?: number;
	/** Total distinct non-null values seen in the colorBy column. */
	totalCategoryCount?: number;
	/**
	 * 2026-05-21: surfaces a deterministic "this likely isn't useful" notice
	 * when the colored breakdown looks degenerate (e.g., ≤2 categories from
	 * a 100-feature dataset, or 90%+ of features lump into the largest
	 * bucket). The result-canvas renders this above the legend so the user
	 * doesn't silently get a 2-color blob without explanation.
	 */
	warning?: string;
}

const LEGEND_MAX_CATEGORIES = 10;

function formatLegendNumber(n: number): string {
	if (!Number.isFinite(n)) return "";
	const abs = Math.abs(n);
	if (abs >= 1000)
		return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
	if (abs >= 10) return n.toFixed(0);
	if (abs >= 1) return n.toFixed(1);
	return n.toFixed(2);
}

/** Compute a renderable legend for a styled feature collection. Mirrors the
 *  branching in {@link buildColorAccessor} so swatches match the actual fills.
 *  Exported so the result-canvas can render swatches + labels next to the map. */
export function computeLegend(
	features: ReadonlyArray<GeoJSON.Feature>,
	style: GeoJsonInputLayer["style"],
): LegendSpec {
	const strat = pickStrategy(features, style);
	if (strat === "none" || !style?.colorBy) {
		return { kind: "none", entries: [] };
	}
	const col = style.colorBy;
	if (strat === "categorical") {
		// Frequency-rank ordering + color assignment, shared with
		// buildColorAccessor so swatches match the map fills and distinct
		// categories never collide on the same color (2026-05-30 fix).
		const { ordered: sorted, colorOf } = assignCategoryColors(features, col);
		const top = sorted.slice(0, LEGEND_MAX_CATEGORIES);
		const entries: LegendEntry[] = top.map(([label, count]) => ({
			label,
			count,
			swatch: colorOf.get(label) ?? DEFAULT_COLOR,
		}));
		const totalNonNullFeatures = sorted.reduce((a, [, c]) => a + c, 0);
		// 2026-05-21: deterministic degeneracy detection. If we colored a
		// dataset of >20 features by a column that only resolved to ≤2
		// distinct values, the user almost certainly didn't get what they
		// asked for — flag it instead of silently shipping a 2-color blob.
		let warning: string | undefined;
		if (features.length >= 20 && sorted.length <= 2) {
			warning = `Only ${sorted.length} distinct value${
				sorted.length === 1 ? "" : "s"
			} in "${col}" across ${features.length} features — the breakdown may be too coarse. Try a different column or bucket via SQL.`;
		} else if (
			features.length >= 20 &&
			sorted.length > 2 &&
			(sorted[0]?.[1] ?? 0) / Math.max(1, totalNonNullFeatures) >= 0.9
		) {
			warning = `${Math.round(
				((sorted[0]?.[1] ?? 0) / Math.max(1, totalNonNullFeatures)) * 100,
			)}% of features fall into "${sorted[0]?.[0]}" — the column is too skewed for a useful color breakdown.`;
		}
		return {
			kind: "categorical",
			colorBy: col,
			entries,
			hiddenCategoryCount: Math.max(0, sorted.length - top.length),
			totalCategoryCount: sorted.length,
			...(warning ? { warning } : {}),
		};
	}
	const nums = readNumericValues(features, col);
	if (nums.length === 0) {
		return { kind: strat, colorBy: col, entries: [] };
	}
	const min = Math.min(...nums);
	const max = Math.max(...nums);
	const N = QUANTILE_PALETTE.length;
	if (strat === "linear") {
		const span = max - min;
		const entries: LegendEntry[] = QUANTILE_PALETTE.map((swatch, i) => {
			const lo = min + (i / N) * span;
			const hi = min + ((i + 1) / N) * span;
			const label =
				span > 0
					? `${formatLegendNumber(lo)} – ${formatLegendNumber(hi)}`
					: formatLegendNumber(min);
			return { label, swatch };
		});
		return { kind: "linear", colorBy: col, entries, range: [min, max] };
	}
	const breaks = computeQuantileBreaks(nums);
	const entries: LegendEntry[] = QUANTILE_PALETTE.map((swatch, i) => {
		const lo = i === 0 ? min : (breaks[i - 1] ?? min);
		const hi = i === N - 1 ? max : (breaks[i] ?? max);
		const label =
			min === max
				? formatLegendNumber(min)
				: `${formatLegendNumber(lo)} – ${formatLegendNumber(hi)}`;
		return { label, swatch };
	});
	return { kind: "quantile", colorBy: col, entries, range: [min, max] };
}

function _computeQuantileBreaks(values: number[]): number[] {
	if (values.length === 0) return [];
	const sorted = [...values].sort((a, b) => a - b);
	const breaks: number[] = [];
	// AUDIT-013 (math): produce N-1 breakpoints where N = palette size.
	// Use `Math.ceil(q * (n - 1))` rather than `Math.floor(q * n)` so the
	// first break is strictly above the minimum value (otherwise the
	// floor index lands on the min when ties exist, and strict-greater
	// bucket assignment then skips the bottom bucket entirely).
	const n = sorted.length;
	for (let i = 1; i < QUANTILE_PALETTE.length; i++) {
		const q = i / QUANTILE_PALETTE.length;
		const idx = Math.min(n - 1, Math.max(0, Math.ceil(q * (n - 1))));
		breaks.push(sorted[idx] as number);
	}
	return breaks;
}

function buildColorAccessor(
	features: ReadonlyArray<GeoJSON.Feature>,
	style: GeoJsonInputLayer["style"],
): Rgba | ((f: GeoJSON.Feature) => Rgba) {
	const strat = pickStrategy(features, style);
	if (strat === "none" || !style?.colorBy) return DEFAULT_COLOR;
	const col = style.colorBy;
	if (strat === "categorical") {
		// Frequency-rank assignment (shared with computeLegend) so distinct
		// categories get distinct colors and the map fills match the legend
		// swatches exactly. See assignCategoryColors for the collision fix.
		const { colorOf } = assignCategoryColors(features, col);
		return (f: GeoJSON.Feature) => {
			const raw = (f.properties as Record<string, unknown> | null)?.[col];
			if (raw === null || raw === undefined) return DEFAULT_COLOR;
			return colorOf.get(String(raw)) ?? DEFAULT_COLOR;
		};
	}
	const nums = readNumericValues(features, col);
	if (nums.length === 0) return DEFAULT_COLOR;
	const classification = style?.classification ?? "quantile";
	// AUDIT-014 (math): true linear classification — interpolate the
	// value's position [min,max] linearly across the palette index
	// range. Previously this path was an alias for quantile (palette
	// skewed by data distribution rather than scaled by extent).
	if (classification === "linear") {
		const min = Math.min(...nums);
		const max = Math.max(...nums);
		const span = max - min;
		return (f: GeoJSON.Feature) => {
			const raw = (f.properties as Record<string, unknown> | null)?.[col];
			const v = typeof raw === "string" ? Number(raw) : (raw as number);
			if (!Number.isFinite(v)) return DEFAULT_COLOR;
			const t = span > 0 ? (v - min) / span : 0;
			const idx = Math.min(
				QUANTILE_PALETTE.length - 1,
				Math.max(0, Math.floor(t * QUANTILE_PALETTE.length)),
			);
			return QUANTILE_PALETTE[idx] ?? DEFAULT_COLOR;
		};
	}
	// Quantile (default): strict-greater bucket assignment so a value
	// equal to a break goes into the LOWER bucket. Previously `>=` here
	// pushed equal values into the higher bucket, which combined with
	// the off-by-one break index meant the bottom bucket was empty on
	// any dataset with ties at the floor-index boundary.
	const breaks = computeQuantileBreaks(nums);
	return (f: GeoJSON.Feature) => {
		const raw = (f.properties as Record<string, unknown> | null)?.[col];
		const n = typeof raw === "string" ? Number(raw) : (raw as number);
		if (!Number.isFinite(n)) return DEFAULT_COLOR;
		let bucket = 0;
		for (const b of breaks) {
			if (n > b) bucket++;
			else break;
		}
		const clamped = Math.min(QUANTILE_PALETTE.length - 1, bucket);
		return QUANTILE_PALETTE[clamped] ?? DEFAULT_COLOR;
	};
}

function buildRadiusAccessor(
	features: ReadonlyArray<GeoJSON.Feature>,
	style: GeoJsonInputLayer["style"],
): number | ((f: GeoJSON.Feature) => number) {
	if (!style?.radiusBy) return 4;
	const col = style.radiusBy;
	const nums = readNumericValues(features, col);
	if (nums.length === 0) return 4;
	const lo = Math.min(...nums);
	const hi = Math.max(...nums);
	const span = hi - lo;
	if (span <= 0) return 4;
	const MIN_R = 3;
	const MAX_R = 12;
	return (f: GeoJSON.Feature) => {
		const raw = (f.properties as Record<string, unknown> | null)?.[col];
		const n = typeof raw === "string" ? Number(raw) : (raw as number);
		if (!Number.isFinite(n)) return MIN_R;
		const t = (n - lo) / span;
		return MIN_R + t * (MAX_R - MIN_R);
	};
}

declare global {
	interface HTMLElementTagNameMap {
		"gcb-map": GcbMap;
	}
}
