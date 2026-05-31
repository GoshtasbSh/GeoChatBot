// packages/widget/test/agent/profile/roles.test.ts
import { describe, expect, it } from "vitest";
import {
	type RoleInput,
	detectRole,
} from "../../../src/agent/profile/roles.js";

const mk = (o: Partial<RoleInput>): RoleInput => ({
	name: "x",
	type: "string",
	distinctRatio: 0.1,
	nonNullCount: 100,
	samples: [],
	...o,
});

describe("detectRole", () => {
	it("flags an address column from header + street-shaped samples", () => {
		const r = detectRole(
			mk({ name: "Address", samples: ["6116 Harvard Avenue", "6169 Cascade"] }),
		);
		expect(r.role).toBe("address");
	});
	it("flags zip / state / city by shape", () => {
		expect(
			detectRole(
				mk({ name: "ZIP", type: "string", samples: ["32656", "32003"] }),
			).role,
		).toBe("zip");
		expect(detectRole(mk({ name: "State", samples: ["FL", "GA"] })).role).toBe(
			"state",
		);
		expect(
			detectRole(mk({ name: "City", samples: ["Keystone Heights"] })).role,
		).toBe("city");
	});
	it("flags lat/lon by header + numeric range", () => {
		expect(
			detectRole(mk({ name: "latitude", type: "number", samples: ["29.78"] }))
				.role,
		).toBe("lat");
		expect(
			detectRole(mk({ name: "lng", type: "number", samples: ["-81.99"] })).role,
		).toBe("lon");
	});
	it("splits clean category vs free-text needing bucketing on distinctRatio", () => {
		const clean = detectRole(mk({ name: "kind", distinctRatio: 0.2 }));
		expect(clean.role).toBe("category");
		expect(clean.needsBucketing).toBe(false);
		const messy = detectRole(
			mk({
				name: "First attempt",
				distinctRatio: 0.59,
				samples: ["No one home; left flier"],
			}),
		);
		expect(messy.role).toBe("free_text_category");
		expect(messy.needsBucketing).toBe(true);
	});
	it("detects temporal and measure and id", () => {
		expect(detectRole(mk({ name: "date", type: "date" })).role).toBe(
			"temporal",
		);
		expect(
			detectRole(mk({ name: "population", type: "number", distinctRatio: 0.9 }))
				.role,
		).toBe("measure");
		expect(
			detectRole(mk({ name: "record_id", type: "string", distinctRatio: 1 }))
				.role,
		).toBe("id");
	});
});
