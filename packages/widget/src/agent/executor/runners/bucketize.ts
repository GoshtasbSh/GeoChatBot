// packages/widget/src/agent/executor/runners/bucketize.ts
import { z } from "zod";
import { registerRunner } from "../runtime.js";
import { materializeView, quoteIdent, resolveTable } from "../sql-helpers.js";
import type { ExecCtx, RunnerResult } from "../types.js";

/**
 * Status lexicon for free-text survey-outcome columns. Order matters:
 * the more-specific negative outcomes are matched before "completed",
 * because completed-keywords like "survey" also appear in negative
 * phrases (e.g. "Not interested in taking the survey").
 */
const RULES: Array<{ label: string; keywords: string[] }> = [
	{ label: "refused", keywords: ["refus", "not interested", "declin"] },
	{
		label: "inaccessible",
		keywords: ["vacant", "inaccess", "gated", "locked", "trespass"],
	},
	{
		label: "no answer",
		keywords: [
			"no answer",
			"no one",
			"flier",
			"flyer",
			"no response",
			"not home",
		],
	},
	{
		label: "completed",
		keywords: ["complet", "survey", "id#", "id #", "qr", "gave"],
	},
];

export function bucketLabel(raw: string): string {
	const t = (raw ?? "").trim().toLowerCase();
	if (!t) return "no attempt";
	for (const { label, keywords } of RULES)
		if (keywords.some((k) => t.includes(k))) return label;
	return "other";
}

function likeClause(colExpr: string, keywords: string[]): string {
	return keywords
		.map(
			(k) =>
				`LOWER(CAST(${colExpr} AS VARCHAR)) LIKE '%${k.replace(/'/g, "''")}%'`,
		)
		.join(" OR ");
}

const Args = z.object({
	layer: z.unknown(),
	column: z.string().min(1),
	out_column: z.string().min(1).default("bucket"),
});

export async function runBucketize(
	args: Record<string, unknown>,
	ctx: ExecCtx,
): Promise<RunnerResult> {
	const { layer, column, out_column } = Args.parse(args);
	const view = resolveTable(layer, ctx);
	const col = quoteIdent(column);
	const whens = RULES.map(
		(r) => `WHEN ${likeClause(col, r.keywords)} THEN '${r.label}'`,
	).join("\n        ");
	const sql = `SELECT *, CASE
        WHEN ${col} IS NULL OR TRIM(CAST(${col} AS VARCHAR)) = '' THEN 'no attempt'
        ${whens}
        ELSE 'other' END AS ${quoteIdent(out_column)}
      FROM ${quoteIdent(view)}`;
	const out = await materializeView(ctx, "bucketized", sql);
	return { output: { kind: "layer", ref: out } };
}

registerRunner("transform.bucketize", runBucketize);
