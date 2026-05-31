/**
 * Retriever integration tests.
 *
 * Uses a synthetic embedder (deterministic, no model download) so the
 * retrieval pipeline can be exercised end-to-end at unit-test speed.
 * The synthetic embedder collides keyword-equal strings into the same
 * vector, which is enough to verify routing logic.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	EMBEDDING_DIM,
	__setTestEmbedder,
} from "../../../src/agent/retrieval/embedder.js";
import {
	__resetRetrieverForTests,
	initRetriever,
	rememberPlan,
	retrieve,
} from "../../../src/agent/retrieval/retriever.js";
import type { Plan } from "../../../src/agent/types.js";

/**
 * Bag-of-words keyword embedder. Each unique word maps to a fixed slot
 * in the vector; the resulting vector is L2-normalised so cosine ==
 * dot-product. Two strings that share many words have a high score; two
 * disjoint strings have score 0. Deterministic and Node-friendly.
 */
function syntheticEmbedder(): (text: string) => Float32Array {
	const slots = new Map<string, number>();
	return (text: string) => {
		const v = new Float32Array(EMBEDDING_DIM);
		const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
		for (const t of tokens) {
			let slot = slots.get(t);
			if (slot === undefined) {
				slot = slots.size % EMBEDDING_DIM;
				slots.set(t, slot);
			}
			v[slot] += 1;
		}
		let norm = 0;
		for (let i = 0; i < EMBEDDING_DIM; i++) {
			const vi = v[i];
			norm += vi * vi;
		}
		const inv = norm > 0 ? 1 / Math.sqrt(norm) : 0;
		for (let i = 0; i < EMBEDDING_DIM; i++) {
			v[i] *= inv;
		}
		return v;
	};
}

beforeEach(async () => {
	__setTestEmbedder(syntheticEmbedder());
	await __resetRetrieverForTests();
});

describe("retrieve()", () => {
	it("returns examples + docs for a relevant query", async () => {
		await initRetriever();
		const r = await retrieve("show me hot spots in NYC", {
			maxExamples: 3,
			maxDocs: 3,
		});
		// The bag-of-words embedder will surface examples that share words
		// ("hot spots", "NYC") with the question. We don't assert which
		// specific example wins — just that retrieval produces non-empty
		// and the structure is correct.
		expect(r.examples.length).toBeGreaterThan(0);
		expect(r.examples[0]?.plan.steps.length).toBeGreaterThan(0);
		expect(r.examples[0]?.score).toBeGreaterThan(0);
		expect(typeof r.examples[0]?.question).toBe("string");
	});

	it("returns empty when query is empty", async () => {
		const r = await retrieve("   ");
		expect(r.examples).toEqual([]);
		expect(r.docs).toEqual([]);
	});

	it("user-memory plans are retrievable for similar future questions", async () => {
		const myPlan: Plan = {
			goal: "remember-me",
			assumptions: [],
			dataset_refs: ["custom_dataset"],
			steps: [
				{
					id: "s1",
					tool: "render.summary",
					args: { text: "memory plan" },
					why: "final",
				},
			],
		};
		await rememberPlan(
			"What is the prevailing wind direction in Cedar Key?",
			myPlan,
		);
		const r = await retrieve("Cedar Key wind direction question", {
			maxExamples: 5,
		});
		const memHit = r.examples.find((e) => e.source === "user-memory");
		expect(memHit).toBeDefined();
		expect(memHit?.plan.goal).toBe("remember-me");
	});

	// AUDIT-005 — SEC-008 regression. Read-side gate on the memory store.
	// When the host calls `retrieve()` with `includeMemory: false`, the
	// memory store must NOT contribute few-shots — even if it has
	// matching entries from a prior session that ran with memory on.
	it("AUDIT-005 — skips the memory store when includeMemory: false", async () => {
		const myPlan: Plan = {
			goal: "stale-memory-should-not-leak",
			assumptions: [],
			dataset_refs: ["custom_dataset"],
			steps: [
				{
					id: "s1",
					tool: "render.summary",
					args: { text: "should be hidden" },
					why: "final",
				},
			],
		};
		await rememberPlan(
			"What is the prevailing wind direction in Cedar Key?",
			myPlan,
		);
		const r = await retrieve("Cedar Key wind direction question", {
			maxExamples: 5,
			includeMemory: false,
		});
		const memHit = r.examples.find((e) => e.source === "user-memory");
		expect(memHit).toBeUndefined();
	});

	it("dedupes when memory and a static example both match the query", async () => {
		// Static example #21 ends with "Show me the Florida community survey responses on a map."
		// — repurpose its question text so memory and example collide.
		// The memory plan ends in render.map too, so both examples share the
		// same task type (the query is map-intent): task-match + lexical boosts
		// apply equally, isolating the memory +0.05 tie-break this test targets.
		const dupePlan: Plan = {
			goal: "overridden-by-memory",
			assumptions: [],
			dataset_refs: ["x"],
			steps: [
				{
					id: "s1",
					tool: "render.map",
					args: { layer: "x" },
					why: "final",
				},
			],
		};
		await rememberPlan(
			"Show me the Florida community survey responses on a map.",
			dupePlan,
		);
		const r = await retrieve(
			"Show me the Florida community survey responses on a map.",
		);
		const sources = r.examples.map((e) => e.source);
		// No exact-question duplicates in the result.
		const seen = new Set(r.examples.map((e) => e.question));
		expect(seen.size).toBe(r.examples.length);
		// Memory wins the tie because of its 0.05 score bonus.
		expect(sources[0]).toBe("user-memory");
	});
});
