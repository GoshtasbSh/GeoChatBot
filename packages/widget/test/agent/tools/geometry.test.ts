import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
	vi.resetModules();
});

async function loadGeometry() {
	await import("../../../src/agent/tools/geometry.js");
	return await import("../../../src/agent/tools/registry.js");
}

describe("geometry.* tool registrations", () => {
	it("registers all 10 geometry tools on import", async () => {
		const { listTools } = await loadGeometry();
		const ids = listTools()
			.map((t) => t.id)
			.sort();
		expect(ids).toEqual([
			"geometry.buffer",
			"geometry.centroid",
			"geometry.convex_hull",
			"geometry.difference",
			"geometry.dissolve",
			"geometry.intersect",
			"geometry.reproject",
			"geometry.simplify",
			"geometry.union",
			"geometry.voronoi",
		]);
	});

	it("geometry.buffer accepts valid args with default units", async () => {
		const { getTool } = await loadGeometry();
		const t = getTool("geometry.buffer");
		if (!t) throw new Error("geometry.buffer");
		const r = t.args.parse({ layer: "h", distance: 500 });
		expect((r as Record<string, unknown>).units).toBe("meters");
	});

	it("geometry.buffer rejects negative distance", async () => {
		const { getTool } = await loadGeometry();
		const t = getTool("geometry.buffer");
		if (!t) throw new Error("geometry.buffer");
		expect(t.args.safeParse({ layer: "h", distance: -1 }).success).toBe(false);
	});

	it("geometry.convex_hull accepts mode=concave", async () => {
		const { getTool } = await loadGeometry();
		const t = getTool("geometry.convex_hull");
		if (!t) throw new Error("geometry.convex_hull");
		expect(t.args.safeParse({ layer: "pts", mode: "concave" }).success).toBe(
			true,
		);
	});

	it("geometry.convex_hull rejects mode=square", async () => {
		const { getTool } = await loadGeometry();
		const t = getTool("geometry.convex_hull");
		if (!t) throw new Error("geometry.convex_hull");
		expect(t.args.safeParse({ layer: "pts", mode: "square" }).success).toBe(
			false,
		);
	});

	it("geometry.reproject accepts EPSG-style CRS string", async () => {
		const { getTool } = await loadGeometry();
		const t = getTool("geometry.reproject");
		if (!t) throw new Error("geometry.reproject");
		expect(t.args.safeParse({ layer: "a", to_crs: "EPSG:3857" }).success).toBe(
			true,
		);
	});

	it("every geometry tool has output_kind=layer", async () => {
		const { listTools } = await loadGeometry();
		for (const t of listTools().filter((t) => t.id.startsWith("geometry."))) {
			expect(t.output_kind).toBe("layer");
		}
	});

	it("every geometry tool has a non-empty description", async () => {
		const { listTools } = await loadGeometry();
		for (const t of listTools().filter((t) => t.id.startsWith("geometry."))) {
			expect(t.description.length).toBeGreaterThan(20);
		}
	});

	it("every geometry tool has at least one example", async () => {
		const { listTools } = await loadGeometry();
		for (const t of listTools().filter((t) => t.id.startsWith("geometry."))) {
			expect(t.examples?.length ?? 0).toBeGreaterThan(0);
		}
	});

	it("geometry.simplify rejects negative tolerance", async () => {
		const { getTool } = await loadGeometry();
		const t = getTool("geometry.simplify");
		if (!t) throw new Error("geometry.simplify");
		expect(t.args.safeParse({ layer: "a", tolerance: -1 }).success).toBe(false);
	});
});
