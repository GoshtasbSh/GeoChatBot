# GeoChatBot — capabilities

Drop a CSV, Excel, GeoJSON, Shapefile zip, or Parquet file and ask
anything from the list below. Everything runs **in your browser**
against your uploaded file. The LLM only sees the column profile
(names, types, sample stats), never the raw row contents.

The bot picks columns for you. You should NEVER have to say "use the
column called X" — the agent inspects the data, classifies columns,
and decides. If your data doesn't contain what you asked about, the
bot will tell you (it won't fabricate).

---

## 1. First-look (data quality)

Drop a file. Ask any of these to decide whether the dataset is
usable BEFORE investing in analysis.

| Ask | Bot behavior |
|---|---|
| `What's in this data?` / `Is this any good?` / `Summary` / `Tell me about it` | One-shot quality report: schema, % null per column, sample rows, numeric stats, spatial extent + CRS guess, date range, duplicates, verdict — via `report.quickscan` |
| `How many rows?` | `stats.aggregate` count → one-line summary |
| `Show me the data` / `Show the table` | `render.table` |
| `Are there any bad coordinates?` / `null-island points?` | `sql` filter for `(0,0)` or out-of-range → `render.table` |
| `Are there duplicates?` | `quickscan` (counts) or `sql` GROUP BY → `render.table` |
| `What's the date range?` | `quickscan` covers it; or `sql MIN/MAX(<date>)` |
| `What CRS / projection is this in?` | `quickscan` reports a coarse guess (`wgs84` / `projected` / `unknown`) from coordinate ranges |

---

## 2. Mapping

| Ask | Tool chain |
|---|---|
| `Show points on map` (lat/lon already present) | `render.map` |
| `Show points on map` (only addresses) | `geocode.address` → `render.map` |
| `Show the polygons` / `show areas` | `render.map` |
| `Show a heatmap / density` | `stats.hex_bin` or `stats.density_grid` → `render.map(style:{colorBy:"count"})` |
| `Show the bbox / extent` | `sql("SELECT ST_AsGeoJSON(ST_Envelope(ST_Union_Agg(geom))) AS geom FROM L")` → `render.map` |
| `Show the convex hull` | `geometry.convex_hull` → `render.map` |
| `Voronoi catchments` | `geometry.voronoi` → `render.map` |

---

## 3. Color-coded maps & legends ✨

The bot can color-code or size features automatically based on any column you reference.

| Ask | Tool chain |
|---|---|
| `Color points by species` (categorical) | `render.map(layer, style:{colorBy:"species"})` — auto-palette |
| `Choropleth by population density` (numeric) | `render.map(layer, style:{colorBy:"pop_density", classification:"quantile"})` — 5-class quintile gradient |
| `Color by income / price / score` (any numeric) | Same as above; categorical vs numeric is auto-detected |
| `Size points by sales` (graduated symbols) | `render.map(layer, style:{radiusBy:"sales"})` |
| `Combine: color by category AND size by sales` | `render.map(layer, style:{colorBy:"region", radiusBy:"sales"})` |

The legend chip appears under the map title showing which column drives the color encoding.

---

## 4. Geometry operations

| Ask | Tool chain |
|---|---|
| `Buffer X by 500 m` / `everything within 500m of X` | `geometry.buffer(X, 500)` → `render.map` |
| `Centroids of polygons` | `geometry.centroid` → `render.map` |
| `Simplify polygons` / `reduce vertices` | `geometry.simplify(layer, tol)` → `render.map` |
| `Area of each polygon` | `sql("SELECT *, ST_Area(geom) AS area_m2 FROM L")` → `render.map(style.colorBy:"area_m2", classification:"quantile")` |
| `Length of each line` | `sql("SELECT *, ST_Length(geom) AS length_m FROM L")` → `render.table` |
| `Union / dissolve all polygons` | `geometry.union(layer)` → `render.map` |
| `Dissolve by attribute` (e.g. by region) | `geometry.dissolve(layer, by:"region")` → `render.map` |
| `Intersection of two layers` | `geometry.intersect(a, b)` → `render.map` |
| `Difference (A minus B)` | `geometry.difference(a, b)` → `render.map` |
| `Reproject to another CRS` | `geometry.reproject(layer, target_crs:"EPSG:3857")` |

---

## 5. Filtering & projection (SQL escape hatch)

| Ask | Tool chain |
|---|---|
| `Show only rows where X > 5` | `sql("SELECT * WHERE X > 5")` → `render.map` |
| `Filter to one neighborhood` | `sql("SELECT * WHERE name = 'X'")` → `render.map` |
| `Outliers in column X` | `sql` with statistical filter → `render.table` |
| Anything custom | `sql(...)` — SELECT / WITH only |

---

## 6. Joins / overlay

| Ask | Tool chain |
|---|---|
| `Count points per polygon` | `joins.spatial_join("within")` → `stats.aggregate(count)` → `render.map` or `render.chart` |
| `Which polygons contain X` | `joins.spatial_join("contains")` → `render.table` |
| `Average X per region` | `joins.spatial_join` → `stats.aggregate(mean, X, group_by:region)` → `render.chart` |
| `Points within 1km of polygons` | `geometry.buffer` → `joins.spatial_join` → `render.map` |
| `Point-in-polygon assignment` | `joins.point_in_polygon(points, polygons)` → `render.map` |
| `Nearest k features` | `joins.nearest_neighbor(a, b, k:5)` → `render.table` |
| `Join sales to neighborhoods by id` (non-spatial) | `sql("SELECT a.*, b.col FROM A a JOIN B b ON a.id = b.id")` → `render.table` |

---

## 7. Distance & nearest

| Ask | Tool chain |
|---|---|
| `Distance between A and B` | `sql` with `ST_Distance` |
| `Nearest X to each Y` | `joins.nearest_neighbor(a, b, k:1)` or `sql` with `ST_Distance` + window |
| `Distance from this point to each row` | `sql("SELECT *, ST_Distance(geom, ST_Point(<lon>,<lat>)) AS dist_m FROM L")` → `render.map(style.colorBy:"dist_m")` |
| `Pairwise distances (small layer)` | `stats.distance_matrix(layer)` → `render.table` |
| `Within 1km of point P` | `sql` with `ST_DWithin` → `render.map` |

---

## 8. Aggregation & ranking

| Ask | Tool chain |
|---|---|
| `Average X by region` | `stats.aggregate(mean, value_col:X, group_by:region)` → `render.chart` |
| `Total / sum of X` | `stats.aggregate(sum)` → `render.summary` |
| `Median of X` | `stats.aggregate(median)` |
| `Distribution / histogram of X` | `stats.aggregate(group_by:X, agg_fn:count)` → `render.chart` |
| `Percentiles of X (p50, p95)` | `sql("SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY X) AS p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY X) AS p95 FROM L")` → `render.table` |
| `Summary stats for X, Y, Z` | `stats.summary_stats(layer, columns:["X","Y","Z"])` → `render.table` |
| `X over time` | `stats.aggregate(group_by:<date>, value_col:X, sum)` → `render.chart kind:"line"` |
| **`Top 10 X`** / `best 10` | `sql` with `ORDER BY X DESC LIMIT 10` → `render.table` or `render.map` |
| **`Worst 10 X`** / **`worst street for walkability`** | `stats.aggregate(group_by:<entity>, value_col:<concept_col>, agg_fn:"mean")` → `sql ORDER BY ... ASC LIMIT 10` → `render.table` |

---

## 9. Concept questions ("walkability", "transit access", "health")

When you ask about a domain concept, the bot searches your dataset for the closest matching column:

| You ask about | Bot looks for columns matching |
|---|---|
| **Walkability** | `walk_score`, `walkability`, `sidewalk_*`, `ped_*`, `walk_index` |
| **Transit / transportation** | `transit_*`, `bus_*`, `rail_*`, `gtfs_*`, `commute_*`, `stops_*`, `route_*` |
| **Health** | `health_*`, `mortality`, `life_exp*`, `prevalence_*`, `bmi_*`, `asthma_*`, `*_rate` |
| **Safety / crime** | `crime_*`, `incident_*`, `accident_*`, `fatal_*`, `injury_*` |
| **Income / SES** | `income`, `median_hh_income`, `poverty_*`, `median_value`, `hh_*` |
| **Demographics** | `pop_*`, `age_*`, `race_*`, `ethn_*`, `dens_*`, `hh_count` |
| **Education** | `edu_*`, `school_*`, `grade_*`, `college_*` |
| **Air quality / pollution** | `aqi`, `pm25`, `pm10`, `no2`, `o3`, `pollution_*`, `emissions_*` |

If **NO** matching column is found, the bot will list the columns you DO have and ask you to either rephrase or upload data with the needed measure. It will NOT fabricate a value.

---

## 10. Pre-flight quality auto-checks (the planner runs these silently)

Before answering ANY geographic question, the planner thinks through these and surfaces them when they affect the answer:

| Check | How |
|---|---|
| **Lat/lon swap** | A "lat" column with values in [-180,180] while "lon" sits in [-90,90] → flipped |
| **Null-island sentinels** | Points at (0, 0) — common "no geocode" defaults |
| **Projected coordinates mistakenly WGS84** | `|x| > 200` → not lon/lat |
| **Mixed geometry types** | `GROUP BY GeometryType(geom)` → Point+Polygon in one layer warned before area/length ops |
| **Invalid geometry** | `ST_IsValid(geom)` → repair via `ST_MakeValid` |
| **Duplicate geometries** | `GROUP BY ST_AsHEXWKB(geom)` HAVING COUNT > 1 |
| **Antimeridian crossing** | Bbox span > 270° on lon |
| **Rate vs count (MAUP guard)** | Mapping a raw count by polygon → suggest per-capita / per-km² normalization |
| **CRS mismatch between layers** | Compare bboxes; warn if one is WGS84 + other is projected |

---

## 11. Spatial-pattern / autocorrelation (ESDA)

These are what every Exploratory Spatial Data Analysis tutorial recommends after "show points on a map."

| Ask | How the bot answers |
|---|---|
| `Are the values spatially clustered or random?` | Global **Moran's I** with a binary distance-band weights matrix, computed via `sql` (5000-row cap for browser memory) → `render.summary` with the I value and interpretation |
| `Find hot spots` / `Getis-Ord Gi*` | Local hotspot statistic via `sql` (browser-scale approximation) → `render.map(style.colorBy:"gi_z")` |
| `Find clusters of similar values` / `LISA` | Local Moran's I via `sql` → `render.map` colored by cluster class |
| `Find areas with high density of X` | Grid-based hexbin via `sql(TRUNC(lon/STEP)*STEP …)` → `render.map(style.colorBy:"count")` |

---

## 12. Domain-specific analyses (Tier 3 from the research)

The bot can construct these from existing primitives + `sql`:

| Ask | Tool chain |
|---|---|
| **Equity / disparate-impact analysis** (worst access to X by demographic) | `joins.spatial_join(amenities, demographics)` → `stats.aggregate(group_by:"<demographic>")` → `render.chart` |
| **Food / health / transit "desert" detection** | `geometry.buffer(amenities, threshold)` → `sql("WHERE NOT ST_Intersects(...)")` → `render.map` colored by population |
| **Comparable parcels** (k-NN by attribute, constrained spatially) | `sql` with `ST_DWithin` filter + `ORDER BY |a.attr - target|` LIMIT k |
| **Origin-destination flow / desire lines** | `sql` joining trips, `ST_MakeLine(origin, destination)` → `render.map` (lines styled by flow count) |
| **Trade area / catchment** | `geometry.buffer` or Voronoi → `joins.spatial_join` |
| **Change between year A and year B** | `sql("SELECT a.id, a.x AS x_a, b.x AS x_b, b.x - a.x AS delta FROM A a JOIN B b ON a.id = b.id")` → `render.map(style.colorBy:"delta")` |
| **Time facet** (X by hour-of-day / month / season) | `sql` with `EXTRACT` → `stats.aggregate` → `render.chart` |

---

## 13. Spatial autocorrelation primitives

| Ask | Tool chain |
|---|---|
| `Global Moran's I on column X` | `stats.morans_i(layer, value_col:"X")` → `render.summary` |
| `Local hot/cold spots` (Getis-Ord Gi*) | `stats.getis_ord_gi(layer, value_col:"X")` → `render.map(style.colorBy:"gi_z")` |

## 14. Interpolation (raster)

GeoChatBot does not ship a dedicated IDW / kriging tool. For inverse-distance weighting, the agent will hand-author a `sql` query that builds a target grid + computes weighted means against the input points (small grids only — a 200×200 target with 5000 source points is roughly the in-browser ceiling). For full kriging or multi-band raster algebra, export to GDAL / scikit-gstat / GRASS.

---

## What the bot will NOT do (out of scope)

- **Full raster GIS** (multi-band imagery, raster algebra beyond IDW)
- **Routing / isochrones** (needs a road graph engine)
- **Hydrology / network analysis** (PostGIS / GRASS territory)
- **Editing geometry** (the widget is read-only)
- **Reprojection beyond a coarse heuristic** (no PROJ.4 in WASM yet — the bot warns if a CRS looks projected but cannot reproject for you)
- **Server-side compute** — everything is in-browser, no backend
- **Multi-layer composite maps** in one map card today (each `render.map` is its own card)

For these, use GeoChatBot for the exploratory first look then export to QGIS / Python / R for the heavy lifting.

---

## How the bot reasons (the agentic loop)

For agentic-capable providers (Groq, OpenAI), every question goes through:

1. **Restate** your goal in one sentence
2. **Match** the question to one of ~30 canonical patterns
3. **Inspect** the dataset — list columns, sample rows, classify ambiguous columns
4. **Bind** real column names to the chosen tool chain
5. **Submit** the plan for your approval before execution

You see the reasoning trace stream live in the chat — every inspection call, every observation, every decision — so the bot's "thinking" is auditable. After approval, the executor runs DuckDB-WASM against the file in your browser. No data leaves except a small column-profile summary sent to your LLM provider.
