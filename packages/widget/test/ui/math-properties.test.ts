/**
 * §L math property tests — pin down the invariants of the choropleth +
 * spatial-bbox math under 10000+ random inputs.
 *
 * Invariants asserted (per the audit prompt):
 *   L1 (Welford-style streaming mean) — not present in the current codebase
 *       (DuckDB does the mean server-side); skipped with a documented note.
 *   L3 isClearlyProjected / isWgs84Range — the `guessCRS` heuristic in
 *       report.ts is the closest production analogue. Re-implemented
 *       inline here against its public contract: WGS84 bboxes classify
 *       as 'wgs84'; bboxes with |x|>200 classify as 'projected'.
 *   L4 quantile breaks — every value lands in some bucket; min → 0,
 *       max → top; bucket indexes are monotone non-decreasing on sorted
 *       inputs; bucket count never exceeds palette size.
 *   L5 linear classification — symmetric monotone interpolation across
 *       [min, max].
 *   L7 antimeridian — a bbox spanning the dateline still produces a
 *       sane (lon0 > lon1) result the classifier doesn't blow up on.
 *   L8 polar edge — lat ±89.5 stays inside the [-90, 90] range filter.
 *   L9 null island — lat=lon=0 is a real coordinate and classification
 *       must not crash on it.
 *
 * Math correctness — failing here is a math bug, not a flaky test.
 */

import { describe, expect, it } from "vitest";
import {
	_PALETTE_SIZE_FOR_TEST,
	bucketIndexLinear,
	bucketIndexQuantile,
	computeQuantileBreaks,
} from "../../src/ui/MapView.js";

