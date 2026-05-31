import { describe, expect, it } from "vitest";
import {
	guardColorBy,
	guardGeocode,
	guardLayerNonEmpty,
} from "../../../src/agent/verify/outcome-guards.js";

const pt = (status: string) => ({
	type: "Feature",
	properties: { status },
	geometry: { type: "Point", coordinates: [0, 0] },
});

describe("outcome guards", () => {
	it("fails geocode when match-rate < 30%", () => {
		expect(guardGeocode({ matched: 5, attempted: 100 }).severity).toBe("fail");
		expect(guardGeocode({ matched: 80, attempted: 100 }).severity).toBe("ok");
	});
	it("fails an empty layer", () => {
		expect(guardLayerNonEmpty(0).severity).toBe("fail");
		expect(guardLayerNonEmpty(42).severity).toBe("ok");
	});
	it("fails a degenerate single-color map and passes a multi-color one", () => {
		const oneColor = Array.from({ length: 30 }, () => pt("completed"));
		expect(
			guardColorBy(oneColor as unknown as GeoJSON.Feature[], {
				colorBy: "status",
			}).severity,
		).toBe("fail");
		const six = ["a", "b", "c", "d", "e", "f"].flatMap((s) =>
			Array.from({ length: 5 }, () => pt(s)),
		);
		expect(
			guardColorBy(six as unknown as GeoJSON.Feature[], { colorBy: "status" })
				.severity,
		).toBe("ok");
	});
});
