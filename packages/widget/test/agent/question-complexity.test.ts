/**
 * Question complexity classifier for reasoning-effort gating.
 *
 * Research (OpenAI reasoning guidance + 2025 overthinking studies): pinning
 * reasoning_effort to "high" hurts SIMPLE tasks (overthinking, fixation,
 * output regressions) and wastes latency. Reserve high effort for genuinely
 * multi-step / analytical / spatial-reasoning questions; use medium for
 * straightforward lookups.
 */

import { describe, expect, it } from "vitest";
import { classifyQuestionComplexity } from "../../src/agent/prompts/question-complexity.js";

describe("classifyQuestionComplexity — simple lookups", () => {
	for (const q of [
		"how many stores are there?",
		"list the top 10 cities",
		"map the grocery stores",
		"what is the total revenue?",
		"show the schools on a map",
		"which clinic has the longest wait?",
		"color by category",
	]) {
		it(`simple: "${q}"`, () => {
			expect(classifyQuestionComplexity(q)).toBe("simple");
		});
	}
});

describe("classifyQuestionComplexity — complex / analytical", () => {
	for (const q of [
		"are the cities clustered or spread out?",
		"compare ratings by school level",
		"is the air quality worse in any particular area?",
		"did incidents change over time?",
		"are there any underperforming areas?",
		"what's the average city size, and which cities are above it?",
		"where should patrols focus?",
		"find hotspots of crime and explain why",
	]) {
		it(`complex: "${q}"`, () => {
			expect(classifyQuestionComplexity(q)).toBe("complex");
		});
	}
});

describe("classifyQuestionComplexity — edge cases", () => {
	it("empty question defaults to simple", () => {
		expect(classifyQuestionComplexity("")).toBe("simple");
	});
});
