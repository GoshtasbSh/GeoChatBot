/**
 * Few-shot example reranking by task type.
 *
 * Research (NAACL 2024, arXiv 2311.09619): naive similarity selection of
 * in-context examples can score BELOW zero-shot when the examples aren't a
 * good task match. Boosting examples whose plan produces the SAME output
 * type as the user's question (map / chart / table / summary) steers a
 * mid-tier planner toward the right plan shape and reduces planning mistakes.
 */

import { describe, expect, it } from "vitest";
import type { Plan } from "../../src/agent/types.js";
import {
	inferPlanTaskType,
	inferQuestionTaskType,
	taskMatchBoost,
} from "../../src/agent/retrieval/example-reranker.js";

function planEndingIn(tool: string): Plan {
	return {
		assumptions: [],
		steps: [
			{ id: "s1", tool: "sql", args: {}, output_var: "x" },
			{ id: "s2", tool, args: {} },
		],
	} as unknown as Plan;
}

describe("inferPlanTaskType", () => {
	it("classifies by the final render tool", () => {
		expect(inferPlanTaskType(planEndingIn("render.map"))).toBe("map");
		expect(inferPlanTaskType(planEndingIn("render.chart"))).toBe("chart");
		expect(inferPlanTaskType(planEndingIn("render.table"))).toBe("table");
		expect(inferPlanTaskType(planEndingIn("render.summary"))).toBe("summary");
	});
	it("returns null when no render step is present", () => {
		expect(inferPlanTaskType(planEndingIn("sql"))).toBeNull();
	});
});

describe("inferQuestionTaskType", () => {
	it("detects map intent", () => {
		expect(inferQuestionTaskType("map the grocery stores")).toBe("map");
		expect(inferQuestionTaskType("where are my most profitable stores?")).toBe("map");
	});
	it("detects chart intent", () => {
		expect(inferQuestionTaskType("show the revenue distribution as a chart")).toBe("chart");
		expect(inferQuestionTaskType("did incidents change over time?")).toBe("chart");
	});
	it("detects table intent", () => {
		expect(inferQuestionTaskType("which clinics have the longest wait?")).toBe("table");
		expect(inferQuestionTaskType("list the top 10 cities")).toBe("table");
	});
	it("detects summary intent", () => {
		expect(inferQuestionTaskType("summarize how the survey went")).toBe("summary");
		expect(inferQuestionTaskType("what can I learn from this data?")).toBe("summary");
	});
	it("returns null on an ambiguous question", () => {
		expect(inferQuestionTaskType("hmm")).toBeNull();
	});
});

describe("taskMatchBoost", () => {
	it("rewards a plan whose type matches the question type", () => {
		const b = taskMatchBoost("map the stores", planEndingIn("render.map"));
		expect(b).toBeGreaterThan(0);
	});
	it("gives no boost on a type mismatch", () => {
		const b = taskMatchBoost("map the stores", planEndingIn("render.chart"));
		expect(b).toBe(0);
	});
	it("gives no boost when the question type is unknown", () => {
		expect(taskMatchBoost("hmm", planEndingIn("render.map"))).toBe(0);
	});
});
