import { describe, expect, it, vi } from "vitest";
import {
	type OrchestratorDeps,
	runReliable,
} from "../../../src/agent/agentic/orchestrator.js";

const goodVerdict = { ok: true, guards: [] };
const badLogic = {
	ok: false,
	guards: [
		{
			ok: false,
			severity: "fail" as const,
			reason: "1 color",
			suggestedFix: "bucketize",
		},
	],
};

function deps(over: Partial<OrchestratorDeps>): OrchestratorDeps {
	return {
		plan: vi.fn(async () => ({ id: "p1", steps: [] })),
		execute: vi.fn(async () => ({ ok: true, outputs: [], error: undefined })),
		verify: vi.fn(async () => goodVerdict),
		classify: vi.fn(() => ({ cls: "logic", reason: "x" })),
		maxAttempts: 2,
		...over,
	} as OrchestratorDeps;
}

describe("runReliable", () => {
	it("returns success on first good outcome", async () => {
		const d = deps({});
		// biome-ignore lint/suspicious/noExplicitAny: test fixture needs partial profile shape
		const r = await runReliable({ query: "q", profile: {} as any }, d);
		expect(r.status).toBe("success");
		expect(d.plan).toHaveBeenCalledTimes(1);
	});

	it("re-plans once on a logic failure then succeeds", async () => {
		const verify = vi
			.fn()
			.mockResolvedValueOnce(badLogic)
			.mockResolvedValueOnce(goodVerdict);
		const d = deps({
			verify,
			classify: vi.fn(() => ({ cls: "logic", reason: "x" })),
		});
		// biome-ignore lint/suspicious/noExplicitAny: test fixture needs partial profile shape
		const r = await runReliable({ query: "q", profile: {} as any }, d);
		expect(r.status).toBe("success");
		expect(d.plan).toHaveBeenCalledTimes(2);
	});

	it("stops immediately (no re-plan) on infra failure", async () => {
		const verify = vi.fn().mockResolvedValue(badLogic);
		const classify = vi.fn(() => ({ cls: "infra", reason: "proxy down" }));
		const d = deps({ verify, classify });
		// biome-ignore lint/suspicious/noExplicitAny: test fixture needs partial profile shape
		const r = await runReliable({ query: "q", profile: {} as any }, d);
		expect(r.status).toBe("infra_failure");
		expect(d.plan).toHaveBeenCalledTimes(1);
	});

	it("returns honest logic failure after maxAttempts", async () => {
		const verify = vi.fn().mockResolvedValue(badLogic);
		const d = deps({
			verify,
			classify: vi.fn(() => ({ cls: "logic", reason: "x" })),
			maxAttempts: 2,
		});
		// biome-ignore lint/suspicious/noExplicitAny: test fixture needs partial profile shape
		const r = await runReliable({ query: "q", profile: {} as any }, d);
		expect(r.status).toBe("logic_failure");
		expect(d.plan).toHaveBeenCalledTimes(2);
	});
});