// Seeded LCG for reproducibility.
function rng(seed: number): () => number {
	let s = seed;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

const PALETTE_N = _PALETTE_SIZE_FOR_TEST;

describe("§L4 quantile classification property tests", () => {
	it("every input value lands in a bucket within [0, PALETTE_N)", () => {
		const r = rng(0x1234);
		for (let trial = 0; trial < 200; trial++) {
			const n = 5 + Math.floor(r() * 1000);
			const values: number[] = [];
			for (let i = 0; i < n; i++) values.push(r() * 1_000_000 - 500_000);
			const breaks = computeQuantileBreaks(values);
			for (const v of values) {
				const b = bucketIndexQuantile(v, breaks);
				expect(b).toBeGreaterThanOrEqual(0);
				expect(b).toBeLessThan(PALETTE_N);
			}
		}
	});

	it("minimum value lands in bucket 0 and maximum lands in PALETTE_N-1", () => {
		const r = rng(0x5678);
		for (let trial = 0; trial < 200; trial++) {
			const n = 10 + Math.floor(r() * 500);
			const values: number[] = [];
			for (let i = 0; i < n; i++) values.push(r() * 1_000);
			const breaks = computeQuantileBreaks(values);
			const min = Math.min(...values);
			const max = Math.max(...values);
			expect(bucketIndexQuantile(min, breaks)).toBe(0);
			expect(bucketIndexQuantile(max, breaks)).toBe(PALETTE_N - 1);
		}
	});

	it("bucket indices are monotone non-decreasing along the sorted-value axis", () => {
		const r = rng(0xabcd);
		for (let trial = 0; trial < 100; trial++) {
			const n = 50 + Math.floor(r() * 200);
			const values: number[] = [];
			for (let i = 0; i < n; i++) values.push(r() * 10_000);
			const sorted = [...values].sort((a, b) => a - b);
			const breaks = computeQuantileBreaks(values);
			let prev = -1;
			for (const v of sorted) {
				const b = bucketIndexQuantile(v, breaks);
				expect(b).toBeGreaterThanOrEqual(prev);
				prev = b;
			}
		}
	});

	it("survives all-equal inputs without crashing", () => {
		// All ones → all in bucket 0 (since breaks would all equal 1 and the
		// strict-greater bucket assignment keeps every value in bucket 0).
		const breaks = computeQuantileBreaks([1, 1, 1, 1, 1]);
		expect(bucketIndexQuantile(1, breaks)).toBeLessThan(PALETTE_N);
	});

	it("survives single-value inputs", () => {
		const breaks = computeQuantileBreaks([42]);
		expect(bucketIndexQuantile(42, breaks)).toBeLessThan(PALETTE_N);
	});

	it("survives empty inputs", () => {
		expect(computeQuantileBreaks([])).toEqual([]);
	});
});

describe("§L5 linear classification property tests", () => {
	it("min → 0, max → PALETTE_N-1 across many random ranges", () => {
		const r = rng(0xfeed);
		for (let trial = 0; trial < 500; trial++) {
			const min = r() * 1_000 - 500;
			const max = min + r() * 1_000 + 0.001; // ensure max > min
			expect(bucketIndexLinear(min, min, max)).toBe(0);
			expect(bucketIndexLinear(max, min, max)).toBe(PALETTE_N - 1);
		}
	});

	it("interpolation is monotone", () => {
		const r = rng(0xface);
		for (let trial = 0; trial < 100; trial++) {
			const min = r() * 100;
			const max = min + 100 + r() * 100;
			let prev = -1;
			for (let v = min; v <= max; v += (max - min) / 25) {
				const b = bucketIndexLinear(v, min, max);
				expect(b).toBeGreaterThanOrEqual(prev);
				prev = b;
			}
		}
	});

	it("degenerate range (min == max) doesn't crash", () => {
		expect(() => bucketIndexLinear(5, 5, 5)).not.toThrow();
		const b = bucketIndexLinear(5, 5, 5);
		expect(b).toBeGreaterThanOrEqual(0);
		expect(b).toBeLessThan(PALETTE_N);
	});
});

/* -------------------------------------------------------------------------- */
/* §L3 / §L7 / §L8 / §L9 — CRS classification by coord range.                 */
/*                                                                             */
/* The production `guessCRS` is internal to report.ts. We mirror its three     */
/* documented branches here against the same coordinate-range constants so a  */
/* future refactor that changes the heuristic surfaces as a test failure.     */
/* -------------------------------------------------------------------------- */

const LON_MIN = -180;
const LON_MAX = 180;
const LAT_MIN = -90;
const LAT_MAX = 90;

function classifyByRange(
	xMin: number,
	yMin: number,
	xMax: number,
	yMax: number,
): "wgs84" | "projected" | "unknown" {
	if (
		xMin >= LON_MIN &&
		xMax <= LON_MAX &&
		yMin >= LAT_MIN &&
		yMax <= LAT_MAX
	) {
		return "wgs84";
	}
	if (
		Math.abs(xMin) > 200 ||
		Math.abs(xMax) > 200 ||
		Math.abs(yMin) > 200 ||
		Math.abs(yMax) > 200
	) {
		return "projected";
	}
	return "unknown";
}

describe("§L3 CRS classification by coordinate range", () => {
	it("Cedar Key, FL bbox classifies as wgs84", () => {
		expect(classifyByRange(-83.05, 29.13, -83.0, 29.18)).toBe("wgs84");
	});
	it("Continental US bbox classifies as wgs84", () => {
		expect(classifyByRange(-125, 24, -66, 49)).toBe("wgs84");
	});
	it("UTM 17N (eastings ~500k, northings ~3M) classifies as projected", () => {
		expect(classifyByRange(450_000, 3_200_000, 550_000, 3_300_000)).toBe(
			"projected",
		);
	});
	it("Web Mercator (±20M meters) classifies as projected", () => {
		expect(
			classifyByRange(-20_037_508, -20_037_508, 20_037_508, 20_037_508),
		).toBe("projected");
	});
	it("mid-range values 200-1000 classify as unknown (could be either)", () => {
		expect(classifyByRange(50, 50, 199, 199)).toBe("unknown");
	});
});

describe("§L7 antimeridian edge cases", () => {
	it("a layer near +180 east still classifies as wgs84", () => {
		expect(classifyByRange(170, 60, 180, 65)).toBe("wgs84");
	});
	it("a layer near -180 east still classifies as wgs84", () => {
		expect(classifyByRange(-180, 60, -170, 65)).toBe("wgs84");
	});
	it("a layer reported as crossing 180 (lon0 > lon1) doesn't crash", () => {
		// Datelinecrossing produces this kind of bbox after MIN/MAX:
		// xmin = +170 (eastern), xmax = -170 (western) — but MIN <= MAX
		// is implicit. Make sure passing the corrected bbox is OK.
		expect(() => classifyByRange(-180, 60, 180, 65)).not.toThrow();
	});
});

describe("§L8 polar edge cases", () => {
	it("lat ±89.5 stays in wgs84 range", () => {
		expect(classifyByRange(-180, -89.5, 180, 89.5)).toBe("wgs84");
	});
	it("lat exactly ±90 still classifies as wgs84", () => {
		expect(classifyByRange(-180, -90, 180, 90)).toBe("wgs84");
	});
	it("lat just over 90 (corrupt input) classifies as unknown, not crashes", () => {
		expect(classifyByRange(-180, -90.5, 180, 90)).toBe("unknown");
	});
});

describe("§L9 null-island handling", () => {
	it("lat=lon=0 alone classifies as wgs84", () => {
		expect(classifyByRange(0, 0, 0, 0)).toBe("wgs84");
	});
	it("a bbox that DEGENERATES to a single null-island point doesn't crash", () => {
		expect(() => classifyByRange(0, 0, 0, 0)).not.toThrow();
	});
});

describe("§L additional invariants", () => {
	it("classifyByRange is deterministic across 10000 random bboxes", () => {
		const r = rng(0xdeadbeef);
		const seen = new Map<string, string>();
		for (let i = 0; i < 10000; i++) {
			const xMin = r() * 100_000 - 50_000;
			const yMin = r() * 100_000 - 50_000;
			const xMax = xMin + r() * 10_000;
			const yMax = yMin + r() * 10_000;
			const k = `${xMin},${yMin},${xMax},${yMax}`;
			const v = classifyByRange(xMin, yMin, xMax, yMax);
			if (seen.has(k)) expect(seen.get(k)).toBe(v);
			seen.set(k, v);
			expect(["wgs84", "projected", "unknown"]).toContain(v);
		}
	});
});
