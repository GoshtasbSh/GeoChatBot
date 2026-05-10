import { beforeEach, describe, expect, it } from "vitest";
import {
	_resetRunnerRegistry,
	getRunner,
	listRunners,
	registerRunner,
} from "../../../src/agent/executor/runtime.js";

beforeEach(() => {
	_resetRunnerRegistry();
});

describe("runtime registry", () => {
	it("returns undefined for unknown ids", () => {
		expect(getRunner("does.not.exist")).toBeUndefined();
	});

	it("registers and recalls a runner", async () => {
		const runner = async () => ({
			output: { kind: "table" as const, ref: "view_x" },
		});
		registerRunner("mock.x", runner);
		const got = getRunner("mock.x");
		expect(got).toBe(runner);
		expect(listRunners()).toContain("mock.x");
	});

	it("rejects duplicate registration", () => {
		registerRunner("mock.dup", async () => ({
			output: { kind: "table" as const, ref: "r" },
		}));
		expect(() =>
			registerRunner("mock.dup", async () => ({
				output: { kind: "table" as const, ref: "r" },
			})),
		).toThrow(/Duplicate runner/);
	});

	it("built-in runners are present after side-effect import", async () => {
		await import("../../../src/agent/executor/runners/index.js");
		const ids = listRunners();
		expect(ids).toContain("sql");
		expect(ids).toContain("geometry.buffer");
		expect(ids).toContain("joins.spatial_join");
		expect(ids).toContain("stats.aggregate");
		expect(ids).toContain("render.summary");
		expect(ids).toContain("render.map");
		expect(ids).toContain("render.chart");
		expect(ids).toContain("render.table");
	});
});
