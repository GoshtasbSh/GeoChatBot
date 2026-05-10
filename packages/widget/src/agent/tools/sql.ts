import { z } from "zod";
import { registerTool } from "./registry.js";

registerTool({
	id: "sql",
	description:
		"Run a SELECT/WITH query against the loaded datasets. The query is validated by validateSql (rejects INSERT/UPDATE/DELETE/CREATE/DROP/ATTACH/COPY/PRAGMA/INSTALL/LOAD/SET and multi-statement). Output: a table.",
	args: z.object({ query: z.string().min(1) }),
	output_kind: "table",
	examples: [
		{
			when: "Filter sales to year 2024",
			args: {
				query: "SELECT * FROM sales WHERE EXTRACT(year FROM sale_date) = 2024",
			},
		},
	],
});
