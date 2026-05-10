import { z } from "zod";
import { registerTool } from "./registry.js";

const Predicate = z.enum(["within", "intersects", "contains", "touches"]);

registerTool({
	id: "joins.spatial_join",
	description:
		"Tag each feature in a with the matching feature(s) from b using a spatial predicate. Generalizes 'point in polygon' / 'polygon contains point'. Output: table with rows from a augmented with b's attributes.",
	args: z.object({ a: z.string(), b: z.string(), predicate: Predicate }),
	output_kind: "table",
	examples: [
		{
			when: "Tag sales with the neighborhood they fall inside",
			args: { a: "sales", b: "neighborhoods", predicate: "within" },
		},
	],
});

registerTool({
	id: "joins.nearest_neighbor",
	description:
		"For each feature in a, find the k nearest features in b. Output: table of (a_id, b_id, distance) rows with k rows per a.",
	args: z.object({
		a: z.string(),
		b: z.string(),
		k: z.number().int().positive(),
	}),
	output_kind: "table",
	examples: [
		{
			when: "For each home, the 3 nearest schools",
			args: { a: "homes", b: "schools", k: 3 },
		},
	],
});

registerTool({
	id: "joins.point_in_polygon",
	description:
		"Ergonomic alias for joins.spatial_join with predicate='within'. Use when the user explicitly says 'point in polygon'.",
	args: z.object({ points: z.string(), polygons: z.string() }),
	output_kind: "table",
	examples: [
		{
			when: "Which borough is each pickup in?",
			args: { points: "pickups", polygons: "boroughs" },
		},
	],
});
