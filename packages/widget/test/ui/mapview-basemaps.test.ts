/**
 * Locks the basemap registry surfaced by <gcb-map>: the selectable basemaps,
 * their order, the default, and the shape of each (key-free) raster style.
 *
 * These are plain exports from MapView.ts — importing them does not bring up
 * MapLibre or deck.gl, so the test stays fast and deterministic.
 */

import { describe, expect, it } from "vitest";
import {
	BASEMAPS,
	type BasemapId,
	DEFAULT_BASEMAP_ID,
} from "../../src/ui/MapView.js";

describe("MapView basemap registry", () => {
	it("exposes the four expected basemaps in display order", () => {
		expect(BASEMAPS.map((b) => b.id)).toEqual([
			"light",
			"osm",
			"satellite",
			"dark",
		]);
	});

	it("defaults to the Light (Positron) basemap", () => {
		expect(DEFAULT_BASEMAP_ID).toBe("light");
		expect(BASEMAPS.some((b) => b.id === DEFAULT_BASEMAP_ID)).toBe(true);
	});

	it("every basemap has a human label and a valid v8 raster style", () => {
		for (const b of BASEMAPS) {
			expect(b.label.length).toBeGreaterThan(0);
			expect(b.style.version).toBe(8);

			const sourceIds = Object.keys(b.style.sources);
			expect(sourceIds.length).toBe(1);
			const source = b.style.sources[sourceIds[0] as string];
			expect(source.type).toBe("raster");
			// key-free: must serve from real tile URL templates, no api token.
			const tiles = (source as { tiles?: string[] }).tiles ?? [];
			expect(tiles.length).toBeGreaterThan(0);
			for (const t of tiles) {
				expect(t).toMatch(/^https:\/\//);
				expect(t).toContain("{z}");
				expect(t).toContain("{x}");
				expect(t).toContain("{y}");
				expect(t).not.toMatch(/(api_key|access_token|apikey|token=)/i);
			}
			// attribution is required for every provider we use.
			expect(
				(source as { attribution?: string }).attribution?.length ?? 0,
			).toBeGreaterThan(0);

			expect(b.style.layers).toHaveLength(1);
			expect(b.style.layers[0]?.type).toBe("raster");
		}
	});

	it("has no duplicate basemap ids", () => {
		const ids = BASEMAPS.map((b) => b.id) as BasemapId[];
		expect(new Set(ids).size).toBe(ids.length);
	});
});
