/**
 * Few-shot example reranking by task type.
 *
 * Pure-similarity example selection can underperform zero-shot when the
 * retrieved examples don't match the user's actual task (NAACL 2024,
 * arXiv 2311.09619). We classify both the question and each candidate
 * example's plan into one of {map, chart, table, summary} and boost matches,
 * so the planner sees worked examples of the SAME output shape it should
 * produce — directly reducing the planning mistakes seen in the deep review
 * (e.g. choosing the wrong render tool, or binning a distribution wrong).
 */

import type { Plan } from "../types.js";

export type TaskType = "map" | "chart" | "table" | "summary";

/** Task type implied by a plan's terminal render.* tool. */
export function inferPlanTaskType(plan: Plan): TaskType | null {
	const steps = plan?.steps ?? [];
	for (let i = steps.length - 1; i >= 0; i--) {
		const tool = steps[i]?.tool ?? "";
		if (tool === "render.map") return "map";
		if (tool === "render.chart") return "chart";
		if (tool === "render.table") return "table";
		if (tool === "render.summary") return "summary";
	}
	return null;
}

// Ordered most-specific → least: a "map" cue wins over a generic "show".
const QUESTION_CUES: Array<{ type: TaskType; re: RegExp }> = [
	{
		type: "map",
		re: /\b(map|plot)\b|on a map|where (are|is|should)|locate|geocode|color[- ]?code/i,
	},
	{
		type: "chart",
		re: /\b(chart|graph|histogram|distribution|trend)\b|bar chart|over time|by (month|year|week|day)/i,
	},
	{
		type: "summary",
		re: /\b(summar(y|ize)|describe|overview)\b|tell me about|what can i learn|how (did|successful|many were)|interesting/i,
	},
	{
		type: "table",
		re: /how many|\bcount\b|\blist\b|top \d+|\brank\b|which .*(most|least|highest|lowest|longest|best|worst)|breakdown|by (type|category|level|status)/i,
	},
];

/** Best-guess task type for a user question, or null if ambiguous. */
export function inferQuestionTaskType(question: string): TaskType | null {
	const q = question.toLowerCase();
	for (const cue of QUESTION_CUES) {
		if (cue.re.test(q)) return cue.type;
	}
	return null;
}

const MATCH_BOOST = 0.08;

/**
 * Bounded score boost for an example whose plan output type matches the
 * question's task type. Zero on mismatch or unknown question type — never
 * penalizes, only promotes a same-shape example.
 */
export function taskMatchBoost(question: string, plan: Plan): number {
	const qt = inferQuestionTaskType(question);
	if (!qt) return 0;
	return inferPlanTaskType(plan) === qt ? MATCH_BOOST : 0;
}
