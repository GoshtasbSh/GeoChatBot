import type { Plan } from "../types.js";

export interface Example {
	question: string;
	plan: Plan;
}

export const EXAMPLES: Example[] = [
	// 1 — Aggregate-by-region
	{
		question: "Which NYC neighborhoods sold the most homes in 2024?",
		plan: {
			goal: "Rank NYC neighborhoods by 2024 home-sale volume",
			assumptions: [
				"price column is sale price in USD",
				"year extracted from sale_date",
			],
			dataset_refs: ["sales", "neighborhoods"],
			steps: [
				{
					id: "s1",
					tool: "sql",
					args: {
						query:
							"SELECT * FROM sales WHERE EXTRACT(year FROM sale_date) = 2024",
					},
					output_var: "sales_2024",
					why: "Filter sales to calendar year 2024 only",
				},
				{
					id: "s2",
					tool: "joins.spatial_join",
					args: { a: "${sales_2024}", b: "neighborhoods", predicate: "within" },
					output_var: "tagged",
					why: "Tag each sale with the neighborhood it falls inside",
				},
				{
					id: "s3",
					tool: "stats.aggregate",
					args: {
						layer: "${tagged}",
						group_by: "neighborhood_name",
						agg_fn: "sum",
						value_col: "price",
					},
					output_var: "totals",
					why: "Sum sale prices per neighborhood",
				},
				{
					id: "s4",
					tool: "render.chart",
					args: {
						table: "${totals}",
						kind: "bar",
						x: "neighborhood_name",
						y: "sum_price",
					},
					why: "Visualize neighborhood ranking",
				},
			],
		},
	},
	// 2 — Buffer-then-overlay
	{
		question: "Show schools within 500 m of any hospital.",
		plan: {
			goal: "Find schools within 500 m of a hospital",
			assumptions: ["data is in EPSG:4326; reproject for accurate meters"],
			dataset_refs: ["schools", "hospitals"],
			steps: [
				{
					id: "s1",
					tool: "geometry.reproject",
					args: { layer: "hospitals", to_crs: "EPSG:32618" },
					output_var: "h_m",
					why: "Reproject to UTM 18N for accurate meter-based buffer",
				},
				{
					id: "s2",
					tool: "geometry.buffer",
					args: { layer: "${h_m}", distance: 500, units: "meters" },
					output_var: "h_buf",
					why: "Expand each hospital by 500 m",
				},
				{
					id: "s3",
					tool: "joins.spatial_join",
					args: { a: "schools", b: "${h_buf}", predicate: "within" },
					output_var: "matched",
					why: "Find schools inside any buffer",
				},
				{
					id: "s4",
					tool: "render.map",
					args: { layer: "${matched}" },
					why: "Show the matching schools on the map",
				},
			],
		},
	},
	// 3 — Hot-spot analysis (Getis-Ord)
	{
		question: "Where are the crime hot spots within 1 km in NYC?",
		plan: {
			goal: "Identify crime hot spots using Getis-Ord Gi*",
			assumptions: [
				"count column already represents events per block",
				"distance band is 1000 m",
			],
			dataset_refs: ["crime_per_block"],
			steps: [
				{
					id: "s1",
					tool: "sql",
					args: {
						query: "SELECT * FROM crime_per_block WHERE count IS NOT NULL",
					},
					output_var: "cleaned",
					why: "Drop blocks missing the count value",
				},
				{
					id: "s2",
					tool: "stats.getis_ord_gi",
					args: { layer: "${cleaned}", value_col: "count", distance: 1000 },
					output_var: "gi_scores",
					why: "Compute hot/cold spot z-scores per block within 1 km",
				},
				{
					id: "s3",
					tool: "render.map",
					args: { layer: "${gi_scores}" },
					why: "Show hot/cold spot map",
				},
			],
		},
	},
	// 4 — Hex-bin density
	{
		question: "Show me where Citi Bike pickups concentrate.",
		plan: {
			goal: "Visualize pickup density across the city using hex bins",
			assumptions: [
				"pickups is a point layer",
				"H3 resolution 9 is a city-block-ish cell",
			],
			dataset_refs: ["pickups"],
			steps: [
				{
					id: "s1",
					tool: "stats.hex_bin",
					args: { layer: "pickups", h3_resolution: 9 },
					output_var: "hex_counts",
					why: "Aggregate pickup points into H3 hex cells at resolution 9",
				},
				{
					id: "s2",
					tool: "render.map",
					args: { layer: "${hex_counts}" },
					why: "Render the hex density on a map",
				},
			],
		},
	},
	// 5 — Reproject for distance
	{
		question:
			"On average, how far is each home from the nearest subway station, in meters?",
		plan: {
			goal: "Compute mean home-to-nearest-subway distance in meters",
			assumptions: [
				"both layers are EPSG:4326 and need reprojection for meter accuracy",
			],
			dataset_refs: ["homes", "subway"],
			steps: [
				{
					id: "s1",
					tool: "geometry.reproject",
					args: { layer: "homes", to_crs: "EPSG:32618" },
					output_var: "homes_m",
					why: "Reproject homes to UTM 18N for meter accuracy",
				},
				{
					id: "s2",
					tool: "geometry.reproject",
					args: { layer: "subway", to_crs: "EPSG:32618" },
					output_var: "subway_m",
					why: "Reproject subway stations to the same CRS",
				},
				{
					id: "s3",
					tool: "joins.nearest_neighbor",
					args: { a: "${homes_m}", b: "${subway_m}", k: 1 },
					output_var: "pairs",
					why: "For each home, the single nearest station and its distance",
				},
				{
					id: "s4",
					tool: "stats.summary_stats",
					args: { layer: "${pairs}", columns: ["distance"] },
					output_var: "dist_stats",
					why: "Compute mean/min/max of the home-to-station distance",
				},
				{
					id: "s5",
					tool: "render.summary",
					args: {
						text: "See the distance summary table for the average home-to-subway distance.",
					},
					why: "Tell the user the result in plain English",
				},
			],
		},
	},
	// 6 — Voronoi service areas
	{
		question: "Carve Manhattan into the catchment area of each fire station.",
		plan: {
			goal: "Divide an area by the nearest fire station using Voronoi polygons",
			assumptions: ["boroughs is the bounding polygon for Manhattan"],
			dataset_refs: ["fire_stations", "boroughs"],
			steps: [
				{
					id: "s1",
					tool: "geometry.voronoi",
					args: { points: "fire_stations" },
					output_var: "cells",
					why: "Build Voronoi polygons over fire-station points",
				},
				{
					id: "s2",
					tool: "geometry.intersect",
					args: { a: "${cells}", b: "boroughs" },
					output_var: "clipped",
					why: "Clip the cells to the borough boundary so they do not extend beyond the city",
				},
				{
					id: "s3",
					tool: "render.map",
					args: { layer: "${clipped}" },
					why: "Show the catchment areas on the map",
				},
			],
		},
	},
	// 7 — Dissolve polygons
	{
		question: "Merge all parcels with the same owner into one polygon.",
		plan: {
			goal: "Dissolve parcels by owner into single multipolygons",
			assumptions: [
				"parcels has an owner_id column shared across parcels owned by the same entity",
			],
			dataset_refs: ["parcels"],
			steps: [
				{
					id: "s1",
					tool: "geometry.dissolve",
					args: { layer: "parcels", by_field: "owner_id" },
					output_var: "owner_blocks",
					why: "Combine adjacent and detached parcels per owner into one shape",
				},
				{
					id: "s2",
					tool: "render.map",
					args: { layer: "${owner_blocks}" },
					why: "Show the owner-level polygons",
				},
			],
		},
	},
	// 8 — Difference / clip-out
	{
		question: "How much of the watershed sits outside protected areas?",
		plan: {
			goal: "Compute watershed area outside protected boundaries",
			assumptions: [
				"both layers share the same CRS",
				"shape_area column holds polygon area in sq meters",
			],
			dataset_refs: ["watershed", "protected_areas"],
			steps: [
				{
					id: "s1",
					tool: "geometry.difference",
					args: { a: "watershed", b: "protected_areas" },
					output_var: "unprotected",
					why: "Keep only the parts of the watershed not covered by protected areas",
				},
				{
					id: "s2",
					tool: "stats.summary_stats",
					args: { layer: "${unprotected}", columns: ["shape_area"] },
					output_var: "area_stats",
					why: "Summarize the area of the unprotected watershed",
				},
				{
					id: "s3",
					tool: "render.summary",
					args: {
						text: "The summary table shows the total unprotected watershed area.",
					},
					why: "Communicate the area number to the user",
				},
			],
		},
	},
	// 9 — Multi-dataset comparison (grouped bar)
	{
		question: "Compare 311 complaint counts across boroughs by complaint type.",
		plan: {
			goal: "Grouped-bar comparison of 311 counts by borough and complaint type",
			assumptions: [
				"complaints_311 is a point layer with a complaint_type column",
			],
			dataset_refs: ["complaints_311", "boroughs"],
			steps: [
				{
					id: "s1",
					tool: "joins.spatial_join",
					args: { a: "complaints_311", b: "boroughs", predicate: "within" },
					output_var: "tagged",
					why: "Tag each complaint with its borough",
				},
				{
					id: "s2",
					tool: "stats.aggregate",
					args: {
						layer: "${tagged}",
						group_by: ["borough_name", "complaint_type"],
						agg_fn: "count",
						value_col: "complaint_id",
					},
					output_var: "totals",
					why: "Count complaints per (borough, complaint type) pair",
				},
				{
					id: "s3",
					tool: "render.chart",
					args: {
						table: "${totals}",
						kind: "grouped_bar",
						x: "borough_name",
						y: "count_complaint_id",
						group: "complaint_type",
					},
					why: "Show grouped bars per borough split by complaint type",
				},
			],
		},
	},
	// 10 — Moran's I
	{
		question:
			"Are housing prices spatially clustered across NYC neighborhoods?",
		plan: {
			goal: "Test spatial autocorrelation of mean home price using Moran's I",
			assumptions: [
				"queen contiguity is appropriate for adjacent neighborhood polygons",
			],
			dataset_refs: ["sales", "neighborhoods"],
			steps: [
				{
					id: "s1",
					tool: "joins.spatial_join",
					args: { a: "sales", b: "neighborhoods", predicate: "within" },
					output_var: "tagged",
					why: "Attach each sale to its neighborhood",
				},
				{
					id: "s2",
					tool: "stats.aggregate",
					args: {
						layer: "${tagged}",
						group_by: "neighborhood_name",
						agg_fn: "mean",
						value_col: "price",
					},
					output_var: "avg_price",
					why: "Compute mean sale price per neighborhood",
				},
				{
					id: "s3",
					tool: "stats.morans_i",
					args: {
						layer: "${avg_price}",
						value_col: "mean_price",
						weights: "queen",
					},
					output_var: "moran",
					why: "Run global Moran's I on neighborhood means",
				},
				{
					id: "s4",
					tool: "render.summary",
					args: {
						text: "See the Moran's I statistic and p-value to decide whether prices are clustered.",
					},
					why: "Explain the result in one sentence",
				},
			],
		},
	},
	// 11 — Pure-SQL escape hatch
	{
		question: "Show me only the homes priced above one million dollars.",
		plan: {
			goal: "Filter homes by price threshold and map them",
			assumptions: ["price is in USD"],
			dataset_refs: ["homes"],
			steps: [
				{
					id: "s1",
					tool: "sql",
					args: { query: "SELECT * FROM homes WHERE price > 1000000" },
					output_var: "pricey",
					why: "Keep only homes priced above $1M",
				},
				{
					id: "s2",
					tool: "render.map",
					args: { layer: "${pricey}" },
					why: "Show the filtered homes on the map",
				},
			],
		},
	},
	// 12 — Concave hull
	{
		question: "Outline the area where Citi Bike pickups happened today.",
		plan: {
			goal: "Draw the organic boundary of pickup activity using a concave hull",
			assumptions: ["ride_date is a date column"],
			dataset_refs: ["trips"],
			steps: [
				{
					id: "s1",
					tool: "sql",
					args: { query: "SELECT * FROM trips WHERE ride_date = CURRENT_DATE" },
					output_var: "today_trips",
					why: "Filter trips to today only",
				},
				{
					id: "s2",
					tool: "geometry.convex_hull",
					args: { layer: "${today_trips}", mode: "concave" },
					output_var: "shape",
					why: "Fit a concave boundary around the day-of points",
				},
				{
					id: "s3",
					tool: "render.map",
					args: { layer: "${shape}" },
					why: "Show the activity envelope",
				},
			],
		},
	},
	// 13 — Time-aware aggregation
	{
		question: "Plot monthly accident counts per borough for the last year.",
		plan: {
			goal: "Show a monthly time-series of accidents grouped by borough",
			assumptions: [
				"accidents has a crash_date column",
				"borough joined via spatial join",
			],
			dataset_refs: ["accidents", "boroughs"],
			steps: [
				{
					id: "s1",
					tool: "joins.spatial_join",
					args: { a: "accidents", b: "boroughs", predicate: "within" },
					output_var: "tagged",
					why: "Attach each accident to its borough",
				},
				{
					id: "s2",
					tool: "sql",
					args: {
						query:
							"SELECT borough_name, date_trunc('month', crash_date) AS month, COUNT(*) AS n FROM tagged WHERE crash_date >= CURRENT_DATE - INTERVAL '1 year' GROUP BY 1, 2",
					},
					output_var: "monthly",
					why: "Bucket accidents by month and borough for the last year",
				},
				{
					id: "s3",
					tool: "render.chart",
					args: {
						table: "${monthly}",
						kind: "line",
						x: "month",
						y: "n",
						group: "borough_name",
					},
					why: "Render one line per borough over time",
				},
			],
		},
	},
	// 14 — Fishnet density grid
	{
		question:
			"Show the number of accidents per 500-meter cell across the city.",
		plan: {
			goal: "Build a fishnet density grid of accident counts at 500 m resolution",
			assumptions: [
				"accidents is in EPSG:4326 and must be reprojected before meter cells",
			],
			dataset_refs: ["accidents"],
			steps: [
				{
					id: "s1",
					tool: "geometry.reproject",
					args: { layer: "accidents", to_crs: "EPSG:32618" },
					output_var: "a_m",
					why: "Reproject so cell_size in meters is meaningful",
				},
				{
					id: "s2",
					tool: "stats.density_grid",
					args: { layer: "${a_m}", cell_size: 500, agg_fn: "count" },
					output_var: "grid",
					why: "Aggregate accidents into 500 m square cells",
				},
				{
					id: "s3",
					tool: "render.map",
					args: { layer: "${grid}" },
					why: "Show the density grid on the map",
				},
			],
		},
	},
	// 15 — kNN k>1 + summary
	{
		question:
			"For each home, summarize the average distance to its 3 nearest schools.",
		plan: {
			goal: "Compute home-level mean distance to k=3 nearest schools, then summarize",
			assumptions: ["both layers already share a metric CRS"],
			dataset_refs: ["homes", "schools"],
			steps: [
				{
					id: "s1",
					tool: "joins.nearest_neighbor",
					args: { a: "homes", b: "schools", k: 3 },
					output_var: "pairs",
					why: "For each home, the 3 closest schools and their distances",
				},
				{
					id: "s2",
					tool: "stats.aggregate",
					args: {
						layer: "${pairs}",
						group_by: "a_id",
						agg_fn: "mean",
						value_col: "distance",
					},
					output_var: "mean_per_home",
					why: "Average the 3 distances per home",
				},
				{
					id: "s3",
					tool: "stats.summary_stats",
					args: { layer: "${mean_per_home}", columns: ["mean_distance"] },
					output_var: "overall",
					why: "Summary stats over per-home means",
				},
				{
					id: "s4",
					tool: "render.summary",
					args: {
						text: "See the overall distance-to-3-nearest-schools summary table.",
					},
					why: "Communicate the citywide stat to the user",
				},
			],
		},
	},
	// 16 — Composite multi-step
	{
		question: "Show median sale price by census tract, only for sales in 2024.",
		plan: {
			goal: "Map median 2024 sale price per census tract",
			assumptions: [
				"sale_date is a date column",
				"census_tracts is a polygon layer",
			],
			dataset_refs: ["sales", "census_tracts"],
			steps: [
				{
					id: "s1",
					tool: "geometry.reproject",
					args: { layer: "sales", to_crs: "EPSG:32618" },
					output_var: "sales_m",
					why: "Reproject sales to a metric CRS for downstream consistency",
				},
				{
					id: "s2",
					tool: "sql",
					args: {
						query:
							"SELECT * FROM sales_m WHERE EXTRACT(year FROM sale_date) = 2024",
					},
					output_var: "sales_24",
					why: "Limit to 2024 sales",
				},
				{
					id: "s3",
					tool: "stats.aggregate",
					args: {
						layer: "${sales_24}",
						group_by: "tract_id",
						agg_fn: "median",
						value_col: "price",
					},
					output_var: "median_by_tract",
					why: "Compute median price per tract",
				},
				{
					id: "s4",
					tool: "render.map",
					args: { layer: "${median_by_tract}" },
					why: "Show the choropleth on the map",
				},
			],
		},
	},
	// 17 — Multi-CRS alignment
	{
		question:
			"For each parking meter, find the nearest coffee shop and average distance per block.",
		plan: {
			goal: "Reproject both layers to a common CRS, find nearest neighbor, then aggregate",
			assumptions: [
				"layers may have differing CRSes; UTM 18N is appropriate for NYC",
			],
			dataset_refs: ["parking_meters", "coffee_shops"],
			steps: [
				{
					id: "s1",
					tool: "geometry.reproject",
					args: { layer: "parking_meters", to_crs: "EPSG:32618" },
					output_var: "meters_m",
					why: "Bring meters into a metric CRS",
				},
				{
					id: "s2",
					tool: "geometry.reproject",
					args: { layer: "coffee_shops", to_crs: "EPSG:32618" },
					output_var: "shops_m",
					why: "Bring shops into the same CRS for valid distance",
				},
				{
					id: "s3",
					tool: "joins.nearest_neighbor",
					args: { a: "${meters_m}", b: "${shops_m}", k: 1 },
					output_var: "pairs",
					why: "For each meter, the closest coffee shop",
				},
				{
					id: "s4",
					tool: "stats.aggregate",
					args: {
						layer: "${pairs}",
						group_by: "block_id",
						agg_fn: "mean",
						value_col: "distance",
					},
					output_var: "block_avg",
					why: "Average meter-to-shop distance per block",
				},
				{
					id: "s5",
					tool: "render.map",
					args: { layer: "${block_avg}" },
					why: "Show per-block averages on the map",
				},
			],
		},
	},
	// 18 — Lat/lon → point geom
	{
		question: "Plot the bike stations from a lat/lon table.",
		plan: {
			goal: "Build a point layer from lat/lon columns and render it",
			assumptions: ["lon and lat columns exist on bike_stations"],
			dataset_refs: ["bike_stations"],
			steps: [
				{
					id: "s1",
					tool: "sql",
					args: {
						query: "SELECT *, ST_Point(lon, lat) AS geom FROM bike_stations",
					},
					output_var: "pts",
					why: "Build a point geometry from the lat/lon columns",
				},
				{
					id: "s2",
					tool: "render.map",
					args: { layer: "${pts}" },
					why: "Show the bike stations on the map",
				},
			],
		},
	},
	// 19 — Distance matrix + ranking
	{
		question:
			"Rank fire stations by their average distance to the 5 nearest hydrants.",
		plan: {
			goal: "Compute station-to-5-nearest-hydrant distances and rank stations",
			assumptions: ["both layers share a metric CRS or are pre-projected"],
			dataset_refs: ["fire_stations", "hydrants"],
			steps: [
				{
					id: "s1",
					tool: "stats.distance_matrix",
					args: { a: "fire_stations", b: "hydrants", k: 5 },
					output_var: "dm",
					why: "Distance from each station to its 5 nearest hydrants",
				},
				{
					id: "s2",
					tool: "stats.aggregate",
					args: {
						layer: "${dm}",
						group_by: "a_id",
						agg_fn: "mean",
						value_col: "distance",
					},
					output_var: "station_means",
					why: "Mean distance per station",
				},
				{
					id: "s3",
					tool: "render.chart",
					args: {
						table: "${station_means}",
						kind: "bar",
						x: "a_id",
						y: "mean_distance",
					},
					why: "Bar chart ranking stations by mean nearest-hydrant distance",
				},
			],
		},
	},
	// 20 — Composite Moran's I + Getis-Ord
	{
		question:
			"Are 311 complaints spatially clustered, and where are the hot spots?",
		plan: {
			goal: "Combine global Moran's I and local Getis-Ord Gi* on per-tract complaint counts",
			assumptions: [
				"census_tracts polygons cover the study area",
				"distance band of 1500 m for Gi*",
			],
			dataset_refs: ["complaints_311", "census_tracts"],
			steps: [
				{
					id: "s1",
					tool: "joins.spatial_join",
					args: {
						a: "complaints_311",
						b: "census_tracts",
						predicate: "within",
					},
					output_var: "tagged",
					why: "Tag each complaint with its census tract",
				},
				{
					id: "s2",
					tool: "stats.aggregate",
					args: {
						layer: "${tagged}",
						group_by: "tract_id",
						agg_fn: "count",
						value_col: "complaint_id",
					},
					output_var: "tract_counts",
					why: "Count complaints per tract",
				},
				{
					id: "s3",
					tool: "stats.morans_i",
					args: {
						layer: "${tract_counts}",
						value_col: "count_complaint_id",
						weights: "queen",
					},
					output_var: "moran",
					why: "Test global spatial autocorrelation of counts",
				},
				{
					id: "s4",
					tool: "stats.getis_ord_gi",
					args: {
						layer: "${tract_counts}",
						value_col: "count_complaint_id",
						distance: 1500,
					},
					output_var: "hot_spots",
					why: "Identify per-tract hot/cold spots within 1.5 km",
				},
				{
					id: "s5",
					tool: "render.map",
					args: { layer: "${hot_spots}" },
					why: "Show the local hot/cold spot map",
				},
			],
		},
	},
	// 21 — Geocode multi-column US addresses then map them
	{
		question: "Show me the Florida community survey responses on a map.",
		plan: {
			goal: "Map the survey responses by geocoding their street + city + state columns",
			assumptions: [
				"survey has street/city/state columns and no geometry",
				"all rows are in Florida → bias geocoder to country_code=us for accurate matches",
			],
			dataset_refs: ["survey"],
			steps: [
				{
					id: "s1",
					tool: "geocode.address",
					args: {
						layer: "survey",
						address_cols: ["street", "city", "state"],
						country_code: "us",
					},
					output_var: "survey_geo",
					why: "Concatenate street + city + state and geocode with US bias so every address resolves to the right state",
				},
				{
					id: "s2",
					tool: "render.map",
					args: { layer: "${survey_geo}" },
					why: "Plot the geocoded survey points on the map",
				},
			],
		},
	},
	// 22 — Single-column address with explicit city/state from the question
	{
		question: "Show this Cedar Key, FL community survey on a map.",
		plan: {
			goal: "Map the survey responses given only a single Address column and a known city/state",
			assumptions: [
				'survey has only one address-like column ("Address") and no geometry',
				"user specified Cedar Key, FL → use region_hint to scope every address before geocoding",
			],
			dataset_refs: ["survey"],
			steps: [
				{
					id: "s1",
					tool: "geocode.address",
					args: {
						layer: "survey",
						address_cols: ["Address"],
						country_code: "us",
						region_hint: "Cedar Key, FL, USA",
					},
					output_var: "survey_geo",
					why: 'Append "Cedar Key, FL, USA" to every street so Nominatim disambiguates the right Harvard Avenue',
				},
				{
					id: "s2",
					tool: "render.map",
					args: { layer: "${survey_geo}" },
					why: "Plot the geocoded survey points on the map",
				},
			],
		},
	},
	// 23 — First-look data-quality report (the "vague question" pattern)
	{
		question: "What's in this dataset?",
		plan: {
			goal: "Produce a one-shot data-quality report so the user can decide whether the dataset is usable",
			assumptions: [
				"user did not ask for analysis; they want a first-look summary",
			],
			dataset_refs: ["data"],
			steps: [
				{
					id: "s1",
					tool: "report.quickscan",
					args: { dataset: "data" },
					why: "Single-call schema + completeness + spatial extent + verdict; no further steps needed",
				},
			],
		},
	},
	// 24 — Direct map from lat/lon when no geocoding is needed
	{
		question: "Show the points on the map.",
		plan: {
			goal: "Render the dataset as point features given existing lat/lon columns",
			assumptions: [
				'data already has a "Latitude" column in [-90,90] and a "Longitude" column in [-180,180]',
				"no geocoding needed",
			],
			dataset_refs: ["data"],
			steps: [
				{
					id: "s1",
					tool: "render.map",
					args: { layer: "data" },
					why: "Loader already attached a geom view from the lat/lon pair; render directly",
				},
			],
		},
	},
	// 25 — Count points per polygon (choropleth)
	{
		question: "How many incidents occurred in each neighborhood?",
		plan: {
			goal: "Aggregate incident points by neighborhood polygon",
			assumptions: [
				"incidents has point geometry and an `id` column",
				'neighborhoods has polygon geometry with a "name" column',
			],
			dataset_refs: ["incidents", "neighborhoods"],
			steps: [
				{
					id: "s1",
					tool: "joins.spatial_join",
					args: { a: "incidents", b: "neighborhoods", predicate: "within" },
					output_var: "tagged",
					why: "Tag each incident with its containing neighborhood",
				},
				{
					id: "s2",
					tool: "stats.aggregate",
					args: {
						layer: "${tagged}",
						group_by: "name",
						agg_fn: "count",
						value_col: "id",
					},
					output_var: "totals",
					why: "Count incidents per neighborhood name (value_col is required by the schema; any non-null column works for COUNT)",
				},
				{
					id: "s3",
					tool: "render.chart",
					args: {
						table: "${totals}",
						kind: "bar",
						x: "name",
						y: "count_id",
					},
					why: "Bar chart of incident counts per neighborhood",
				},
			],
		},
	},
	// 26 — Color-coded points by a categorical attribute
	{
		question: "Show the trees on the map colored by species.",
		plan: {
			goal: "Render the tree dataset as point features color-coded by the `species` attribute",
			assumptions: [
				"trees has point geometry and a `species` string column",
				"species is a categorical column with low-to-medium cardinality",
			],
			dataset_refs: ["trees"],
			steps: [
				{
					id: "s1",
					tool: "render.map",
					args: { layer: "trees", style: { colorBy: "species" } },
					why: "Categorical palette is auto-applied per distinct species",
				},
			],
		},
	},
	// 26a — Generic "color code the points" on messy categorical text.
	// Demonstrates the bucket-then-color pattern from pattern 14a: when
	// the candidate column has many unique-ish strings with semantic
	// patterns (survey contact outcomes here), bucket via CASE WHEN
	// before render.map — otherwise the hash palette collapses the
	// data into noise.
	{
		question: "Color code the points.",
		plan: {
			goal: "Render the survey points colored by a meaningful bucketed status derived from the messy `First attempt` free-text column",
			assumptions: [
				"`First attempt` is high-cardinality free text with semantic patterns (completed/no-answer/gated/vacant/not-interested) and is the best categorical signal in the dataset",
				"no clean low-cardinality status column exists, so we bucket via SQL before rendering",
			],
			dataset_refs: ["survey"],
			steps: [
				{
					id: "s1",
					tool: "sql",
					args: {
						query:
							"SELECT *, CASE " +
							"WHEN LOWER(\"First attempt\") LIKE '%completed%' OR LOWER(\"First attempt\") LIKE '%survey%' OR LOWER(\"First attempt\") LIKE '%took survey%' THEN 'completed' " +
							"WHEN LOWER(\"First attempt\") LIKE '%no one home%' OR LOWER(\"First attempt\") LIKE '%no answer%' OR LOWER(\"First attempt\") LIKE '%not home%' THEN 'no_answer' " +
							"WHEN LOWER(\"First attempt\") LIKE '%gated%' OR LOWER(\"First attempt\") LIKE '%locked%' OR LOWER(\"First attempt\") LIKE '%no trespass%' OR LOWER(\"First attempt\") LIKE '%inaccessible%' THEN 'inaccessible' " +
							"WHEN LOWER(\"First attempt\") LIKE '%vacant%' OR LOWER(\"First attempt\") LIKE '%for sale%' OR LOWER(\"First attempt\") LIKE '%uninhabited%' OR LOWER(\"First attempt\") LIKE '%no house%' THEN 'vacant' " +
							"WHEN LOWER(\"First attempt\") LIKE '%not interested%' OR LOWER(\"First attempt\") LIKE '%declined%' THEN 'declined' " +
							"WHEN LOWER(\"First attempt\") LIKE '%flier%' OR LOWER(\"First attempt\") LIKE '%qr%' OR LOWER(\"First attempt\") LIKE '%come back%' OR LOWER(\"First attempt\") LIKE '%no time%' THEN 'follow_up' " +
							"ELSE 'other' END AS contact_status FROM survey",
					},
					why: "Bucket the messy free-text column into 6 semantic categories so the categorical palette has meaningful groups instead of one color per unique string",
				},
				{
					id: "s2",
					tool: "render.map",
					args: {
						layer: "${s1}",
						style: { colorBy: "contact_status" },
					},
					why: "Render the points colored by the derived contact_status column — categorical palette + legend now show 6 named outcomes",
				},
			],
		},
	},
	// 27 — Choropleth: color polygons by a numeric attribute
	{
		question: "Show a choropleth of census tracts by median household income.",
		plan: {
			goal: "Render tracts polygons color-coded by the median_hh_income value using a quantile scale",
			assumptions: [
				"tracts has polygon geometry and a numeric `median_hh_income` column",
			],
			dataset_refs: ["tracts"],
			steps: [
				{
					id: "s1",
					tool: "render.map",
					args: {
						layer: "tracts",
						style: {
							colorBy: "median_hh_income",
							classification: "quantile",
						},
					},
					why: "Quantile classification gives 5 equal-population color bins, the standard choropleth approach",
				},
			],
		},
	},
	// 28 — "Worst street by X" ranking (the canonical concept-question pattern)
	{
		question: "What street has the worst walkability score?",
		plan: {
			goal: "Identify the 10 streets with the worst (lowest) mean walkability score",
			assumptions: [
				"data has a `street` column and a numeric `walk_score` column",
				'"worst" = lowest mean score on each street; we use mean (not min) so a single outlier row does not dominate',
			],
			dataset_refs: ["data"],
			steps: [
				{
					id: "s1",
					tool: "stats.aggregate",
					args: {
						layer: "data",
						group_by: "street",
						agg_fn: "mean",
						value_col: "walk_score",
					},
					output_var: "by_street",
					why: "Average walkability per street",
				},
				{
					id: "s2",
					tool: "sql",
					args: {
						query:
							"SELECT * FROM by_street ORDER BY mean_walk_score ASC LIMIT 10",
					},
					output_var: "worst",
					why: "Sort ascending, take the bottom 10",
				},
				{
					id: "s3",
					tool: "render.table",
					args: { table: "${worst}" },
					why: "Show the worst-10 ranking as a table",
				},
			],
		},
	},
	// 29 — Bad-coordinate / null-island detection
	{
		question: "Are there any bad coordinates in this dataset?",
		plan: {
			goal: "Detect rows whose lat/lon are sentinel null-island (0,0) or fall outside WGS84 range",
			assumptions: [
				"data has numeric `lat` and `lon` columns (or close equivalents)",
				"valid WGS84: lat ∈ [-90,90] and lon ∈ [-180,180]; (0,0) is suspicious sentinel",
			],
			dataset_refs: ["data"],
			steps: [
				{
					id: "s1",
					tool: "sql",
					args: {
						query:
							"SELECT *, CASE WHEN lat = 0 AND lon = 0 THEN 'null_island' WHEN lat < -90 OR lat > 90 OR lon < -180 OR lon > 180 THEN 'out_of_range' ELSE 'ok' END AS coord_status FROM data WHERE lat = 0 AND lon = 0 OR lat < -90 OR lat > 90 OR lon < -180 OR lon > 180",
					},
					output_var: "bad_coords",
					why: "Flag rows with sentinel (0,0) or out-of-range coordinates",
				},
				{
					id: "s2",
					tool: "render.table",
					args: { table: "${bad_coords}" },
					why: "Show suspect rows so the user can decide whether to drop them",
				},
			],
		},
	},
	// 30 — User asks about a concept not present in the data
	{
		question: "Show the area with the highest air pollution.",
		plan: {
			goal: "Explain that the loaded dataset has no pollution column and list available columns",
			assumptions: [
				"inspect.list_columns confirmed there is no air-quality / pollution / AQI column",
				"the dataset has the survey columns: Address, First_attempt, Second_attempt, notes",
			],
			dataset_refs: ["survey"],
			steps: [
				{
					id: "s1",
					tool: "render.summary",
					args: {
						text: "I don't see a pollution-related column in `survey` (available columns: Address, First_attempt, Second_attempt, notes). To answer this, upload a dataset with an air-quality measure (AQI, PM2.5, NO2, etc.), or rephrase the question to use one of the existing columns.",
					},
					why: "Avoid fabricating a non-existent value; surface what data we DO have and let the user redirect",
				},
			],
		},
	},
	// 31 — Duplicate-geometry detection (data quality)
	{
		question: "Are there duplicate geometries in this layer?",
		plan: {
			goal: "Surface rows whose geometry hash repeats — often a join bug or true duplicate field collection",
			assumptions: ["layer has a `geom` column"],
			dataset_refs: ["incidents"],
			steps: [
				{
					id: "s1",
					tool: "sql",
					args: {
						query:
							"SELECT ST_AsHEXWKB(geom) AS geom_key, COUNT(*) AS dup_count FROM incidents WHERE geom IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1 ORDER BY dup_count DESC LIMIT 100",
					},
					output_var: "dups",
					why: "Hash geometry bytes; group by hash to find exact repeats",
				},
				{
					id: "s2",
					tool: "render.table",
					args: { table: "${dups}" },
					why: "Show the user the top-100 duplicated geometries with their repeat count",
				},
			],
		},
	},
	// 32 — Invalid-geometry detection (data quality)
	{
		question: "Are my polygons valid?",
		plan: {
			goal: "List polygons that fail ST_IsValid with their reasons",
			assumptions: ["layer has polygon geometry"],
			dataset_refs: ["parcels"],
			steps: [
				{
					id: "s1",
					tool: "sql",
					args: {
						query:
							"SELECT *, ST_IsValidReason(geom) AS reason FROM parcels WHERE NOT ST_IsValid(geom)",
					},
					output_var: "bad",
					why: "ST_IsValid + ST_IsValidReason surfaces self-intersections, unclosed rings, ring-order errors",
				},
				{
					id: "s2",
					tool: "render.table",
					args: { table: "${bad}" },
					why: "Tabular list of offending features; user can decide whether to ST_MakeValid them",
				},
			],
		},
	},
	// 33 — k-NN: find the 5 nearest X to each Y
	{
		question: "Find the 5 nearest hospitals to each household.",
		plan: {
			goal: "Compute the 5 nearest hospitals for each household point",
			assumptions: [
				"households has point geometry and id column",
				"hospitals has point geometry and id+name columns",
			],
			dataset_refs: ["households", "hospitals"],
			steps: [
				{
					id: "s1",
					tool: "sql",
					args: {
						query:
							"WITH ranked AS (SELECT h.id AS hh_id, hosp.id AS hosp_id, hosp.name AS hosp_name, ST_Distance(h.geom, hosp.geom) AS dist_m, ROW_NUMBER() OVER (PARTITION BY h.id ORDER BY ST_Distance(h.geom, hosp.geom)) AS rn FROM households h CROSS JOIN hospitals hosp) SELECT hh_id, hosp_id, hosp_name, dist_m FROM ranked WHERE rn <= 5 ORDER BY hh_id, dist_m",
					},
					output_var: "knn",
					why: "ROW_NUMBER partitioned by household, ordered by distance, take top 5",
				},
				{
					id: "s2",
					tool: "render.table",
					args: { table: "${knn}" },
					why: "Show the 5×N rows of household→hospital pairs sorted",
				},
			],
		},
	},
	// 34 — Spatial autocorrelation: Global Moran's I
	{
		question: "Are the housing prices spatially clustered?",
		plan: {
			goal: "Compute Global Moran's I with a binary distance-band weights matrix to test for spatial clustering of prices",
			assumptions: [
				"sales has point geometry and a numeric `price` column",
				"distance threshold D = 500m is reasonable for the city scale of this dataset",
				"row cap: 5000 features to keep the cross-join tractable in DuckDB-WASM",
			],
			dataset_refs: ["sales"],
			steps: [
				{
					id: "s1",
					tool: "sql",
					args: {
						query:
							"WITH lim AS (SELECT row_number() OVER () AS rid, price, geom FROM sales WHERE price IS NOT NULL LIMIT 5000), stats AS (SELECT AVG(price) AS mu, SUM((price - (SELECT AVG(price) FROM lim)) * (price - (SELECT AVG(price) FROM lim))) AS sse, COUNT(*) AS n FROM lim), pairs AS (SELECT (a.price - (SELECT mu FROM stats)) * (b.price - (SELECT mu FROM stats)) AS num, CASE WHEN ST_Distance(a.geom, b.geom) <= 500 AND a.rid <> b.rid THEN 1 ELSE 0 END AS w FROM lim a, lim b) SELECT ((SELECT n FROM stats) * SUM(num * w)) / (SUM(w) * (SELECT sse FROM stats)) AS morans_i FROM pairs",
					},
					output_var: "mi",
					why: "Global Moran's I on price with 500m distance-band weights; positive I = clustered, ~0 = random, negative = dispersed",
				},
				{
					id: "s2",
					tool: "render.summary",
					args: {
						text: "Moran's I computed (see ${mi}). Interpretation: I > 0.3 strongly clustered, |I| < 0.1 essentially random, I < -0.3 strongly dispersed. The 500m distance band assumes city-scale data; for regional data use a larger threshold.",
					},
					why: "Explain the result and provide guidance on interpretation",
				},
			],
		},
	},
	// 36 — Color-by-bucket: free-text status column → bucketize → color map
	{
		question:
			"Color the survey points by their contact outcome (the 'First attempt' column has messy free text).",
		plan: {
			goal: "Render survey points color-coded by a clean bucketed status derived from the free-text 'First attempt' column",
			assumptions: [
				"'First attempt' is high-cardinality free text with semantic patterns (completed / refused / no-answer / inaccessible)",
				"transform.bucketize collapses the text into a small set of clean labels so the categorical palette is meaningful",
			],
			dataset_refs: ["survey"],
			steps: [
				{
					id: "s1",
					tool: "transform.bucketize",
					args: {
						layer: "survey",
						column: "First attempt",
						out_column: "bucket",
					},
					output_var: "bucketed",
					why: "Reduce the high-cardinality free-text column to ≤6 labeled categories so each color in the legend is meaningful",
				},
				{
					id: "s2",
					tool: "render.map",
					args: {
						layer: "${bucketed}",
						style: { colorBy: "bucket" },
					},
					why: "Render each survey point colored by its contact-outcome bucket — categorical palette + legend now show named outcomes",
				},
			],
		},
	},
	// 35 — Equity / disparate-impact analysis
	{
		question: "Which demographic group has the worst access to grocery stores?",
		plan: {
			goal: "For each demographic-tract polygon, compute distance to the nearest grocery store, then aggregate distance by demographic class",
			assumptions: [
				"tracts has polygon geometry + a `dominant_race` categorical column + a `median_income` numeric column",
				"stores has point geometry",
				'"worst access" = highest mean distance to nearest store within each demographic group',
			],
			dataset_refs: ["tracts", "stores"],
			steps: [
				{
					id: "s1",
					tool: "sql",
					args: {
						query:
							"WITH nearest AS (SELECT t.dominant_race, MIN(ST_Distance(ST_Centroid(t.geom), s.geom)) AS dist_to_store FROM tracts t, stores s GROUP BY t.dominant_race, t.geom) SELECT dominant_race, AVG(dist_to_store) AS mean_dist_m, MEDIAN(dist_to_store) AS median_dist_m, COUNT(*) AS n_tracts FROM nearest GROUP BY dominant_race ORDER BY mean_dist_m DESC",
					},
					output_var: "equity",
					why: "For each tract, nearest-store distance; aggregate by dominant_race to surface disparate access",
				},
				{
					id: "s2",
					tool: "render.chart",
					args: {
						table: "${equity}",
						kind: "bar",
						x: "dominant_race",
						y: "mean_dist_m",
					},
					why: "Bar chart makes the disparity visible at a glance",
				},
			],
		},
	},
];

export function renderExamplesBlock(): string {
	const out: string[] = [];
	for (const [i, e] of EXAMPLES.entries()) {
		out.push(`### Example ${i + 1}`);
		out.push(`Q: "${e.question}"`);
		out.push("Plan:");
		out.push("```json");
		out.push(JSON.stringify(e.plan, null, 2));
		out.push("```");
		out.push("");
	}
	return out.join("\n").trim();
}
