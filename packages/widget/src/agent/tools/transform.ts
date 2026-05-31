import { z } from "zod";
import { registerTool } from "./registry.js";

/**
 * Tool catalog entry — runtime lives in
 * `agent/executor/runners/bucketize.ts`.
 *
 * Collapses a free-text or high-cardinality column into a small set of
 * clean status buckets so it can be grouped or color-coded on a map.
 */
registerTool({
	id: "transform.bucketize",
	description:
		"Collapse a free-text/high-cardinality column into a small set of clean status buckets (a new derived column) so it can be grouped or color-coded.",
	args: z.object({
		layer: z.string(),
		column: z.string().min(1),
		out_column: z.string().min(1).default("bucket"),
	}),
	output_kind: "layer",
	examples: [
		{
			when: "Bucket a messy survey contact-outcome column before color-coding the map",
			args: {
				layer: "survey",
				column: "First attempt",
				out_column: "bucket",
			},
		},
	],
});
