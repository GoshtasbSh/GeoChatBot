import { describe, expect, it } from "vitest";
import {
	pickAddressCols,
	pickRegionHint,
} from "../../../src/agent/executor/runners/geocode.js";

const profile = {
	columns: [
		{ name: "Address", role: "address" },
		{ name: "City", role: "city" },
		{ name: "State", role: "state" },
		{ name: "Notes", role: "free_text_category" },
	],
	inferredRegion: {
		label: "Keystone Heights, FL",
		lon: -82,
		lat: 29.78,
		source: "city_state" as const,
	},
	// biome-ignore lint/suspicious/noExplicitAny: test fixture needs partial profile shape
} as any;

describe("geocode auto-config", () => {
	it("auto-selects address + supporting columns from roles", () => {
		expect(pickAddressCols(profile)).toEqual(["Address", "City", "State"]);
	});
	it("falls back to inferredRegion label for region_hint", () => {
		expect(pickRegionHint(profile)).toBe("Keystone Heights, FL");
	});
});
