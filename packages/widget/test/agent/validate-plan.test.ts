import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	_resetRegistry,
	registerTool,
} from "../../src/agent/tools/registry.js";
import {
	PlanValidationError,
	validatePlan,
} from "../../src/agent/validate-plan.js";

const baseStep = (overrides = {}) => ({
	id: "s1",
	tool: "render.summary",
	args: { text: "hi" },
	why: "final",
	...overrides,
});

beforeEach(() => {
	registerTool({
		id: "render.summary",
		description: "d",
		args: z.object({ text: z.string() }),
		output_kind: "rendered",
	});
	registerTool({
		id: "sql",
		description: "d",
		args: z.object({ query: z.string() }),
		output_kind: "table",
	});
});

afterEach(() => _resetRegistry());

describe("validatePlan", () => {
	it("accepts a minimal valid plan", () => {
		expect(() =>
			validatePlan(
				{
					goal: "g",
					assumptions: [],
					dataset_refs: ["x"],
					steps: [baseStep()],
				},
				["x"],
			),
		).not.toThrow();
	});

	it("rejects unknown tool id", () => {
		expect(() =>
			validatePlan(
				{
					goal: "g",
					dataset_refs: ["x"],
					steps: [baseStep({ tool: "unknown.thing" })],
				},
				["x"],
			),
		).toThrow(/unknown tool/i);
	});

	it("rejects last step that is not render.* or render.summary", () => {
		expect(() =>
			validatePlan(
				{
					goal: "g",
					dataset_refs: ["x"],
					steps: [
						{
							id: "s1",
							tool: "sql",
							args: { query: "SELECT 1" },
							why: "q",
							output_var: "t",
						},
					],
				},
				["x"],
			),
		).toThrow(/last step/i);
	});

	it("rejects forward reference", () => {
		expect(() =>
			validatePlan(
				{
					goal: "g",
					dataset_refs: ["x"],
					steps: [
						{
							id: "s1",
							tool: "sql",
							args: { query: "${later}" },
							why: "a",
							output_var: "first",
						},
						baseStep({ id: "s2" }),
					],
				},
				["x"],
			),
		).toThrow(/unknown.*var|forward/i);
	});

	it("rejects self-reference", () => {
		expect(() =>
			validatePlan(
				{
					goal: "g",
					dataset_refs: ["x"],
					steps: [
						{
							id: "s1",
							tool: "sql",
							args: { query: "${self}" },
							why: "q",
							output_var: "self",
						},
						baseStep({ id: "s2" }),
					],
				},
				["x"],
			),
		).toThrow(/self/i);
	});

	it("rejects dataset_ref not loaded", () => {
		expect(() =>
			validatePlan(
				{
					goal: "g",
					dataset_refs: ["missing"],
					steps: [baseStep()],
				},
				["x"],
			),
		).toThrow(/missing/);
	});

	it("rejects step.args that fail per-tool zod parse", () => {
		expect(() =>
			validatePlan(
				{
					goal: "g",
					dataset_refs: ["x"],
					steps: [
						{ id: "s1", tool: "render.summary", args: { text: 42 }, why: "q" },
					],
				},
				["x"],
			),
		).toThrow(/render\.summary/);
	});

	it("accepts backward-only ${var} references", () => {
		expect(() =>
			validatePlan(
				{
					goal: "g",
					dataset_refs: ["x"],
					steps: [
						{
							id: "s1",
							tool: "sql",
							args: { query: "SELECT 1" },
							why: "q",
							output_var: "first",
						},
						{
							id: "s2",
							tool: "render.summary",
							args: { text: "see ${first}" },
							why: "show",
						},
					],
				},
				["x"],
			),
		).not.toThrow();
	});

	it("rejects malformed plan shape (uses PlanSchema)", () => {
		expect(() => validatePlan({}, ["x"])).toThrow(PlanValidationError);
	});

	it("rejects duplicate step ids", () => {
		expect(() =>
			validatePlan(
				{
					goal: "g",
					dataset_refs: ["x"],
					steps: [baseStep({ id: "s1" }), baseStep({ id: "s1" })],
				},
				["x"],
			),
		).toThrow(/duplicate/i);
	});

	it("rejects duplicate output_var across steps", () => {
		// Two steps emitting the same output_var would silently shadow each
		// other in the executor's output map; downstream `${dup}` resolves
		// to whichever ran last. Must be caught before execution.
		expect(() =>
			validatePlan(
				{
					goal: "g",
					dataset_refs: ["x"],
					steps: [
						{
							id: "s1",
							tool: "sql",
							args: { query: "SELECT 1" },
							why: "a",
							output_var: "dup",
						},
						{
							id: "s2",
							tool: "sql",
							args: { query: "SELECT 2" },
							why: "b",
							output_var: "dup",
						},
						{
							id: "s3",
							tool: "render.summary",
							args: { text: "done" },
							why: "show",
						},
					],
				},
				["x"],
			),
		).toThrow(/duplicate output_var/i);
	});

	// AUDIT-021: an output_var that shadows a loaded dataset name causes
	// silent confusion downstream — the executor builds a temporary view
	// alias under that name, and subsequent `FROM <name>` SQL hits the
	// alias instead of the dataset's geom view. Reject up-front.
	it("AUDIT-021: rejects an output_var that collides with a loaded dataset name", () => {
		expect(() =>
			validatePlan(
				{
					goal: "g",
					assumptions: [],
					dataset_refs: ["sales"],
					steps: [
						{
							id: "s1",
							tool: "sql",
							args: { query: "SELECT * FROM sales" },
							why: "a",
							output_var: "sales",
						},
						{
							id: "s2",
							tool: "render.summary",
							args: { text: "done" },
							why: "show",
						},
					],
				},
				["sales"],
			),
		).toThrow(/collides with loaded dataset name/i);
	});
});
