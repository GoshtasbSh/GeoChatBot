// packages/widget/test/agent/verify/failure-classifier.test.ts
import { describe, expect, it } from "vitest";
import { classifyFailure } from "../../../src/agent/verify/failure-classifier.js";

describe("classifyFailure", () => {
	it("classifies network / CORS / non-JSON / 5xx as infra", () => {
		expect(
			classifyFailure({ kind: "error", message: "Failed to fetch" }).cls,
		).toBe("infra");
		expect(
			classifyFailure({
				kind: "error",
				message: "Unexpected token < in JSON at position 0",
			}).cls,
		).toBe("infra");
		expect(
			classifyFailure({
				kind: "error",
				message: "HTTP 503 Service Unavailable",
			}).cls,
		).toBe("infra");
	});
	it("classifies geocode 0% with a valid-looking address column as infra", () => {
		expect(
			classifyFailure({
				kind: "guard",
				guardId: "geocode",
				reason: "0%",
				inputsLookValid: true,
			}).cls,
		).toBe("infra");
	});
	it("classifies geocode 0% with street-only-no-region as logic", () => {
		expect(
			classifyFailure({
				kind: "guard",
				guardId: "geocode",
				reason: "0%",
				inputsLookValid: false,
			}).cls,
		).toBe("logic");
	});
	it("classifies validation / empty-result / degeneracy as logic", () => {
		expect(
			classifyFailure({ kind: "error", message: "args failed validation: ..." })
				.cls,
		).toBe("logic");
		expect(
			classifyFailure({ kind: "guard", guardId: "colorBy", reason: "1 color" })
				.cls,
		).toBe("logic");
	});
});
