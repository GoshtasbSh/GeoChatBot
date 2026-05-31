/**
 * Legend computation regression tests.
 *
 * Context: 2026-05-21 — a user reported "color code the points" producing
 * only 2 visible groups with no legend on a community-survey CSV whose
 * `First attempt` column had ~150 distinct semantic outcomes. The fix
 * shipped two things:
 *   1. `computeLegend` returns swatches + labels that the result-canvas
 *      can render; previously the map card only showed a tiny text label.
 *   2. The planner now buckets messy categorical text via SQL before
 *      rendering so a derived 6-bucket column produces 6 visible groups.
 *
 * These tests pin the legend's behavior so a future refactor cannot
 * silently collapse the categories or invert the gradient again.
 */

import { describe, expect, it } from "vitest";
import { computeLegend } from "../../src/ui/MapView.js";

function pt(props: Record<string, unknown>): GeoJSON.Feature {
	return {
		type: "Feature",
		properties: props,
		geometry: { type: "Point", coordinates: [0, 0] },
	};
}

describe("computeLegend — categorical", () => {
	it("returns one entry per distinct value, sorted by frequency", () => {
		const features = [
			...Array(5)
				.fill(0)
				.map(() => pt({ status: "completed" })),
			...Array(3)
				.fill(0)
				.map(() => pt({ status: "no_answer" })),
			...Array(2)
				.fill(0)
				.map(() => pt({ status: "gated" })),
			pt({ status: "vacant" }),
		];
		const spec = computeLegend(features, { colorBy: "status" });
		expect(spec.kind).toBe("categorical");
		expect(spec.colorBy).toBe("status");
		expect(spec.entries.map((e) => e.label)).toEqual([
			"completed",
			"no_answer",
			"gated",
			"vacant",
		]);
		expect(spec.entries.map((e) => e.count)).toEqual([5, 3, 2, 1]);
		// Each entry must carry a 4-channel RGBA swatch (so the renderer
		// can splat it into `rgba(...)` directly).
		for (const e of spec.entries) {
			expect(e.swatch.length).toBe(4);
		}
	});

	it("caps at 10 entries and surfaces hiddenCategoryCount when there are more", () => {
		const features: GeoJSON.Feature[] = [];
		for (let i = 0; i < 15; i++) {
			// 15 distinct values, with freq = 15 - i so the order is stable.
			for (let k = 0; k < 15 - i; k++) {
				features.push(pt({ kind: `bucket_${i}` }));
			}
		}
		const spec = computeLegend(features, { colorBy: "kind" });
		expect(spec.kind).toBe("categorical");
		expect(spec.entries).toHaveLength(10);
		expect(spec.totalCategoryCount).toBe(15);
		expect(spec.hiddenCategoryCount).toBe(5);
		// The MOST frequent buckets must survive the cap (bucket_0 = freq 15).
		expect(spec.entries[0]?.label).toBe("bucket_0");
	});

	it("survives null / undefined property values without throwing", () => {
		const features = [
			pt({ status: "a" }),
			pt({ status: null }),
			pt({ status: undefined }),
			pt({}),
		];
		const spec = computeLegend(features, { colorBy: "status" });
		expect(spec.kind).toBe("categorical");
		expect(spec.entries.map((e) => e.label)).toEqual(["a"]);
	});
});

describe("computeLegend — distinct colors per category (collision regression 2026-05-30)", () => {
	// Repro: a community-survey CSV geocoded to 306 points colored by a
	// derived 6-bucket `status`. The old per-label `stableHash(label) % 10`
	// swatch assignment collided — "no answer", "completed", and
	// "inaccessible" (264 of 306 points) all hashed to the SAME gray, and
	// "refused"/"other" both hashed to pink. The map rendered as a single
	// near-uniform blob even though geocoding and bucketing were correct.
	const mk = (status: string, n: number) =>
		Array(n)
			.fill(0)
			.map(() => pt({ status }));

	it("assigns a DISTINCT swatch to every category up to the palette size", () => {
		const features = [
			...mk("no answer", 110),
			...mk("completed", 80),
			...mk("inaccessible", 74),
			...mk("other", 31),
			...mk("refused", 7),
			...mk("no attempt", 4),
		];
		const spec = computeLegend(features, { colorBy: "status" });
		expect(spec.kind).toBe("categorical");
		const swatchKeys = spec.entries.map((e) => e.swatch.join(","));
		// 6 distinct categories ≤ 10-color palette → 6 distinct swatches.
		expect(new Set(swatchKeys).size).toBe(spec.entries.length);
	});

	it("keeps the top-10 categories collision-free", () => {
		const features: GeoJSON.Feature[] = [];
		for (let i = 0; i < 10; i++) {
			for (let k = 0; k < 10 - i; k++) features.push(pt({ g: `grp_${i}` }));
		}
		const spec = computeLegend(features, { colorBy: "g" });
		const swatchKeys = spec.entries.map((e) => e.swatch.join(","));
		expect(new Set(swatchKeys).size).toBe(10);
	});
});

