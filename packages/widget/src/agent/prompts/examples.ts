import type { Plan } from '../types.js';

export interface Example {
  question: string;
  plan: Plan;
}

export const EXAMPLES: Example[] = [
  // 1 — Aggregate-by-region
  {
    question: 'Which NYC neighborhoods sold the most homes in 2024?',
    plan: {
      goal: 'Rank NYC neighborhoods by 2024 home-sale volume',
      assumptions: ['price column is sale price in USD', 'year extracted from sale_date'],
      dataset_refs: ['sales', 'neighborhoods'],
      steps: [
        { id: 's1', tool: 'sql', args: { query: "SELECT * FROM sales WHERE EXTRACT(year FROM sale_date) = 2024" }, output_var: 'sales_2024', why: 'Filter sales to calendar year 2024 only' },
        { id: 's2', tool: 'joins.spatial_join', args: { a: '${sales_2024}', b: 'neighborhoods', predicate: 'within' }, output_var: 'tagged', why: 'Tag each sale with the neighborhood it falls inside' },
        { id: 's3', tool: 'stats.aggregate', args: { layer: '${tagged}', group_by: 'neighborhood_name', agg_fn: 'sum', value_col: 'price' }, output_var: 'totals', why: 'Sum sale prices per neighborhood' },
        { id: 's4', tool: 'render.chart', args: { table: '${totals}', kind: 'bar', x: 'neighborhood_name', y: 'sum_price' }, why: 'Visualize neighborhood ranking' },
      ],
    },
  },
  // 2 — Buffer-then-overlay
  {
    question: 'Show schools within 500 m of any hospital.',
    plan: {
      goal: 'Find schools within 500 m of a hospital',
      assumptions: ['data is in EPSG:4326; reproject for accurate meters'],
      dataset_refs: ['schools', 'hospitals'],
      steps: [
        { id: 's1', tool: 'geometry.reproject', args: { layer: 'hospitals', to_crs: 'EPSG:32618' }, output_var: 'h_m', why: 'Reproject to UTM 18N for accurate meter-based buffer' },
        { id: 's2', tool: 'geometry.buffer', args: { layer: '${h_m}', distance: 500, units: 'meters' }, output_var: 'h_buf', why: 'Expand each hospital by 500 m' },
        { id: 's3', tool: 'joins.spatial_join', args: { a: 'schools', b: '${h_buf}', predicate: 'within' }, output_var: 'matched', why: 'Find schools inside any buffer' },
        { id: 's4', tool: 'render.map', args: { layer: '${matched}' }, why: 'Show the matching schools on the map' },
      ],
    },
  },
  // 3 — Hot-spot analysis (Getis-Ord)
  {
    question: 'Where are the crime hot spots within 1 km in NYC?',
    plan: {
      goal: 'Identify crime hot spots using Getis-Ord Gi*',
      assumptions: ['count column already represents events per block', 'distance band is 1000 m'],
      dataset_refs: ['crime_per_block'],
      steps: [
        { id: 's1', tool: 'sql', args: { query: 'SELECT * FROM crime_per_block WHERE count IS NOT NULL' }, output_var: 'cleaned', why: 'Drop blocks missing the count value' },
        { id: 's2', tool: 'stats.getis_ord_gi', args: { layer: '${cleaned}', value_col: 'count', distance: 1000 }, output_var: 'gi_scores', why: 'Compute hot/cold spot z-scores per block within 1 km' },
        { id: 's3', tool: 'render.map', args: { layer: '${gi_scores}' }, why: 'Show hot/cold spot map' },
      ],
    },
  },
  // 4 — Hex-bin density
  {
    question: 'Show me where Citi Bike pickups concentrate.',
    plan: {
      goal: 'Visualize pickup density across the city using hex bins',
      assumptions: ['pickups is a point layer', 'H3 resolution 9 is a city-block-ish cell'],
      dataset_refs: ['pickups'],
      steps: [
        { id: 's1', tool: 'stats.hex_bin', args: { layer: 'pickups', h3_resolution: 9 }, output_var: 'hex_counts', why: 'Aggregate pickup points into H3 hex cells at resolution 9' },
        { id: 's2', tool: 'render.map', args: { layer: '${hex_counts}' }, why: 'Render the hex density on a map' },
      ],
    },
  },
  // 5 — Reproject for distance
  {
    question: 'On average, how far is each home from the nearest subway station, in meters?',
    plan: {
      goal: 'Compute mean home-to-nearest-subway distance in meters',
      assumptions: ['both layers are EPSG:4326 and need reprojection for meter accuracy'],
      dataset_refs: ['homes', 'subway'],
      steps: [
        { id: 's1', tool: 'geometry.reproject', args: { layer: 'homes', to_crs: 'EPSG:32618' }, output_var: 'homes_m', why: 'Reproject homes to UTM 18N for meter accuracy' },
        { id: 's2', tool: 'geometry.reproject', args: { layer: 'subway', to_crs: 'EPSG:32618' }, output_var: 'subway_m', why: 'Reproject subway stations to the same CRS' },
        { id: 's3', tool: 'joins.nearest_neighbor', args: { a: '${homes_m}', b: '${subway_m}', k: 1 }, output_var: 'pairs', why: 'For each home, the single nearest station and its distance' },
        { id: 's4', tool: 'stats.summary_stats', args: { layer: '${pairs}', columns: ['distance'] }, output_var: 'dist_stats', why: 'Compute mean/min/max of the home-to-station distance' },
        { id: 's5', tool: 'render.summary', args: { text: 'See the distance summary table for the average home-to-subway distance.' }, why: 'Tell the user the result in plain English' },
      ],
    },
  },
  // 6 — Voronoi service areas
  {
    question: 'Carve Manhattan into the catchment area of each fire station.',
    plan: {
      goal: 'Divide an area by the nearest fire station using Voronoi polygons',
      assumptions: ['boroughs is the bounding polygon for Manhattan'],
      dataset_refs: ['fire_stations', 'boroughs'],
      steps: [
        { id: 's1', tool: 'geometry.voronoi', args: { points: 'fire_stations' }, output_var: 'cells', why: 'Build Voronoi polygons over fire-station points' },
        { id: 's2', tool: 'geometry.intersect', args: { a: '${cells}', b: 'boroughs' }, output_var: 'clipped', why: 'Clip the cells to the borough boundary so they do not extend beyond the city' },
        { id: 's3', tool: 'render.map', args: { layer: '${clipped}' }, why: 'Show the catchment areas on the map' },
      ],
    },
  },
  // 7 — Dissolve polygons
  {
    question: 'Merge all parcels with the same owner into one polygon.',
    plan: {
      goal: 'Dissolve parcels by owner into single multipolygons',
      assumptions: ['parcels has an owner_id column shared across parcels owned by the same entity'],
      dataset_refs: ['parcels'],
      steps: [
        { id: 's1', tool: 'geometry.dissolve', args: { layer: 'parcels', by_field: 'owner_id' }, output_var: 'owner_blocks', why: 'Combine adjacent and detached parcels per owner into one shape' },
        { id: 's2', tool: 'render.map', args: { layer: '${owner_blocks}' }, why: 'Show the owner-level polygons' },
      ],
    },
  },
  // 8 — Difference / clip-out
  {
    question: 'How much of the watershed sits outside protected areas?',
    plan: {
      goal: 'Compute watershed area outside protected boundaries',
      assumptions: ['both layers share the same CRS', 'shape_area column holds polygon area in sq meters'],
      dataset_refs: ['watershed', 'protected_areas'],
      steps: [
        { id: 's1', tool: 'geometry.difference', args: { a: 'watershed', b: 'protected_areas' }, output_var: 'unprotected', why: 'Keep only the parts of the watershed not covered by protected areas' },
        { id: 's2', tool: 'stats.summary_stats', args: { layer: '${unprotected}', columns: ['shape_area'] }, output_var: 'area_stats', why: 'Summarize the area of the unprotected watershed' },
        { id: 's3', tool: 'render.summary', args: { text: 'The summary table shows the total unprotected watershed area.' }, why: 'Communicate the area number to the user' },
      ],
    },
  },
  // 9 — Multi-dataset comparison (grouped bar)
  {
    question: 'Compare 311 complaint counts across boroughs by complaint type.',
    plan: {
      goal: 'Grouped-bar comparison of 311 counts by borough and complaint type',
      assumptions: ['complaints_311 is a point layer with a complaint_type column'],
      dataset_refs: ['complaints_311', 'boroughs'],
      steps: [
        { id: 's1', tool: 'joins.spatial_join', args: { a: 'complaints_311', b: 'boroughs', predicate: 'within' }, output_var: 'tagged', why: 'Tag each complaint with its borough' },
        { id: 's2', tool: 'stats.aggregate', args: { layer: '${tagged}', group_by: ['borough_name', 'complaint_type'], agg_fn: 'count', value_col: 'complaint_id' }, output_var: 'totals', why: 'Count complaints per (borough, complaint type) pair' },
        { id: 's3', tool: 'render.chart', args: { table: '${totals}', kind: 'grouped_bar', x: 'borough_name', y: 'count_complaint_id', group: 'complaint_type' }, why: 'Show grouped bars per borough split by complaint type' },
      ],
    },
  },
  // 10 — Moran's I
  {
    question: 'Are housing prices spatially clustered across NYC neighborhoods?',
    plan: {
      goal: "Test spatial autocorrelation of mean home price using Moran's I",
      assumptions: ['queen contiguity is appropriate for adjacent neighborhood polygons'],
      dataset_refs: ['sales', 'neighborhoods'],
      steps: [
        { id: 's1', tool: 'joins.spatial_join', args: { a: 'sales', b: 'neighborhoods', predicate: 'within' }, output_var: 'tagged', why: 'Attach each sale to its neighborhood' },
        { id: 's2', tool: 'stats.aggregate', args: { layer: '${tagged}', group_by: 'neighborhood_name', agg_fn: 'mean', value_col: 'price' }, output_var: 'avg_price', why: 'Compute mean sale price per neighborhood' },
        { id: 's3', tool: 'stats.morans_i', args: { layer: '${avg_price}', value_col: 'mean_price', weights: 'queen' }, output_var: 'moran', why: "Run global Moran's I on neighborhood means" },
        { id: 's4', tool: 'render.summary', args: { text: "See the Moran's I statistic and p-value to decide whether prices are clustered." }, why: 'Explain the result in one sentence' },
      ],
    },
  },
  // 11 — Pure-SQL escape hatch
  {
    question: 'Show me only the homes priced above one million dollars.',
    plan: {
      goal: 'Filter homes by price threshold and map them',
      assumptions: ['price is in USD'],
      dataset_refs: ['homes'],
      steps: [
        { id: 's1', tool: 'sql', args: { query: 'SELECT * FROM homes WHERE price > 1000000' }, output_var: 'pricey', why: 'Keep only homes priced above $1M' },
        { id: 's2', tool: 'render.map', args: { layer: '${pricey}' }, why: 'Show the filtered homes on the map' },
      ],
    },
  },
  // 12 — Concave hull
  {
    question: 'Outline the area where Citi Bike pickups happened today.',
    plan: {
      goal: 'Draw the organic boundary of pickup activity using a concave hull',
      assumptions: ['ride_date is a date column'],
      dataset_refs: ['trips'],
      steps: [
        { id: 's1', tool: 'sql', args: { query: 'SELECT * FROM trips WHERE ride_date = CURRENT_DATE' }, output_var: 'today_trips', why: 'Filter trips to today only' },
        { id: 's2', tool: 'geometry.convex_hull', args: { layer: '${today_trips}', mode: 'concave' }, output_var: 'shape', why: 'Fit a concave boundary around the day-of points' },
        { id: 's3', tool: 'render.map', args: { layer: '${shape}' }, why: 'Show the activity envelope' },
      ],
    },
  },
  // 13 — Time-aware aggregation
  {
    question: 'Plot monthly accident counts per borough for the last year.',
    plan: {
      goal: 'Show a monthly time-series of accidents grouped by borough',
      assumptions: ['accidents has a crash_date column', 'borough joined via spatial join'],
      dataset_refs: ['accidents', 'boroughs'],
      steps: [
        { id: 's1', tool: 'joins.spatial_join', args: { a: 'accidents', b: 'boroughs', predicate: 'within' }, output_var: 'tagged', why: 'Attach each accident to its borough' },
        { id: 's2', tool: 'sql', args: { query: "SELECT borough_name, date_trunc('month', crash_date) AS month, COUNT(*) AS n FROM tagged WHERE crash_date >= CURRENT_DATE - INTERVAL '1 year' GROUP BY 1, 2" }, output_var: 'monthly', why: 'Bucket accidents by month and borough for the last year' },
        { id: 's3', tool: 'render.chart', args: { table: '${monthly}', kind: 'line', x: 'month', y: 'n', group: 'borough_name' }, why: 'Render one line per borough over time' },
      ],
    },
  },
  // 14 — Fishnet density grid
  {
    question: 'Show the number of accidents per 500-meter cell across the city.',
    plan: {
      goal: 'Build a fishnet density grid of accident counts at 500 m resolution',
      assumptions: ['accidents is in EPSG:4326 and must be reprojected before meter cells'],
      dataset_refs: ['accidents'],
      steps: [
        { id: 's1', tool: 'geometry.reproject', args: { layer: 'accidents', to_crs: 'EPSG:32618' }, output_var: 'a_m', why: 'Reproject so cell_size in meters is meaningful' },
        { id: 's2', tool: 'stats.density_grid', args: { layer: '${a_m}', cell_size: 500, agg_fn: 'count' }, output_var: 'grid', why: 'Aggregate accidents into 500 m square cells' },
        { id: 's3', tool: 'render.map', args: { layer: '${grid}' }, why: 'Show the density grid on the map' },
      ],
    },
  },
  // 15 — kNN k>1 + summary
  {
    question: 'For each home, summarize the average distance to its 3 nearest schools.',
    plan: {
      goal: 'Compute home-level mean distance to k=3 nearest schools, then summarize',
      assumptions: ['both layers already share a metric CRS'],
      dataset_refs: ['homes', 'schools'],
      steps: [
        { id: 's1', tool: 'joins.nearest_neighbor', args: { a: 'homes', b: 'schools', k: 3 }, output_var: 'pairs', why: 'For each home, the 3 closest schools and their distances' },
        { id: 's2', tool: 'stats.aggregate', args: { layer: '${pairs}', group_by: 'a_id', agg_fn: 'mean', value_col: 'distance' }, output_var: 'mean_per_home', why: 'Average the 3 distances per home' },
        { id: 's3', tool: 'stats.summary_stats', args: { layer: '${mean_per_home}', columns: ['mean_distance'] }, output_var: 'overall', why: 'Summary stats over per-home means' },
        { id: 's4', tool: 'render.summary', args: { text: 'See the overall distance-to-3-nearest-schools summary table.' }, why: 'Communicate the citywide stat to the user' },
      ],
    },
  },
  // 16 — Composite multi-step
  {
    question: 'Show median sale price by census tract, only for sales in 2024.',
    plan: {
      goal: 'Map median 2024 sale price per census tract',
      assumptions: ['sale_date is a date column', 'census_tracts is a polygon layer'],
      dataset_refs: ['sales', 'census_tracts'],
      steps: [
        { id: 's1', tool: 'geometry.reproject', args: { layer: 'sales', to_crs: 'EPSG:32618' }, output_var: 'sales_m', why: 'Reproject sales to a metric CRS for downstream consistency' },
        { id: 's2', tool: 'sql', args: { query: "SELECT * FROM sales_m WHERE EXTRACT(year FROM sale_date) = 2024" }, output_var: 'sales_24', why: 'Limit to 2024 sales' },
        { id: 's3', tool: 'stats.aggregate', args: { layer: '${sales_24}', group_by: 'tract_id', agg_fn: 'median', value_col: 'price' }, output_var: 'median_by_tract', why: 'Compute median price per tract' },
        { id: 's4', tool: 'render.map', args: { layer: '${median_by_tract}' }, why: 'Show the choropleth on the map' },
      ],
    },
  },
  // 17 — Multi-CRS alignment
  {
    question: 'For each parking meter, find the nearest coffee shop and average distance per block.',
    plan: {
      goal: 'Reproject both layers to a common CRS, find nearest neighbor, then aggregate',
      assumptions: ['layers may have differing CRSes; UTM 18N is appropriate for NYC'],
      dataset_refs: ['parking_meters', 'coffee_shops'],
      steps: [
        { id: 's1', tool: 'geometry.reproject', args: { layer: 'parking_meters', to_crs: 'EPSG:32618' }, output_var: 'meters_m', why: 'Bring meters into a metric CRS' },
        { id: 's2', tool: 'geometry.reproject', args: { layer: 'coffee_shops', to_crs: 'EPSG:32618' }, output_var: 'shops_m', why: 'Bring shops into the same CRS for valid distance' },
        { id: 's3', tool: 'joins.nearest_neighbor', args: { a: '${meters_m}', b: '${shops_m}', k: 1 }, output_var: 'pairs', why: 'For each meter, the closest coffee shop' },
        { id: 's4', tool: 'stats.aggregate', args: { layer: '${pairs}', group_by: 'block_id', agg_fn: 'mean', value_col: 'distance' }, output_var: 'block_avg', why: 'Average meter-to-shop distance per block' },
        { id: 's5', tool: 'render.map', args: { layer: '${block_avg}' }, why: 'Show per-block averages on the map' },
      ],
    },
  },
  // 18 — Lat/lon → point geom
  {
    question: 'Plot the bike stations from a lat/lon table.',
    plan: {
      goal: 'Build a point layer from lat/lon columns and render it',
      assumptions: ['lon and lat columns exist on bike_stations'],
      dataset_refs: ['bike_stations'],
      steps: [
        { id: 's1', tool: 'sql', args: { query: 'SELECT *, ST_Point(lon, lat) AS geom FROM bike_stations' }, output_var: 'pts', why: 'Build a point geometry from the lat/lon columns' },
        { id: 's2', tool: 'render.map', args: { layer: '${pts}' }, why: 'Show the bike stations on the map' },
      ],
    },
  },
  // 19 — Distance matrix + ranking
  {
    question: 'Rank fire stations by their average distance to the 5 nearest hydrants.',
    plan: {
      goal: 'Compute station-to-5-nearest-hydrant distances and rank stations',
      assumptions: ['both layers share a metric CRS or are pre-projected'],
      dataset_refs: ['fire_stations', 'hydrants'],
      steps: [
        { id: 's1', tool: 'stats.distance_matrix', args: { a: 'fire_stations', b: 'hydrants', k: 5 }, output_var: 'dm', why: 'Distance from each station to its 5 nearest hydrants' },
        { id: 's2', tool: 'stats.aggregate', args: { layer: '${dm}', group_by: 'a_id', agg_fn: 'mean', value_col: 'distance' }, output_var: 'station_means', why: 'Mean distance per station' },
        { id: 's3', tool: 'render.chart', args: { table: '${station_means}', kind: 'bar', x: 'a_id', y: 'mean_distance' }, why: 'Bar chart ranking stations by mean nearest-hydrant distance' },
      ],
    },
  },
  // 20 — Composite Moran's I + Getis-Ord
  {
    question: 'Are 311 complaints spatially clustered, and where are the hot spots?',
    plan: {
      goal: "Combine global Moran's I and local Getis-Ord Gi* on per-tract complaint counts",
      assumptions: ['census_tracts polygons cover the study area', 'distance band of 1500 m for Gi*'],
      dataset_refs: ['complaints_311', 'census_tracts'],
      steps: [
        { id: 's1', tool: 'joins.spatial_join', args: { a: 'complaints_311', b: 'census_tracts', predicate: 'within' }, output_var: 'tagged', why: 'Tag each complaint with its census tract' },
        { id: 's2', tool: 'stats.aggregate', args: { layer: '${tagged}', group_by: 'tract_id', agg_fn: 'count', value_col: 'complaint_id' }, output_var: 'tract_counts', why: 'Count complaints per tract' },
        { id: 's3', tool: 'stats.morans_i', args: { layer: '${tract_counts}', value_col: 'count_complaint_id', weights: 'queen' }, output_var: 'moran', why: 'Test global spatial autocorrelation of counts' },
        { id: 's4', tool: 'stats.getis_ord_gi', args: { layer: '${tract_counts}', value_col: 'count_complaint_id', distance: 1500 }, output_var: 'hot_spots', why: 'Identify per-tract hot/cold spots within 1.5 km' },
        { id: 's5', tool: 'render.map', args: { layer: '${hot_spots}' }, why: 'Show the local hot/cold spot map' },
      ],
    },
  },
];

export function renderExamplesBlock(): string {
  const out: string[] = [];
  for (let i = 0; i < EXAMPLES.length; i++) {
    const e = EXAMPLES[i]!;
    out.push(`### Example ${i + 1}`);
    out.push(`Q: "${e.question}"`);
    out.push('Plan:');
    out.push('```json');
    out.push(JSON.stringify(e.plan, null, 2));
    out.push('```');
    out.push('');
  }
  return out.join('\n').trim();
}
