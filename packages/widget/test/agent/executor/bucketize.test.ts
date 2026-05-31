import { describe, expect, it } from "vitest";
import { bucketLabel } from "../../../src/agent/executor/runners/bucketize.js";

describe("bucketLabel — survey status lexicon", () => {
	it("maps free text to clean buckets", () => {
		expect(bucketLabel("completed survey")).toBe("completed");
		expect(bucketLabel("Alex Rivera; survey; ID# 8081")).toBe("completed");
		expect(bucketLabel("No one home; left flier")).toBe("no answer");
		expect(bucketLabel("Gated")).toBe("inaccessible");
		expect(bucketLabel("Not interested in taking the survey")).toBe("refused");
		expect(bucketLabel("")).toBe("no attempt");
		expect(bucketLabel("something random")).toBe("other");
	});
});