describe("computeLegend — quantile (numeric)", () => {
	it("produces palette-size entries with [min,max]-range labels", () => {
		const features = Array.from({ length: 50 }, (_, i) => pt({ pop: i * 100 }));
		const spec = computeLegend(features, {
			colorBy: "pop",
			classification: "quantile",
		});
		expect(spec.kind).toBe("quantile");
		// Quantile palette has 5 buckets in MapView.
		expect(spec.entries).toHaveLength(5);
		expect(spec.range?.[0]).toBe(0);
		expect(spec.range?.[1]).toBe(4900);
		// Each label is "lo – hi"; the first label must start at the min
		// and the last must end at the max so the legend is honest.
		expect(spec.entries[0]?.label).toMatch(/^0/);
		const last = spec.entries[spec.entries.length - 1]?.label;
		// Locale formatting may insert a thousands separator; only the numeric
		// digits matter for the legend's "ends at the max" promise.
		expect(last?.replace(/[,\s]/g, "")).toMatch(/4900$/);
	});

	it("collapses to a single value label when min === max", () => {
		const features = Array.from({ length: 10 }, () => pt({ x: 42 }));
		const spec = computeLegend(features, {
			colorBy: "x",
			classification: "quantile",
		});
		expect(spec.kind).toBe("quantile");
		expect(spec.range).toEqual([42, 42]);
		for (const e of spec.entries) {
			expect(e.label).not.toContain("–"); // no range dash on a flat dataset
		}
	});
});

describe("computeLegend — linear (numeric)", () => {
	it("uses palette-size entries with equal-width bins across [min,max]", () => {
		const features = [
			pt({ v: 0 }),
			pt({ v: 25 }),
			pt({ v: 50 }),
			pt({ v: 75 }),
			pt({ v: 100 }),
		];
		const spec = computeLegend(features, {
			colorBy: "v",
			classification: "linear",
		});
		expect(spec.kind).toBe("linear");
		expect(spec.entries).toHaveLength(5);
		expect(spec.range).toEqual([0, 100]);
		// Bins are equal-width — first bin starts at the min, last ends at the max.
		expect(spec.entries[0]?.label.startsWith("0")).toBe(true);
		expect(spec.entries[4]?.label.endsWith("100")).toBe(true);
	});
});

describe("computeLegend — degeneracy warning (2026-05-21)", () => {
	it("flags ≤2 categories on a ≥20-feature dataset", () => {
		const features = [
			...Array(15)
				.fill(0)
				.map(() => pt({ status: "completed" })),
			...Array(15)
				.fill(0)
				.map(() => pt({ status: "not_completed" })),
		];
		const spec = computeLegend(features, { colorBy: "status" });
		expect(spec.warning).toBeDefined();
		expect(spec.warning?.toLowerCase()).toMatch(/2 distinct value|too coarse/);
	});

	it("flags a heavily-skewed breakdown (>=90% in one bucket)", () => {
		const features = [
			...Array(95)
				.fill(0)
				.map(() => pt({ kind: "other" })),
			...Array(3)
				.fill(0)
				.map(() => pt({ kind: "a" })),
			...Array(2)
				.fill(0)
				.map(() => pt({ kind: "b" })),
		];
		const spec = computeLegend(features, { colorBy: "kind" });
		expect(spec.warning).toBeDefined();
		expect(spec.warning?.toLowerCase()).toMatch(/other|skewed/);
	});

	it("does NOT warn when the dataset is tiny (<20 features)", () => {
		const features = [
			pt({ s: "a" }),
			pt({ s: "b" }),
			pt({ s: "a" }),
			pt({ s: "b" }),
		];
		const spec = computeLegend(features, { colorBy: "s" });
		expect(spec.warning).toBeUndefined();
	});

	it("does NOT warn on a healthy 6-bucket breakdown", () => {
		const features = Array.from({ length: 60 }, (_, i) =>
			pt({ bucket: `b${i % 6}` }),
		);
		const spec = computeLegend(features, { colorBy: "bucket" });
		expect(spec.warning).toBeUndefined();
	});
});

describe("computeLegend — degenerate inputs", () => {
	it('returns kind="none" when style has no colorBy', () => {
		const spec = computeLegend([pt({ x: 1 })], undefined);
		expect(spec.kind).toBe("none");
		expect(spec.entries).toEqual([]);
	});

	it('returns kind="none" when style.colorBy is empty', () => {
		const spec = computeLegend([pt({ x: 1 })], {});
		expect(spec.kind).toBe("none");
	});

	it("returns zero entries when the column is entirely null", () => {
		const features = [pt({ status: null }), pt({ status: null })];
		const spec = computeLegend(features, { colorBy: "status" });
		// pickStrategy treats an all-null categorical column as 0% numeric →
		// "categorical"; with no observations, entries[] is empty rather than
		// crashing the renderer.
		expect(spec.entries).toEqual([]);
	});
});
