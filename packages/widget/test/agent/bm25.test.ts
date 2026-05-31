/**
 * Client-side BM25 + Reciprocal Rank Fusion.
 *
 * The MiniLM-L6 embedder blurs rare technical terms ("Moran's I",
 * "choropleth", "geocode"), so exact-keyword queries can miss the right
 * doc. BM25 lexical scoring catches those; RRF fuses it with the dense
 * vector ranking. Pure JS, fully in-browser.
 */

import { describe, expect, it } from "vitest";
import { BM25Index, reciprocalRankFusion } from "../../src/agent/retrieval/bm25.js";

describe("BM25Index", () => {
	const idx = new BM25Index();
	idx.add("geo", "Geocoding when only a street column exists");
	idx.add("moran", "Moran's I global spatial autocorrelation clustering");
	idx.add("choro", "Choropleth of a numeric column by polygon");
	idx.add("crs", "Best CRS for Florida data reproject before distance");

	it("ranks the doc containing the exact query term first", () => {
		const hits = idx.search("choropleth", 3);
		expect(hits[0]?.id).toBe("choro");
	});

	it("matches a rare technical term (Moran)", () => {
		const hits = idx.search("morans i autocorrelation", 3);
		expect(hits[0]?.id).toBe("moran");
	});

	it("matches 'geocode' to the geocoding doc", () => {
		const hits = idx.search("how do I geocode a street address", 4);
		expect(hits[0]?.id).toBe("geo");
	});

	it("returns at most k hits, sorted by score desc", () => {
		const hits = idx.search("spatial data column", 2);
		expect(hits.length).toBeLessThanOrEqual(2);
		for (let i = 1; i < hits.length; i++) {
			expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
		}
	});

	it("returns nothing for an empty or all-unknown query", () => {
		expect(idx.search("", 3)).toEqual([]);
		expect(idx.search("zzzz qqqq", 3)).toEqual([]);
	});
});

describe("reciprocalRankFusion", () => {
	it("fuses two ranked id lists, rewarding agreement", () => {
		// 'b' is rank 1 then rank 0; 'a' is rank 0 then rank 2 — b's combined
		// reciprocal rank beats a's, so consistent high placement wins.
		const fused = reciprocalRankFusion([
			["a", "b", "c"],
			["b", "c", "a"],
		]);
		expect(fused[0]).toBe("b");
	});

	it("includes ids that appear in only one list", () => {
		const fused = reciprocalRankFusion([["x"], ["y"]]);
		expect(new Set(fused)).toEqual(new Set(["x", "y"]));
	});

	it("handles empty lists", () => {
		expect(reciprocalRankFusion([[], []])).toEqual([]);
		expect(reciprocalRankFusion([])).toEqual([]);
	});
});
