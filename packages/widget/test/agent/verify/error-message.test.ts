import { describe, expect, it } from "vitest";
import { friendlyExecError } from "../../../src/agent/verify/error-message.js";

describe("friendlyExecError", () => {
	it("gives an actionable proxy hint for geocode infra failures", () => {
		const msg = friendlyExecError(
			"geocode.address: Failed to fetch census endpoint",
		);
		expect(msg.toLowerCase()).toContain("proxy");
		expect(msg.toLowerCase()).toMatch(/restart|configure/);
	});
	it("flags generic network errors as a service/network issue, not the data", () => {
		const msg = friendlyExecError("HTTP 503 Service Unavailable");
		expect(msg.toLowerCase()).toMatch(/network|service|connection/);
	});
	it("passes logic errors through unchanged", () => {
		const msg = "args failed validation: column 'x' not found";
		expect(friendlyExecError(msg)).toBe(msg);
	});
});
