// packages/widget/test/agent/profile/region.test.ts
import { describe, expect, it } from "vitest";
import {
	type RegionColumn,
	inferRegion,
} from "../../../src/agent/profile/region.js";

const col = (role: string, values: string[]): RegionColumn => ({
	role: role as RegionColumn["role"],
	values,
});

describe("inferRegion", () => {
	it("uses coordinate centroid when lat/lon present", () => {
		const r = inferRegion([
			col("lat", ["29.78", "29.79"]),
			col("lon", ["-81.99", "-82.00"]),
		]);
		expect(r?.source).toBe("coords");
		expect(r?.lat).toBeCloseTo(29.785, 2);
		expect(r?.lon).toBeCloseTo(-81.995, 2);
	});
	it("derives a label from the modal city+state", () => {
		const r = inferRegion([
			col("city", ["Keystone Heights", "Keystone Heights", "Melrose"]),
			col("state", ["FL", "FL", "FL"]),
		]);
		expect(r?.label).toMatch(/Keystone Heights, FL/);
		expect(r?.source).toBe("city_state");
	});
	it("returns none when no geographic columns exist", () => {
		expect(inferRegion([col("measure", ["1", "2"])])).toBeUndefined();
	});
});
