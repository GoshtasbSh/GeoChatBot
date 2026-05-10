import { z } from "zod";
import { registerTool } from "./registry.js";

const AggFn = z.enum(["sum", "mean", "median", "count", "min", "max"]);
const Weights = z.enum(["queen", "knn"]);

registerTool({
	id: "stats.aggregate",
	description:
		"Group rows of a layer/table by one or more columns and apply an aggregation function. The bread-and-butter rollup tool.",
	args: z.object({
		layer: z.string(),
		group_by: z.union([z.string(), z.array(z.string()).min(1)]),
		agg_fn: AggFn,
		value_col: z.string(),
	}),
	output_kind: "table",
	examples: [
		{
			when: "Sum sale prices per neighborhood",
			args: {
				layer: "tagged",
				group_by: "neighborhood_name",
				agg_fn: "sum",
				value_col: "price",
			},
		},
	],
});

registerTool({
	id: "stats.summary_stats",
	description:
		"Compute count, min, max, mean, median, std for the given numeric columns of a layer/table. Returns a one-row-per-column table.",
	args: z.object({ layer: z.string(), columns: z.array(z.string()).min(1) }),
	output_kind: "table",
	examples: [
		{
			when: "Summary stats of price column",
			args: { layer: "sales", columns: ["price"] },
		},
	],
});

registerTool({
	id: "stats.distance_matrix",
	description:
		"For every pair (a_i, b_j), compute distance between geometries; optionally cap to k smallest per a_i. Output: (a_id, b_id, distance) rows.",
	args: z.object({
		a: z.string(),
		b: z.string(),
		k: z.number().int().positive().optional(),
	}),
	output_kind: "table",
	examples: [
		{
			when: "Distance from each station to each hydrant",
			args: { a: "stations", b: "hydrants" },
		},
	],
});

registerTool({
	id: "stats.hex_bin",
	description:
		"Aggregate a point layer into H3 hexagonal cells at the given resolution (0=largest, 15=smallest). Output: layer of hex polygons with count per cell.",
	args: z.object({
		layer: z.string(),
		h3_resolution: z.number().int().min(0).max(15),
	}),
	output_kind: "layer",
	examples: [
		{
			when: "Hex-bin pickups at resolution 9",
			args: { layer: "pickups", h3_resolution: 9 },
		},
	],
});

registerTool({
	id: "stats.density_grid",
	description:
		"Aggregate a point layer into a fishnet of square cells with side cell_size (in CRS units, e.g., meters). Use when the user specifies a cell size.",
	args: z.object({
		layer: z.string(),
		cell_size: z.number().positive(),
		agg_fn: AggFn,
	}),
	output_kind: "layer",
	examples: [
		{
			when: "Accidents per 500m cell",
			args: { layer: "accidents", cell_size: 500, agg_fn: "count" },
		},
	],
});

registerTool({
	id: "stats.morans_i",
	description:
		"Compute global Moran's I — measures spatial autocorrelation of a numeric column. Returns the I statistic and p-value (scalar output). Use to answer 'is this clustered, or random?'",
	args: z.object({
		layer: z.string(),
		value_col: z.string(),
		weights: Weights.default("queen"),
	}),
	output_kind: "scalar",
	examples: [
		{
			when: "Are housing prices spatially clustered?",
			args: { layer: "avg_price", value_col: "mean_price" },
		},
	],
});

registerTool({
	id: "stats.getis_ord_gi",
	description:
		"Compute Getis-Ord Gi* z-scores per feature — identifies hot spots (high values cluster) and cold spots (low values cluster). Output: layer with gi_z_score column.",
	args: z.object({
		layer: z.string(),
		value_col: z.string(),
		distance: z.number().positive(),
	}),
	output_kind: "layer",
	examples: [
		{
			when: "Crime hot spots within 1km",
			args: { layer: "crime_per_block", value_col: "count", distance: 1000 },
		},
	],
});
