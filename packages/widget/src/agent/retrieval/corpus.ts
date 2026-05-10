/**
 * Built-in spatial-analysis corpus.
 *
 * Each entry is a short, self-contained "how to think about X" doc. They
 * are embedded once on first run and stored in the static-corpus
 * namespace; the retriever returns the most question-relevant subset for
 * inclusion in the planner's system prompt at plan time.
 *
 * Style guide:
 *   - One concept per doc, ≤120 words.
 *   - Lead with the *trigger phrase* the user is likely to type, so
 *     short cosine queries match. e.g. "When the user asks for hot spots…"
 *   - Mention the relevant tool ids verbatim so the retrieved text gives
 *     the planner a tool hint, not just abstract guidance.
 */

export interface SpatialDoc {
  id: string;
  title: string;
  body: string;
  /** Tags only used for diagnostics; retrieval is purely vector-based. */
  tags: string[];
}

export const SPATIAL_DOCS: SpatialDoc[] = [
  {
    id: 'doc:geocode-single-column',
    title: 'Geocoding when only a street column exists',
    tags: ['geocode', 'address', 'nominatim'],
    body:
      'When the dataset has only one address-like column (e.g. "Address" with values like "6116 Harvard Avenue") and no city/state/zip, ' +
      'pass that column as the only `address_cols` entry to `geocode.address` AND set `region_hint` to the city/state from the user\'s ' +
      'question or from filename context (e.g. region_hint: "Cedar Key, FL, USA"). Without a hint Nominatim will resolve "Harvard Avenue" ' +
      'in the wrong country. Always set `country_code` for one-country datasets.',
  },
  {
    id: 'doc:geocode-multi-column',
    title: 'Geocoding with full street/city/state columns',
    tags: ['geocode', 'address'],
    body:
      'When the dataset already has separate street, city, state, and (optionally) zip columns, pass them as an array in natural order ' +
      'to `geocode.address` — `address_cols: ["street","city","state","zip"]` — and set `country_code` for the known region. ' +
      'Multi-column geocoding is far more accurate than single-column because Nominatim can disambiguate.',
  },
  {
    id: 'doc:render-map-need-geometry',
    title: 'Rendering a map requires geometry',
    tags: ['render.map', 'geometry'],
    body:
      'The `render.map` tool needs a layer with either a `geom` column or detectable lat/lon columns. If the dataset has neither but ' +
      'has address-like columns, insert a `geocode.address` step first. If the dataset has lat/lon, you can either pass it directly ' +
      '(render.map auto-detects) or build the geom explicitly with `SELECT *, ST_Point(lon, lat) AS geom FROM <dataset>` via the `sql` tool.',
  },
  {
    id: 'doc:reproject-before-distance',
    title: 'Reproject before computing distances in meters',
    tags: ['reproject', 'distance', 'crs'],
    body:
      'If the data is in EPSG:4326 (geographic lon/lat) and the user asks about distances in meters/km/miles, insert a `geometry.reproject` ' +
      'step to a metric CRS (e.g. EPSG:32618 for NYC, EPSG:32617 for Florida) BEFORE any distance/buffer step. Geographic CRS distances are ' +
      'in degrees, which is meaningless for human distances.',
  },
  {
    id: 'doc:hex-vs-fishnet',
    title: 'Hex bins vs fishnet density grids',
    tags: ['hex_bin', 'density_grid', 'aggregate'],
    body:
      'Use `stats.hex_bin` (H3 hexagons) for "show density" / "where do points concentrate" type questions when no specific cell size is ' +
      'requested — H3 resolution 9 is roughly a city block. Use `stats.density_grid` when the user specifies a cell size in meters/km ' +
      '("counts per 500-meter square"). Hex bins look better for visualization; rectangular fishnets are easier to align with administrative ' +
      'boundaries.',
  },
  {
    id: 'doc:concave-vs-convex-hull',
    title: 'Concave vs convex hulls',
    tags: ['hull', 'shape'],
    body:
      'Use `geometry.convex_hull` with `mode: "concave"` (the default) for organic point clusters where you want a tight outline. Use ' +
      '`mode: "convex"` only when explicitly requested or when you want the simplest enclosing shape. Concave hulls follow point-cloud ' +
      'shape; convex hulls bridge across gaps.',
  },
  {
    id: 'doc:point-in-polygon',
    title: 'Tagging points with the polygon they fall inside',
    tags: ['joins', 'spatial_join', 'point_in_polygon'],
    body:
      'For "which neighborhood / district / region does each point belong to" questions, use `joins.spatial_join` with `predicate: "within"` ' +
      '(or the dedicated `joins.point_in_polygon` alias). Output is the points layer enriched with the polygon\'s attributes. Common follow-up: ' +
      'group by the polygon attribute with `stats.aggregate`.',
  },
  {
    id: 'doc:nearest-neighbor',
    title: 'Finding the k closest features',
    tags: ['joins', 'nearest_neighbor', 'distance'],
    body:
      'For "for each X, find the nearest Y" questions, use `joins.nearest_neighbor` with `k: N`. Output is a table of (a_id, b_id, distance) ' +
      'rows. Pair with `stats.aggregate` (group_by a_id, agg_fn mean) when the user asks for "average distance to nearest". Reproject both ' +
      'layers to a metric CRS first if the answer should be in meters.',
  },
  {
    id: 'doc:morans-i',
    title: "Moran's I — global spatial autocorrelation",
    tags: ['morans_i', 'autocorrelation', 'cluster'],
    body:
      'For "are values spatially clustered" questions, use `stats.morans_i` on a layer with both geometry and a numeric column. Output is ' +
      'a single z-score and p-value: positive z = clustered, negative = dispersed, near-zero = random. This is a global statistic — for ' +
      'per-feature hot/cold spot detection use `stats.getis_ord_gi`.',
  },
  {
    id: 'doc:getis-ord',
    title: "Getis-Ord Gi* — local hot-spot detection",
    tags: ['getis_ord_gi', 'hotspot', 'cluster'],
    body:
      'For "where are the hot spots" questions, use `stats.getis_ord_gi` with a `value_col` and a `distance` band in meters (the ' +
      'neighborhood radius). Output adds Gi* z-scores per feature: large positive = hot spot, large negative = cold spot. Show ' +
      'the result with `render.map` and the reader sees a choropleth of significance.',
  },
  {
    id: 'doc:time-grouping',
    title: 'Grouping by time periods',
    tags: ['time', 'date', 'sql', 'aggregate'],
    body:
      'For monthly/yearly/hourly grouping, use a `sql` step with `date_trunc(\'month\', <date_col>)` (DuckDB syntax). Don\'t try to ' +
      'compose a separate time-bin tool — `sql` is the right escape hatch. The output of date_trunc preserves type, so downstream ' +
      'render.chart can use the truncated column as `x`.',
  },
  {
    id: 'doc:sql-escape-hatch',
    title: 'When to use the sql tool',
    tags: ['sql'],
    body:
      'Prefer ONE `sql` step over multiple narrow tools when the question is simple attribute filtering or projection on a single ' +
      'dataset (e.g. "homes priced above $1M"). DO NOT chain multiple sql steps when an existing dedicated tool fits — for spatial ' +
      'joins use `joins.spatial_join`, for buffers use `geometry.buffer`. The validator only allows SELECT/WITH; no DML, no PRAGMA, ' +
      'no read_csv, no httpfs.',
  },
  {
    id: 'doc:render-table-no-geom',
    title: 'render.table on layers with geometry',
    tags: ['render.table', 'geom'],
    body:
      'render.table automatically excludes the `geom` column from output (it would render as opaque WKB bytes). If the layer has no ' +
      'geom, the runner falls back to `SELECT *`. Use render.table when the answer is rows-and-columns and a map is overkill.',
  },
  {
    id: 'doc:render-summary',
    title: 'render.summary text rules',
    tags: ['render.summary'],
    body:
      'render.summary takes a literal English sentence YOU author. Never pass a bare `${var}` reference — substituted values are ' +
      'opaque output handles, not strings the user can read. To embed a number derived from a previous step, write a sentence with ' +
      'a literal number you derive from the visible result: "Found 12 matches." not "Found ${count} matches." (Inline `${var}` is ' +
      'expanded best-effort by the runner from the variable\'s first column, but plan as if it were not.)',
  },
  {
    id: 'doc:dissolve-by-field',
    title: 'Dissolving polygons by an attribute',
    tags: ['dissolve', 'merge'],
    body:
      'For "merge all parcels with the same owner" questions, use `geometry.dissolve` with `by_field`. Output is one polygon per ' +
      'distinct value of the field, with the field carried through. Without by_field the entire layer collapses to a single ' +
      'multipolygon.',
  },
  {
    id: 'doc:difference',
    title: 'Computing layer differences',
    tags: ['difference', 'subtract'],
    body:
      'For "how much of A sits OUTSIDE B" questions, use `geometry.difference`. Output is each feature of A clipped to remove the ' +
      'parts overlapping any feature of B. Pair with `stats.summary_stats` to get total areas.',
  },
  {
    id: 'doc:lat-lon-to-points',
    title: 'Building points from lat/lon columns',
    tags: ['point', 'lat', 'lon'],
    body:
      'A CSV/Excel with `latitude` and `longitude` columns is auto-detected at ingest, so render.map will work directly without an ' +
      'explicit ST_Point step. If column names are unusual ("y", "x", "lat_dd", etc.), name them in a `sql` step: ' +
      'SELECT *, ST_Point(<lon_col>, <lat_col>) AS geom FROM <dataset>.',
  },
  {
    id: 'doc:assumptions-list',
    title: 'plan.assumptions — what belongs there',
    tags: ['plan'],
    body:
      'List CRS choices, column-meaning guesses, and unit interpretations in plan.assumptions so the user can correct them in the ' +
      'plan-review modal before approving. Examples: "price column is USD", "year extracted from sale_date", "all rows are in Florida ' +
      '→ country_code=us".',
  },
  {
    id: 'doc:dataset-name-sanitize',
    title: 'Dataset names are sanitized at ingest',
    tags: ['dataset', 'naming'],
    body:
      'When you reference a dataset in `dataset_refs` or as a tool `layer:` arg, use the EXACT name from the dataset profile block ' +
      'in the system prompt. Filenames are sanitized (spaces → underscores, leading digits get a `t_` prefix). "Community Survey ' +
      'Contact Data .xlsx" becomes "Community_Survey_Contact_Data".',
  },
  {
    id: 'doc:max-100-geocode',
    title: 'Geocoding caps at 100 rows',
    tags: ['geocode', 'limit'],
    body:
      'geocode.address caps input at 100 rows due to public Nominatim rate limits (1 req/sec). For larger datasets the user must ' +
      'either pre-geocode externally or accept a 100-row sample. Tell the user this in plan.assumptions if the input has more rows.',
  },
  {
    id: 'doc:no-raster-no-network',
    title: 'Out-of-scope tools',
    tags: ['scope'],
    body:
      'GeoChatBot is browser-native vector spatial analysis only. Out of scope: raster operations (NDVI, slope, hillshade), network ' +
      'analysis (routing, isochrones), hydrology (flow accumulation), and PostGIS-server-only features (parallel pgr_*). If the user ' +
      'asks for these, render.summary explaining the limitation rather than emitting a half-broken plan.',
  },
  {
    id: 'doc:florida-crs',
    title: 'Best CRS for Florida data',
    tags: ['florida', 'crs', 'reproject'],
    body:
      'For Florida datasets needing meter-accurate distances, reproject to EPSG:32617 (UTM zone 17N covers most of Florida) or ' +
      'EPSG:6346 (Florida East NAD83(2011)). For statewide work prefer EPSG:32617.',
  },
  {
    id: 'doc:nyc-crs',
    title: 'Best CRS for NYC data',
    tags: ['nyc', 'crs', 'reproject'],
    body:
      'For NYC datasets needing meter-accurate distances, reproject to EPSG:32618 (UTM zone 18N) or EPSG:2263 (NY State Plane Long ' +
      'Island, US feet). UTM 18N is the default in the few-shot examples.',
  },
  {
    id: 'doc:shapefile-zip',
    title: 'Shapefiles must be uploaded as a zip',
    tags: ['shapefile', 'ingest'],
    body:
      'A shapefile is a multi-file format (.shp, .shx, .dbf, optional .prj). The widget only accepts shapefiles as a single .zip ' +
      'archive containing all sibling files. If the user drops a bare .shp it will fail to load.',
  },
  {
    id: 'doc:save-plan-button',
    title: 'Saving and recalling plans',
    tags: ['save', 'memory'],
    body:
      'The result-canvas has a Save button on each panel; saved results appear in the Saves rail and persist via localStorage (200 ' +
      'cap, FIFO). The agent does NOT auto-save — it is user-controlled. Saved results are NOT re-fed to the planner unless the user ' +
      'explicitly references them in a new question.',
  },
];
