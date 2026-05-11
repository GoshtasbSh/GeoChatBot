/**
 * Tool catalog entry for `report.quickscan`.
 *
 * Distinct from the inspection tools because:
 *   - Quickscan is a TERMINAL tool (goes into Plan.steps), not a probe
 *     in the agentic loop.
 *   - It produces a `render.summary`-style payload and so should be the
 *     LAST step in a plan, same shape as render.* terminals.
 *   - The planner picks it for vague "what's in this data?" questions
 *     instead of inventing a chain of inspect.* + render.summary calls.
 */

import { z } from "zod";
import { registerTool } from "./registry.js";

registerTool({
	id: "report.quickscan",
	description:
		"Generate a one-shot data-quality report on a loaded dataset: schema, completeness (per-column null %), sample rows, numeric stats, spatial extent + CRS guess, date range, duplicate-row count, and a 1-line verdict. Use as the LAST step when the user asks vague questions like 'what's in this data', 'tell me about this', 'is this data good', 'show me the data', 'summary'. Skip for concrete analytical questions (counts, maps, charts).",
	args: z.object({
		dataset: z.string().min(1),
		skip: z
			.array(
				z.enum([
					"schema",
					"completeness",
					"sample",
					"distinct",
					"numeric",
					"duplicates",
					"spatial",
					"dates",
					"outliers",
				]),
			)
			.optional(),
	}),
	output_kind: "rendered",
	examples: [
		{
			when: "User asks 'what's in this data?' against an unknown dataset",
			args: { dataset: "sales" },
		},
		{
			when: "User asks for a focused report skipping sample rows",
			args: { dataset: "sales", skip: ["sample", "distinct"] },
		},
	],
});
