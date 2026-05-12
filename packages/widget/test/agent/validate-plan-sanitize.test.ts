/**
 * K1 regression: sanitizeArgs must absorb every "useless empty" value the
 * planner's smaller-model fallbacks (Groq Llama-3.1-8B, Gemini Flash) emit
 * into optional fields, NOT just the `""` case. This test asserts the
 * stronger contract introduced for the zero-bug pre-deployment audit:
 *
 *   - empty string ""
 *   - whitespace-only strings (incl. non-ASCII spaces)
 *   - literal sentinel strings: "null", "NA", "N/A", "none", "undefined"
 *     (case-insensitive, surrounding whitespace tolerated)
 *   - arrays containing only sentinel/empty entries collapse to dropped
 *   - arrays where SOME entries are sentinels survive with the sentinels
 *     stripped (e.g. address_cols:["", "Address"] → ["Address"])
 *   - one-level-deep nested objects are walked the same way
 *
 * The repro scenario is the one flagged by the user in the prior session:
 * a CSV with column1..column6 generic columns, an agentic plan that picks
 * geocode.address with `region_hint: ""` (or "null"/"NA"/"N/A") — the plan
 * MUST validate, not dead-end with a `PlanValidationError: String must
 * contain at least 1 character(s)`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	_resetRegistry,
	registerTool,
} from "../../src/agent/tools/registry.js";
import { validatePlan } from "../../src/agent/validate-plan.js";

// Mirror the real geocode.address schema (tools/geocode.ts) so the test
// trips the same .min(1) gates the user hit in production.
const geocodeArgs = z.object({
	layer: z.string(),
	address_cols: z.array(z.string().min(1)).min(1),
	country_code: z.string().length(2).optional(),
	region_hint: z.string().min(1).max(120).optional(),
});

beforeEach(() => {
	registerTool({
		id: "geocode.address",
		description: "d",
		args: geocodeArgs,
		output_kind: "layer",
	});
	registerTool({
		id: "render.map",
		description: "d",
		args: z.object({ layer: z.string().min(1) }),
		output_kind: "rendered",
	});
});
afterEach(() => _resetRegistry());

const plan = (geocodeOverrides: Record<string, unknown>) => ({
	goal: "g",
	assumptions: [],
	dataset_refs: ["survey"],
	steps: [
		{
			id: "s1",
			tool: "geocode.address",
			args: { layer: "survey", address_cols: ["column1"], ...geocodeOverrides },
			output_var: "geocoded",
			why: "address-only column needs geocoding",
		},
		{
			id: "s2",
			tool: "render.map",
			args: { layer: "${geocoded}" },
			why: "show the points",
		},
	],
});

describe("K1: sanitizeArgs strips sentinel-empty values across all optional fields", () => {
	for (const sentinel of [
		"",
		" ",
		"   ",
		"\t",
		"\n",
		" ",
		"null",
		"NULL",
		"Null",
		" null ",
		"NA",
		"na",
		"N/A",
		"n/a",
		"none",
		"NONE",
		"None",
		"undefined",
		"UNDEFINED",
	]) {
		it(`accepts region_hint: ${JSON.stringify(sentinel)} (strips it before validation)`, () => {
			expect(() =>
				validatePlan(plan({ region_hint: sentinel }), ["survey"]),
			).not.toThrow();
		});

		it(`accepts country_code: ${JSON.stringify(sentinel)} (strips it before validation)`, () => {
			// country_code is z.string().length(2).optional(), so ANY sentinel
			// other than a real 2-letter code would fail without sanitization.
			expect(() =>
				validatePlan(plan({ country_code: sentinel }), ["survey"]),
			).not.toThrow();
		});
	}

	it("strips JSON null and undefined for optional fields", () => {
		expect(() =>
			validatePlan(plan({ region_hint: null, country_code: undefined }), [
				"survey",
			]),
		).not.toThrow();
	});

	it("drops sentinel entries inside required arrays but keeps real ones", () => {
		const p = {
			goal: "g",
			dataset_refs: ["survey"],
			steps: [
				{
					id: "s1",
					tool: "geocode.address",
					args: {
						layer: "survey",
						// the model emitted a real column alongside three sentinels
						address_cols: ["", "Address", "null", "  "],
					},
					output_var: "geo",
					why: "geocode",
				},
				{
					id: "s2",
					tool: "render.map",
					args: { layer: "${geo}" },
					why: "show",
				},
			],
		};
		expect(() => validatePlan(p, ["survey"])).not.toThrow();
	});

	it("still rejects when an array is ALL sentinel (no real values survive)", () => {
		// address_cols.min(1) must still fire; sanitization shouldn't silently
		// pass an effectively empty required array.
		const p = {
			goal: "g",
			dataset_refs: ["survey"],
			steps: [
				{
					id: "s1",
					tool: "geocode.address",
					args: {
						layer: "survey",
						address_cols: ["", "  ", "null", "NA", "undefined"],
					},
					output_var: "geo",
					why: "geocode",
				},
				{
					id: "s2",
					tool: "render.map",
					args: { layer: "${geo}" },
					why: "show",
				},
			],
		};
		expect(() => validatePlan(p, ["survey"])).toThrow(/address_cols/);
	});

	it("walks one level into nested objects (e.g. style:{colorBy:''})", () => {
		// render.map with a nested style.colorBy === '' should not dead-end;
		// the empty key inside `style` is stripped, and the outer style stays.
		_resetRegistry();
		registerTool({
			id: "render.map",
			description: "d",
			args: z.object({
				layer: z.string().min(1),
				style: z
					.object({
						colorBy: z.string().min(1).optional(),
						radiusBy: z.string().min(1).optional(),
					})
					.optional(),
			}),
			output_kind: "rendered",
		});
		const p = {
			goal: "g",
			dataset_refs: ["x"],
			steps: [
				{
					id: "s1",
					tool: "render.map",
					args: {
						layer: "x",
						style: { colorBy: "", radiusBy: "value" },
					},
					why: "show",
				},
			],
		};
		expect(() => validatePlan(p, ["x"])).not.toThrow();
	});

	it("property-fuzz: random optional fields filled with sentinels never throw", () => {
		const sentinels = [
			"",
			"  ",
			"null",
			"NA",
			"N/A",
			"none",
			"undefined",
			" \t",
		];
		const rand = (n: number) => Math.floor(Math.random() * n);
		for (let i = 0; i < 200; i++) {
			const region = sentinels[rand(sentinels.length)] as string;
			const country = sentinels[rand(sentinels.length)] as string;
			expect(() =>
				validatePlan(plan({ region_hint: region, country_code: country }), [
					"survey",
				]),
			).not.toThrow();
		}
	});
});
