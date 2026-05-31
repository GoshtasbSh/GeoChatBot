import { describe, expect, it } from "vitest";
import { augmentProfile } from "../../../src/agent/profile/augment.js";
import type { DatasetProfile } from "../../../src/agent/prompts/builders.js";

const base: DatasetProfile = {
	name: "survey",
	kind: "table",
	rows: 317,
	sample: [],
	columns: [
		{
			name: "Address",
			type: "string",
			cardinality: 300,
			samples: ["6116 Harvard Avenue"],
		},
		{
			name: "First attempt",
			type: "string",
			cardinality: 185,
			samples: ["No one home; left flier"],
		},
		{
			name: "City",
			type: "string",
			cardinality: 1,
			samples: ["Keystone Heights"],
		},
		{ name: "State", type: "string", cardinality: 1, samples: ["FL"] },
	],
};

describe("augmentProfile", () => {
	it("adds a role + needsBucketing to each column", () => {
		const p = augmentProfile(base);
		const byName = Object.fromEntries(p.columns.map((c) => [c.name, c]));
		expect(byName.Address.role).toBe("address");
		expect(byName["First attempt"].role).toBe("free_text_category");
		expect(byName["First attempt"].needsBucketing).toBe(true);
	});
	it("infers a region from city/state", () => {
		const p = augmentProfile(base);
		expect(p.inferredRegion?.label).toMatch(/Keystone Heights, FL/);
	});
});
