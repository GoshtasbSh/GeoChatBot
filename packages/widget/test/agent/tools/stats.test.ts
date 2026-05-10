import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
	vi.resetModules();
});

async function loadStats() {
	await import("../../../src/agent/tools/stats.js");
	return await import("../../../src/agent/tools/registry.js");
}

describe("stats.* tool registrations", () => {
	it("registers exactly 7 stats tools", async () => {
		const { listTools } = await loadStats();
		expect(
			listTools()
				.map((t) => t.id)
				.sort(),
		).toEqual([
			"stats.aggregate",
			"stats.density_grid",
			"stats.distance_matrix",
			"stats.getis_ord_gi",
			"stats.hex_bin",
			"stats.morans_i",
			"stats.summary_stats",
		]);
	});

	it("stats.aggregate enforces agg_fn enum", async () => {
		const { getTool } = await loadStats();
		const t = getTool("stats.aggregate");
		if (!t) throw new Error("stats.aggregate");
		expect(
			t.args.safeParse({
				layer: "x",
				group_by: "g",
				agg_fn: "sum",
				value_col: "v",
			}).success,
		).toBe(true);
		expect(
			t.args.safeParse({
				layer: "x",
				group_by: "g",
				agg_fn: "avg2",
				value_col: "v",
			}).success,
		).toBe(false);
	});

	it("stats.hex_bin enforces 0 ≤ resolution ≤ 15", async () => {
		const { getTool } = await loadStats();
		const t = getTool("stats.hex_bin");
		if (!t) throw new Error("stats.hex_bin");
		expect(t.args.safeParse({ layer: "x", h3_resolution: 8 }).success).toBe(
			true,
		);
		expect(t.args.safeParse({ layer: "x", h3_resolution: -1 }).success).toBe(
			false,
		);
		expect(t.args.safeParse({ layer: "x", h3_resolution: 16 }).success).toBe(
			false,
		);
	});

	it('stats.morans_i defaults weights to "queen"', async () => {
		const { getTool } = await loadStats();
		const t = getTool("stats.morans_i");
		if (!t) throw new Error("stats.morans_i");
		const r = t.args.parse({ layer: "x", value_col: "v" });
		expect((r as Record<string, unknown>).weights).toBe("queen");
	});

	it("stats.density_grid requires positive cell_size", async () => {
		const { getTool } = await loadStats();
		const t = getTool("stats.density_grid");
		if (!t) throw new Error("stats.density_grid");
		expect(
			t.args.safeParse({ layer: "x", cell_size: 100, agg_fn: "count" }).success,
		).toBe(true);
		expect(
			t.args.safeParse({ layer: "x", cell_size: 0, agg_fn: "count" }).success,
		).toBe(false);
	});

	it("stats.morans_i has output_kind=scalar (returns a Moran statistic)", async () => {
		const { getTool } = await loadStats();
		expect(getTool("stats.morans_i")?.output_kind).toBe("scalar");
	});

	it("stats.getis_ord_gi has output_kind=layer (per-feature z-score)", async () => {
		const { getTool } = await loadStats();
		expect(getTool("stats.getis_ord_gi")?.output_kind).toBe("layer");
	});
});
