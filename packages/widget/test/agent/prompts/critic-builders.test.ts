import { describe, expect, it } from "vitest";
import type { DatasetProfile } from "../../../src/agent/prompts/builders.js";
import { buildCriticUserMessage } from "../../../src/agent/prompts/critic-builders.js";
import type { OutputRef, Step } from "../../../src/agent/types.js";

const failedStep: Step = {
	id: "s2",
	tool: "sql",
	args: { query: "SELECT bad_col FROM points" },
	output_var: "filtered",
	why: "pre-filter",
};

const datasets: DatasetProfile[] = [
	{
		name: "points",
		kind: "layer",
		rows: 100,
		geometry: { kind: "point", column: "geom", crs: "EPSG:4326" },
		columns: [
			{ name: "name", type: "string" },
			{ name: "value", type: "integer" },
		],
		sample: [],
	},
];

describe("buildCriticUserMessage", () => {
	it("wraps the error message in an UNTRUSTED fence", () => {
		const out = buildCriticUserMessage({
			step: failedStep,
			resolvedArgs: failedStep.args,
			errorMessage: 'Binder Error: Referenced column "bad_col" not found',
			priorOutputs: new Map<string, OutputRef>(),
			retryCount: 0,
			maxRetries: 2,
			datasets,
		});
		expect(out).toMatch(/<<<UNTRUSTED_ERROR_MESSAGE/);
		expect(out).toMatch(/UNTRUSTED_ERROR_MESSAGE>>>/);
		expect(out).toMatch(/bad_col/);
	});

	it("wraps the dataset profile in an UNTRUSTED fence", () => {
		const out = buildCriticUserMessage({
			step: failedStep,
			resolvedArgs: failedStep.args,
			errorMessage: "boom",
			priorOutputs: new Map(),
			retryCount: 0,
			maxRetries: 2,
			datasets,
		});
		expect(out).toMatch(/<<<UNTRUSTED_DATASET_PROFILE/);
		expect(out).toMatch(/UNTRUSTED_DATASET_PROFILE>>>/);
	});

	it("lists prior_outputs by name only (no values)", () => {
		const priors = new Map<string, OutputRef>([
			["step1_view", { kind: "table", ref: "gcb_sql_s1_1" }],
			["scalar_out", { kind: "scalar", ref: "k", value: 42 }],
		]);
		const out = buildCriticUserMessage({
			step: failedStep,
			resolvedArgs: failedStep.args,
			errorMessage: "boom",
			priorOutputs: priors,
			retryCount: 0,
			maxRetries: 2,
			datasets,
		});
		expect(out).toMatch(/step1_view.*\(table\)/);
		expect(out).toMatch(/scalar_out.*\(scalar\)/);
		// Scalar value MUST NOT leak into the prompt — it could carry user data.
		expect(out).not.toMatch(/42/);
	});

	it("shows retryCount/maxRetries so the LLM knows the budget", () => {
		const out = buildCriticUserMessage({
			step: failedStep,
			resolvedArgs: failedStep.args,
			errorMessage: "boom",
			priorOutputs: new Map(),
			retryCount: 1,
			maxRetries: 2,
			datasets,
		});
		// AUDIT-020: 1-indexed attempts so the model can reason about
		// budget. retryCount=1 (0-indexed) ⇒ "attempt 2 of 3"
		// (1-indexed total attempts including the initial try).
		expect(out).toMatch(/attempt.*2.*of.*3/i);
	});

	it("wraps resolved args in an UNTRUSTED fence (post-substitution data is not trusted)", () => {
		const out = buildCriticUserMessage({
			step: failedStep,
			resolvedArgs: {
				layer: { kind: "table", ref: "gcb_sql_s1_1" },
				suffix: "value",
			},
			errorMessage: "boom",
			priorOutputs: new Map(),
			retryCount: 0,
			maxRetries: 2,
			datasets,
		});
		expect(out).toMatch(/<<<UNTRUSTED_RESOLVED_ARGS/);
		expect(out).toMatch(/UNTRUSTED_RESOLVED_ARGS>>>/);
		// The internal view name is allowed inside the fence (the LLM needs
		// to know what view the runner saw) but it is now wrapped as
		// untrusted data, not raw text the model could mistake for an
		// instruction.
		expect(out).toMatch(/gcb_sql_s1_1/);
	});

	it("caps a long error message to a sensible size", () => {
		const huge = "x".repeat(20_000);
		const out = buildCriticUserMessage({
			step: failedStep,
			resolvedArgs: failedStep.args,
			errorMessage: huge,
			priorOutputs: new Map(),
			retryCount: 0,
			maxRetries: 2,
			datasets,
		});
		// <= 4 KB cap + a "(truncated)" marker.
		expect(out.length).toBeLessThan(huge.length);
		expect(out).toMatch(/truncated/i);
	});
});
