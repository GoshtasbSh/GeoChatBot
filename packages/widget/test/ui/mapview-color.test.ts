/**
 * AUDIT-013 / AUDIT-014 — color-classification math for the MapView
 * choropleth path.
 *
 * Validates that:
 *   - The bottom quantile bucket actually receives data even with ties.
 *   - The top bucket caps cleanly at the dataset maximum.
 *   - Linear classification interpolates value position [min,max]
 *     across the palette, NOT through quantile breaks.
 *
 * These pure functions are exported from MapView.ts purely for testing
 * (the production color-accessor closes over palette + style internally).
 */

import { describe, expect, it } from "vitest";
import {
	_PALETTE_SIZE_FOR_TEST,
	bucketIndexLinear,
	bucketIndexQuantile,
	computeQuantileBreaks,
} from "../../src/ui/MapView.js";

describe("AUDIT-013 — quantile bucketing fills the bottom bucket on ties", () => {
	it("assigns the minimum value to bucket 0 when many values are equal at the floor index", () => {
		// Pathological case: 9 ones, then 2,3,4,5. With the old
		// (floor(q * n)) + >= bucket assignment, breaks[0] landed on
		// `1` and the >= test pushed every `1` to bucket 1, leaving
		// bucket 0 empty.
		const values = [1, 1, 1, 1, 1, 2, 3, 4, 5, 6];
		const breaks = computeQuantileBreaks(values);
		const minBucket = bucketIndexQuantile(1, breaks);
		// The minimum data value must end up in the LOWEST bucket — that
		// is the entire point of a choropleth's "yellow → teal" gradient.
		expect(minBucket).toBe(0);
	});

	it("assigns the maximum value to the top bucket", () => {
		const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		const breaks = computeQuantileBreaks(values);
		const maxBucket = bucketIndexQuantile(10, breaks);
		expect(maxBucket).toBe(_PALETTE_SIZE_FOR_TEST - 1);
	});

	it("monotonically increases bucket index as value increases (no inversions)", () => {
		const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		const breaks = computeQuantileBreaks(values);
		let prev = -1;
		for (const v of values) {
			const b = bucketIndexQuantile(v, breaks);
			expect(b).toBeGreaterThanOrEqual(prev);
			prev = b;
		}
	});

	it("handles an all-equal dataset without throwing or returning negative buckets", () => {
		const values = [5, 5, 5, 5, 5];
		const breaks = computeQuantileBreaks(values);
		const b = bucketIndexQuantile(5, breaks);
		expect(b).toBeGreaterThanOrEqual(0);
		expect(b).toBeLessThan(_PALETTE_SIZE_FOR_TEST);
	});
});

describe("AUDIT-014 — linear classification interpolates [min, max] across the palette", () => {
	it("returns bucket 0 for the dataset minimum and the top bucket for the maximum", () => {
		const min = 0;
		const max = 100;
		expect(bucketIndexLinear(min, min, max)).toBe(0);
		expect(bucketIndexLinear(max, min, max)).toBe(_PALETTE_SIZE_FOR_TEST - 1);
	});

	it("places the midpoint near the palette middle (NOT skewed by data distribution)", () => {
		const min = 0;
		const max = 100;
		const mid = bucketIndexLinear(50, min, max);
		// Palette is 5 buckets → midpoint should be bucket 2 (index 0..4).
		expect(mid).toBe(2);
	});

	it("clamps out-of-range values to the palette extents", () => {
		expect(bucketIndexLinear(-1000, 0, 100)).toBe(0);
		expect(bucketIndexLinear(1e9, 0, 100)).toBe(_PALETTE_SIZE_FOR_TEST - 1);
	});

	it("when min === max (no span) every value lands in bucket 0", () => {
		expect(bucketIndexLinear(42, 42, 42)).toBe(0);
	});
});
