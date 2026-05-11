import type { Layer as DeckLayer } from "@deck.gl/core";
import { GeoJsonLayer, ScatterplotLayer } from "@deck.gl/layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Table as ArrowTable, Vector } from "apache-arrow";
import { LitElement, css, html, unsafeCSS } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import maplibregl, {
	type Map as MlMap,
	type LngLatBoundsLike,
} from "maplibre-gl";
// @ts-ignore — vite ?inline returns the raw stylesheet text
import maplibreCss from "maplibre-gl/dist/maplibre-gl.css?inline";
import type { GeometryEncoding } from "../data/contracts";

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
    `,
		css`${unsafeCSS(maplibreCss)}`,
	];

	/** One or more Arrow tables to render. */
	@property({ attribute: false }) layers: MapInputLayer[] = [];
	/** Pre-built GeoJSON FeatureCollections to render (e.g. from render.map results). */
	@property({ attribute: false }) geojsonLayers: GeoJsonInputLayer[] = [];

	@state() private err: string | null = null;

	private map: MlMap | undefined = undefined;
	private overlay: MapboxOverlay | undefined = undefined;
	private mapLoaded = false;

	protected firstUpdated() {
		const root = this.renderRoot.querySelector(".root") as HTMLElement;
		this.map = new maplibregl.Map({
			container: root,
			style: "https://demotiles.maplibre.org/style.json",
			center: [0, 20],
			zoom: 1.2,
			attributionControl: { compact: true },
		});
		this.map.on("load", () => {
			this.mapLoaded = true;
			this.overlay = new MapboxOverlay({ interleaved: false, layers: [] });
			this.map?.addControl(this.overlay);
			this.syncSafely();
		});
	}

	protected updated(changed: Map<string, unknown>) {
		if (
			(changed.has("layers") || changed.has("geojsonLayers")) &&
			this.mapLoaded
		) {
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
			for (const feat of features as GeoJSON.Feature[]) {
				if (feat?.geometry) expandBboxFromGeoJSON(feat.geometry, bbox);
			}
		}

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
	[59, 82, 139, 200],  // q4           — blue
	[68, 1, 84, 220],    // q5 (highest) — purple
];

const DEFAULT_COLOR: Rgba = [67, 56, 202, 64];

function stableHash(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) {
		h = (h * 31 + s.charCodeAt(i)) | 0;
	}
	return Math.abs(h);
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
		(f) => (f.properties as Record<string, unknown> | null)?.[style.colorBy as string] != null,
	).length;
	// >= 80% of non-null values are numeric → treat as quantile.
	return totalNonNull > 0 && numeric.length / totalNonNull >= 0.8
		? "quantile"
		: "categorical";
}

function computeQuantileBreaks(values: number[]): number[] {
	if (values.length === 0) return [];
	const sorted = [...values].sort((a, b) => a - b);
	const breaks: number[] = [];
	for (let i = 1; i < QUANTILE_PALETTE.length; i++) {
		const q = i / QUANTILE_PALETTE.length;
		const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
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
		return (f: GeoJSON.Feature) => {
			const raw = (f.properties as Record<string, unknown> | null)?.[col];
			if (raw === null || raw === undefined) return DEFAULT_COLOR;
			const key = String(raw);
			const idx = stableHash(key) % CATEGORICAL_PALETTE.length;
			return CATEGORICAL_PALETTE[idx] ?? DEFAULT_COLOR;
		};
	}
	// quantile or linear — both bucket numeric values into 5 classes
	const nums = readNumericValues(features, col);
	const breaks = computeQuantileBreaks(nums);
	return (f: GeoJSON.Feature) => {
		const raw = (f.properties as Record<string, unknown> | null)?.[col];
		const n = typeof raw === "string" ? Number(raw) : (raw as number);
		if (!Number.isFinite(n)) return DEFAULT_COLOR;
		let bucket = 0;
		for (const b of breaks) {
			if (n >= b) bucket++;
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
