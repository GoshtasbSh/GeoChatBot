/**
 * CoVe summary corrector — the "auto-correct via 1 LLM call" path the user
 * chose for grounding contradictions. When the deterministic gate catches a
 * summary that contradicts the computed table, we make ONE forced-tool call
 * that rewrites the summary to match the data, instead of re-running the
 * whole plan.
 */

import { describe, expect, it, vi } from "vitest";
import {
	buildCorrectionPrompt,
	correctSummary,
	parseCorrectedSummary,
} from "../../src/agent/verify/summary-corrector.js";

const table = {
	columns: ["level", "mean_rating"],
	rows: [
		{ level: "Middle", mean_rating: 7.4 },
		{ level: "Elementary", mean_rating: 6.87 },
	],
};

describe("buildCorrectionPrompt", () => {
	it("includes the table data, the bad summary, and the contradiction reason", () => {
		const p = buildCorrectionPrompt({
			table,
			badSummary: "Elementary has the highest rating.",
			reason: 'summary claims "Elementary" is highest but table shows "Middle"',
		});
		expect(p.user).toMatch(/Middle/);
		expect(p.user).toMatch(/7\.4/);
		expect(p.user).toMatch(/Elementary has the highest rating/);
		expect(p.user.toLowerCase()).toMatch(/contradict|does not match|match the table/);
		// must instruct grounding, not free generation
		expect(p.system.toLowerCase()).toMatch(/only.*table|exactly|from the table/);
	});
});

describe("parseCorrectedSummary", () => {
	it("extracts corrected_summary from a forced-tool result", () => {
		expect(
			parseCorrectedSummary({ corrected_summary: "Middle has the highest rating at 7.4." }),
		).toBe("Middle has the highest rating at 7.4.");
	});
	it("returns null on a malformed result", () => {
		expect(parseCorrectedSummary({})).toBeNull();
		expect(parseCorrectedSummary({ corrected_summary: 42 })).toBeNull();
		expect(parseCorrectedSummary(null)).toBeNull();
	});
});

describe("correctSummary", () => {
	it("calls the injected LLM fn and returns the corrected text", async () => {
		const call = vi
			.fn()
			.mockResolvedValue({ corrected_summary: "Middle has the highest rating (7.4)." });
		const out = await correctSummary(
			{ call },
			{
				table,
				badSummary: "Elementary has the highest rating.",
				reason: "wrong entity",
			},
		);
		expect(out).toBe("Middle has the highest rating (7.4).");
		expect(call).toHaveBeenCalledOnce();
		// the forced-tool input must carry the corrected_summary schema
		const arg = call.mock.calls[0][0];
		expect(arg.toolInputSchema).toBeDefined();
		expect(JSON.stringify(arg.toolInputSchema)).toMatch(/corrected_summary/);
	});

	it("returns null when the LLM call throws (caller falls back to re-plan)", async () => {
		const call = vi.fn().mockRejectedValue(new Error("network"));
		const out = await correctSummary(
			{ call },
			{ table, badSummary: "x", reason: "y" },
		);
		expect(out).toBeNull();
	});

	it("returns null when the model returns an empty/garbage correction", async () => {
		const call = vi.fn().mockResolvedValue({ corrected_summary: "" });
		const out = await correctSummary(
			{ call },
			{ table, badSummary: "x", reason: "y" },
		);
		expect(out).toBeNull();
	});
});
