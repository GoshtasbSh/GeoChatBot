// packages/widget/src/agent/profile/region.ts
import { lookupPlace } from "../data/gazetteer.js";
import type { ColumnRole } from "./roles.js";

export interface RegionColumn {
	role: ColumnRole;
	values: string[];
}
export interface InferredRegion {
	label: string;
	lon: number;
	lat: number;
	source: "coords" | "city_state" | "zip" | "none";
}

function mode(values: string[]): string | undefined {
	const counts = new Map<string, number>();
	for (const v of values) {
		const k = String(v ?? "").trim();
		if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
	}
	let best: string | undefined;
	let bestN = 0;
	for (const [k, n] of counts)
		if (n > bestN) {
			best = k;
			bestN = n;
		}
	return best;
}
function mean(values: string[]): number | undefined {
	const nums = values.map((v) => Number(v)).filter((n) => Number.isFinite(n));
	return nums.length
		? nums.reduce((a, b) => a + b, 0) / nums.length
		: undefined;
}

export function inferRegion(cols: RegionColumn[]): InferredRegion | undefined {
	const by = (r: ColumnRole) => cols.find((c) => c.role === r);
	const lat = by("lat");
	const lon = by("lon");
	if (lat && lon) {
		const la = mean(lat.values);
		const lo = mean(lon.values);
		if (la != null && lo != null)
			return {
				label: `${la.toFixed(3)}, ${lo.toFixed(3)}`,
				lat: la,
				lon: lo,
				source: "coords",
			};
	}
	const city = by("city");
	const state = by("state");
	if (city) {
		const c = mode(city.values);
		const s = state ? mode(state.values) : undefined;
		if (c) {
			const label = s ? `${c}, ${s}` : c;
			const hit = lookupPlace(label) ?? lookupPlace(c);
			if (hit)
				return { label, lon: hit.lon, lat: hit.lat, source: "city_state" };
			return { label, lon: Number.NaN, lat: Number.NaN, source: "city_state" };
		}
	}
	return undefined;
}
