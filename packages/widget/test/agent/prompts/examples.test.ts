import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	EXAMPLES,
	renderExamplesBlock,
} from "../../../src/agent/prompts/examples.js";
import { type Plan, PlanSchema } from "../../../src/agent/types.js";
import "../../../src/agent/tools/index.js"; // register all tools
import { validatePlan } from "../../../src/agent/validate-plan.js";

describe("few-shot examples", () => {
	it("contains at least 22 examples", () => {
		// Lower-bound assertion so the suite isn't fragile to additions.
		// New canonical-pattern examples (report.quickscan, direct lat/lon
		// map, count-per-polygon, …) push the count above 22; that's fine.
		expect(EXAMPLES.length).toBeGreaterThanOrEqual(22);
	});

	it("every example has a question and a plan that parses against PlanSchema", () => {
		for (const e of EXAMPLES) {
			expect(typeof e.question).toBe("string");
			const r = PlanSchema.safeParse(e.plan);
			if (!r.success) console.error(e.question, r.error.message);
			expect(r.success).toBe(true);
		}
	});

	it("every example plan validates against the registered tool catalog", () => {
		for (const e of EXAMPLES) {
			const datasets = e.plan.dataset_refs;
			expect(() => validatePlan(e.plan as Plan, datasets)).not.toThrow();
		}
	});

	it("renderExamplesBlock fits within the single-shot prompt budget", () => {
		// Budget: ≤ 42 KB of examples ≈ ~10.5k tokens. The single-shot
		// planner prompt also carries the system preamble, tool catalog,
		// and dataset profile (~2k tokens combined). Total ~12.5k stays
		// under Anthropic / OpenAI context windows comfortably and at
		// the edge of Groq's 12k TPM ceiling for the 70b model. (Agentic
		// mode does NOT use this block — see planner.ts.)
		const block = renderExamplesBlock();
		expect(block.length).toBeLessThan(42000);
	});
});
