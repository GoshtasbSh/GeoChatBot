import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
	vi.resetModules();
});

async function loadJoins() {
	await import("../../../src/agent/tools/joins.js");
	return await import("../../../src/agent/tools/registry.js");
}

describe("joins.* tool registrations", () => {
	it("registers exactly 3 joins tools", async () => {
		const { listTools } = await loadJoins();
		expect(
			listTools()
				.map((t) => t.id)
				.sort(),
		).toEqual([
			"joins.nearest_neighbor",
			"joins.point_in_polygon",
			"joins.spatial_join",
		]);
	});

	it("joins.spatial_join requires predicate enum", async () => {
		const { getTool } = await loadJoins();
		const t = getTool("joins.spatial_join");
		if (!t) throw new Error("joins.spatial_join");
		expect(
			t.args.safeParse({ a: "x", b: "y", predicate: "within" }).success,
		).toBe(true);
		expect(
			t.args.safeParse({ a: "x", b: "y", predicate: "badpred" }).success,
		).toBe(false);
	});

	it("joins.nearest_neighbor requires k positive integer", async () => {
		const { getTool } = await loadJoins();
		const t = getTool("joins.nearest_neighbor");
		if (!t) throw new Error("joins.nearest_neighbor");
		expect(t.args.safeParse({ a: "x", b: "y", k: 3 }).success).toBe(true);
		expect(t.args.safeParse({ a: "x", b: "y", k: 0 }).success).toBe(false);
		expect(t.args.safeParse({ a: "x", b: "y", k: 1.5 }).success).toBe(false);
	});
});
