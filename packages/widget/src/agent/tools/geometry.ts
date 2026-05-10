import { z } from "zod";
import { registerTool } from "./registry.js";

const Units = z.enum(["meters", "kilometers", "miles", "feet"]);
const HullMode = z.enum(["convex", "concave"]);
const Crs = z.string().regex(/^(EPSG:\d+|.+ \+proj=.+)$/);

registerTool({
	id: "geometry.buffer",
	description:
		"Expand a layer's geometries by a distance. Use for 'within X meters', 'draw a radius', 'service area' type questions. Output: layer with buffered polygons.",
	args: z.object({
		layer: z.string(),
		distance: z.number().positive(),
		units: Units.default("meters"),
	}),
	output_kind: "layer",
	examples: [
		{
			when: "Schools within 500 m of a hospital",
			args: { layer: "hospitals", distance: 500, units: "meters" },
		},
	],
});

registerTool({
	id: "geometry.intersect",
	description:
		'Return geometries where layers a AND b overlap. Use for "areas where X and Y both apply" — e.g., flood zones inside school districts.',
	args: z.object({ a: z.string(), b: z.string() }),
	output_kind: "layer",
	examples: [
		{
			when: "Flood zones inside school districts",
			args: { a: "flood_zones", b: "school_districts" },
		},
	],
});

registerTool({
	id: "geometry.union",
	description:
		"Merge two layers into a single layer. Use for combining feature sets.",
	args: z.object({ a: z.string(), b: z.string() }),
	output_kind: "layer",
	examples: [
		{
			when: "Combine A and B parks into one layer",
			args: { a: "parks_a", b: "parks_b" },
		},
	],
});

registerTool({
	id: "geometry.difference",
	description:
		'Subtract layer b from layer a; returns parts of a not in b. Use for "X excluding Y" questions.',
	args: z.object({ a: z.string(), b: z.string() }),
	output_kind: "layer",
	examples: [
		{
			when: "Watershed parts not in protected areas",
			args: { a: "watershed", b: "protected" },
		},
	],
});

registerTool({
	id: "geometry.dissolve",
	description:
		"Merge polygons that share a value in by_field into single multipolygons. The most common QGIS workflow for aggregating polygons.",
	args: z.object({ layer: z.string(), by_field: z.string().optional() }),
	output_kind: "layer",
	examples: [
		{
			when: "One polygon per state from county data",
			args: { layer: "counties", by_field: "state_fips" },
		},
	],
});

registerTool({
	id: "geometry.centroid",
	description:
		"Return the centroid (center point) of each feature in the layer.",
	args: z.object({ layer: z.string() }),
	output_kind: "layer",
	examples: [
		{
			when: "Center points of neighborhoods",
			args: { layer: "neighborhoods" },
		},
	],
});

registerTool({
	id: "geometry.convex_hull",
	description:
		"Return the smallest enclosing polygon (convex) or fitted boundary (concave) around the features. Concave is the default for organic point clusters.",
	args: z.object({ layer: z.string(), mode: HullMode.default("concave") }),
	output_kind: "layer",
	examples: [
		{
			when: "Boundary of where Citi Bike pickups happened today",
			args: { layer: "trips", mode: "concave" },
		},
	],
});

registerTool({
	id: "geometry.voronoi",
	description:
		"Compute Voronoi (Thiessen) polygons over a point layer — divides space by nearest point. Use for service areas / catchment.",
	args: z.object({ points: z.string() }),
	output_kind: "layer",
	examples: [
		{
			when: "Divide Manhattan by nearest fire station",
			args: { points: "fire_stations" },
		},
	],
});

registerTool({
	id: "geometry.simplify",
	description:
		"Reduce vertex count using Douglas-Peucker. Use to smooth jagged polygons or shrink data size.",
	args: z.object({ layer: z.string(), tolerance: z.number().positive() }),
	output_kind: "layer",
	examples: [
		{
			when: "Smooth coastline at 100 m tolerance",
			args: { layer: "coast", tolerance: 100 },
		},
	],
});

registerTool({
	id: "geometry.reproject",
	description:
		"Convert a layer to a different CRS. Use BEFORE distance/area operations when the source is geographic (lat/lon, EPSG:4326).",
	args: z.object({ layer: z.string(), to_crs: Crs }),
	output_kind: "layer",
	examples: [
		{
			when: "Reproject to UTM 18N for accurate meters",
			args: { layer: "sales", to_crs: "EPSG:32618" },
		},
	],
});
