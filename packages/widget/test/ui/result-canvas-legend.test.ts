// @vitest-environment happy-dom
/**
 * 2026-05-21 — verifies the legend actually renders in the result-canvas
 * DOM. The unit tests in mapview-legend.test.ts prove `computeLegend`
 * returns the right data; this test proves the data shows up as swatches
 * and counts in the rendered card (and the warning surfaces for
 * degenerate breakdowns).
 *
 * Note: the <gcb-map> child is left unmounted in this DOM (WebGL fails
 * in happy-dom) — we only assert against the legend panel, which is a
 * sibling of <gcb-map> inside the card.
 */

import { describe, expect, it } from "vitest";
import "../../src/ui/result-canvas.js";
import type { ResultPayload } from "../../src/agent/executor/types.js";

interface CanvasEl extends HTMLElement {
	updateComplete: Promise<unknown>;
	setResult(p: ResultPayload | unknown): void;
}

function mount(): CanvasEl {
	const el = document.createElement("result-canvas") as unknown as CanvasEl;
	document.body.appendChild(el);
	return el;
}

function pt(coord: [number, number], props: Record<string, unknown>) {
	return {
		type: "Feature" as const,
		properties: props,
		geometry: { type: "Point" as const, coordinates: coord },
	};
}

describe("result-canvas legend rendering (2026-05-21)", () => {
	it("renders categorical swatches + labels + counts for a 6-bucket layer", async () => {
		const el = mount();
		// 60 points distributed across 6 buckets — the healthy case.
		const features = Array.from({ length: 60 }, (_, i) =>
			pt([0, 0], { contact_status: `bucket_${i % 6}` }),
		);
		el.setResult({
			kind: "layer",
			name: "survey",
			geojson: { type: "FeatureCollection", features },
			style: { colorBy: "contact_status" },
		});
		await el.updateComplete;
		const panel = el.shadowRoot?.querySelector(".map-legend-panel");
		expect(panel).toBeTruthy();
		const items = panel?.querySelectorAll(".map-legend-item");
		expect(items?.length).toBe(6); // one per bucket
		// Each item carries a swatch with an rgba background.
		const firstSwatch = items?.[0]?.querySelector(
			".map-legend-swatch",
		) as HTMLElement | null;
		expect(firstSwatch?.style.background).toMatch(/^rgba\(/);
		// Counts must be shown so the user sees how the breakdown distributes.
		const firstCount = items?.[0]
			?.querySelector(".map-legend-count")
			?.textContent?.trim();
		expect(firstCount).toBe("(10)");
		// No warning on a healthy breakdown.
		expect(panel?.querySelector(".map-legend-warning")).toBeFalsy();
	});

	it("renders the deterministic warning when the colorBy column collapses to 2 categories on a 30+ feature dataset", async () => {
		const el = mount();
		const features = [
			...Array(20)
				.fill(0)
				.map(() => pt([0, 0], { status: "completed" })),
			...Array(15)
				.fill(0)
				.map(() => pt([0, 0], { status: "not_completed" })),
		];
		el.setResult({
			kind: "layer",
			name: "survey",
			geojson: { type: "FeatureCollection", features },
			style: { colorBy: "status" },
		});
		await el.updateComplete;
		const warn = el.shadowRoot?.querySelector(".map-legend-warning");
		expect(warn).toBeTruthy();
		expect(warn?.textContent?.toLowerCase()).toMatch(
			/distinct value|too coarse/,
		);
	});

	it("renders a gradient bar with min/max ticks for a numeric quantile layer", async () => {
		const el = mount();
		const features = Array.from({ length: 50 }, (_, i) =>
			pt([0, 0], { pop: i * 100 }),
		);
		el.setResult({
			kind: "layer",
			name: "tracts",
			geojson: { type: "FeatureCollection", features },
			style: { colorBy: "pop", classification: "quantile" },
		});
		await el.updateComplete;
		const bar = el.shadowRoot?.querySelector(".map-legend-gradient-bar");
		expect(bar).toBeTruthy();
		const bg = (bar as HTMLElement | null)?.style.background ?? "";
		expect(bg).toMatch(/linear-gradient/);
		const ticks = el.shadowRoot?.querySelectorAll(".map-legend-gradient-tick");
		expect(ticks?.length).toBe(2);
		// First tick = min (0), last tick = max (4900 → may render as "4.9K").
		expect(ticks?.[0]?.textContent?.trim()).toMatch(/^0/);
		expect(ticks?.[1]?.textContent?.replace(/[,\s]/g, "")).toMatch(
			/4900$|4\.9K$/,
		);
	});

	it("hides the legend panel entirely when colorBy is unset", async () => {
		const el = mount();
		el.setResult({
			kind: "layer",
			name: "raw",
			geojson: {
				type: "FeatureCollection",
				features: [pt([0, 0], { id: 1 })],
			},
		});
		await el.updateComplete;
		expect(el.shadowRoot?.querySelector(".map-legend-panel")).toBeFalsy();
	});
});
