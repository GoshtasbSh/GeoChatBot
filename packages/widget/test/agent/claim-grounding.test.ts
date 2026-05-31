/**
 * Deterministic claim-grounding checker.
 *
 * Catches the #1 correctness failure from the 2026-05-31 deep review:
 * a render.summary whose superlative claim CONTRADICTS the table the
 * same plan just computed (D9-Q3: table shows Middle=7.4 highest, summary
 * says "Elementary is highest"). Pure code, no LLM — we OWN the table, so
 * argmax/argmin is ground truth.
 */

import { describe, expect, it } from "vitest";
import { checkClaimGrounding } from "../../src/agent/verify/claim-grounding.js";

describe("checkClaimGrounding — superlative entity match", () => {
	const ratings = {
		columns: ["level", "mean_rating"],
		rows: [
			{ level: "Middle", mean_rating: 7.4 },
			{ level: "Elementary", mean_rating: 6.87 },
			{ level: "High", mean_rating: 6.74 },
			{ level: "K-8", mean_rating: 6.57 },
		],
	};

	it("passes when the summary names the true argmax entity", () => {
		const v = checkClaimGrounding({
			summary: "The Middle level has the highest average school rating at 7.4.",
			...ratings,
		});
		expect(v.ok).toBe(true);
	});

	it("FAILS when the summary names the wrong entity as highest (D9-Q3)", () => {
		const v = checkClaimGrounding({
			summary: "The Elementary level has the highest average school rating.",
			...ratings,
		});
		expect(v.ok).toBe(false);
		expect(v.severity).toBe("fail");
		expect(v.reason).toMatch(/Elementary/i);
		expect(v.reason).toMatch(/Middle/i);
	});

	it("passes a correct 'most money' claim", () => {
		const v = checkClaimGrounding({
			summary: "Cafe makes the most money overall.",
			columns: ["category", "total_revenue"],
			rows: [
				{ category: "Cafe", total_revenue: 15126000 },
				{ category: "Grocery", total_revenue: 5000000 },
			],
		});
		expect(v.ok).toBe(true);
	});

	it("FAILS a wrong 'most money' claim", () => {
		const v = checkClaimGrounding({
			summary: "Grocery makes the most money overall.",
			columns: ["category", "total_revenue"],
			rows: [
				{ category: "Cafe", total_revenue: 15126000 },
				{ category: "Grocery", total_revenue: 5000000 },
			],
		});
		expect(v.ok).toBe(false);
		expect(v.severity).toBe("fail");
	});

	it("handles 'lowest/least' direction", () => {
		const incidents = {
			columns: ["type", "cnt"],
			rows: [
				{ type: "Noise", cnt: 10 },
				{ type: "Theft", cnt: 3 },
			],
		};
		expect(
			checkClaimGrounding({
				summary: "Theft is the least common incident type.",
				...incidents,
			}).ok,
		).toBe(true);
		expect(
			checkClaimGrounding({
				summary: "Noise is the least common incident type.",
				...incidents,
			}).ok,
		).toBe(false);
	});
});

describe("checkClaimGrounding — high-precision (no false positives)", () => {
	it("passes when there is no superlative claim at all", () => {
		const v = checkClaimGrounding({
			summary: "Here is a breakdown of the survey statuses.",
			columns: ["status", "count"],
			rows: [
				{ status: "done", count: 5 },
				{ status: "pending", count: 9 },
			],
		});
		expect(v.ok).toBe(true);
	});

	it("passes (skips) when the table is empty", () => {
		expect(
			checkClaimGrounding({
				summary: "X is the highest.",
				columns: ["a", "b"],
				rows: [],
			}).ok,
		).toBe(true);
	});

	it("passes (skips) when the claimed entity is not a table label", () => {
		// Summary mentions a superlative but the subject isn't any row label
		// — we cannot verify, so we must NOT false-positive.
		const v = checkClaimGrounding({
			summary: "Overall the campaign had the highest engagement in spring.",
			columns: ["level", "mean_rating"],
			rows: [
				{ level: "Middle", mean_rating: 7.4 },
				{ level: "Elementary", mean_rating: 6.87 },
			],
		});
		expect(v.ok).toBe(true);
	});

	it("passes (skips) when there is no numeric column to rank by", () => {
		const v = checkClaimGrounding({
			summary: "Middle is the best.",
			columns: ["level", "note"],
			rows: [
				{ level: "Middle", note: "good" },
				{ level: "High", note: "ok" },
			],
		});
		expect(v.ok).toBe(true);
	});

	it("FAILS when superlative names right entity but wrong value", () => {
		const v = checkClaimGrounding({
			summary: "Middle has the highest rating at 9.9.",
			columns: ["level", "mean_rating"],
			rows: [
				{ level: "Middle", mean_rating: 7.4 },
				{ level: "Elementary", mean_rating: 6.87 },
			],
		});
		expect(v.ok).toBe(false);
		expect(v.reason).toMatch(/7\.4|9\.9/);
	});
});
