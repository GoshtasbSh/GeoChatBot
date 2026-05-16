import { describe, expect, it } from "vitest";
import {
	type GazEntry,
	listGazetteer,
	lookupPlace,
} from "../../../src/agent/data/gazetteer.js";

describe("lookupPlace (mini-gazetteer, R.4-c)", () => {
	it("returns undefined for a bare ambiguous name like 'Springfield'", () => {
		expect(lookupPlace("Springfield")).toBeUndefined();
	});

	it("resolves 'Springfield, IL' to the Illinois entry", () => {
		const hit = lookupPlace("Springfield, IL");
		expect(hit).toBeDefined();
		expect(hit?.region).toBe("IL");
		expect(hit?.country).toBe("US");
		expect(hit?.lat).toBeCloseTo(39.78, 1);
		expect(hit?.lon).toBeCloseTo(-89.65, 1);
	});

	it("resolves 'Cedar Key, FL' to the Florida entry", () => {
		const hit = lookupPlace("Cedar Key, FL");
		expect(hit).toBeDefined();
		expect(hit?.region).toBe("FL");
		expect(hit?.country).toBe("US");
		expect(hit?.lat).toBeCloseTo(29.14, 1);
		expect(hit?.lon).toBeCloseTo(-83.04, 1);
	});

	it("treats bare 'London' as canonical UK London", () => {
		const hit = lookupPlace("London");
		expect(hit).toBeDefined();
		expect(hit?.country).toBe("GB");
		expect(hit?.lat).toBeCloseTo(51.51, 1);
	});

	it("distinguishes 'Vienna, VA' from 'Vienna, Austria'", () => {
		const va = lookupPlace("Vienna, VA");
		const at = lookupPlace("Vienna, Austria");
		expect(va).toBeDefined();
		expect(at).toBeDefined();
		expect(va?.country).toBe("US");
		expect(at?.country).toBe("AT");
		expect(va?.lat).not.toBe(at?.lat);
	});

	it("treats bare 'Gainesville' as the FL canonical (UF context)", () => {
		const hit = lookupPlace("Gainesville");
		expect(hit).toBeDefined();
		expect(hit?.region).toBe("FL");
		expect(hit?.country).toBe("US");
	});

	it("is case-insensitive on qualified queries", () => {
		const hit = lookupPlace("cedar key, fl");
		expect(hit).toBeDefined();
		expect(hit?.name).toBe("Cedar Key");
	});

	it("returns undefined for empty or non-string queries", () => {
		expect(lookupPlace("")).toBeUndefined();
		expect(lookupPlace("   ")).toBeUndefined();
		// @ts-expect-error — runtime guard for callers passing junk
		expect(lookupPlace(null)).toBeUndefined();
	});

	it("returns undefined for 'Athens' alone (multiple matches) but resolves qualified forms", () => {
		expect(lookupPlace("Athens")).toBeUndefined();
		const ga = lookupPlace("Athens, GA");
		const gr = lookupPlace("Athens, Greece");
		expect(ga?.country).toBe("US");
		expect(gr?.country).toBe("GR");
	});

	it("listGazetteer returns a non-empty entry list with well-formed entries", () => {
		const all = listGazetteer();
		expect(all.length).toBeGreaterThan(50);
		for (const e of all as readonly GazEntry[]) {
			expect(typeof e.name).toBe("string");
			expect(typeof e.region).toBe("string");
			expect(typeof e.country).toBe("string");
			expect(Number.isFinite(e.lat)).toBe(true);
			expect(Number.isFinite(e.lon)).toBe(true);
			expect(e.lat).toBeGreaterThanOrEqual(-90);
			expect(e.lat).toBeLessThanOrEqual(90);
			expect(e.lon).toBeGreaterThanOrEqual(-180);
			expect(e.lon).toBeLessThanOrEqual(180);
		}
	});
});
