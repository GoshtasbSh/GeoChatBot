import { type GeoJsonInputLayer, computeLegend } from "../../ui/MapView.js";

export interface GuardResult {
	ok: boolean;
	severity: "ok" | "warn" | "fail";
	reason: string;
	suggestedFix?: string;
}
const ok = (reason = "ok"): GuardResult => ({
	ok: true,
	severity: "ok",
	reason,
});

const GEOCODE_MIN_RATE = 0.3;

export function guardGeocode(x: {
	matched: number;
	attempted: number;
}): GuardResult {
	if (x.attempted === 0)
		return { ok: false, severity: "fail", reason: "no addresses attempted" };
	const rate = x.matched / x.attempted;
	if (rate < GEOCODE_MIN_RATE)
		return {
			ok: false,
			severity: "fail",
			reason: `geocode resolved ${x.matched}/${x.attempted} (${Math.round(rate * 100)}%)`,
			suggestedFix:
				"addresses may be street-only — add/derive a city/state column or set a region; if inputs look valid this may be an infra/proxy failure",
		};
	return ok(`geocode resolved ${Math.round(rate * 100)}%`);
}

export function guardLayerNonEmpty(featureCount: number): GuardResult {
	if (featureCount === 0)
		return {
			ok: false,
			severity: "fail",
			reason: "layer has 0 features",
			// Empty result is most often a literal/casing mismatch in a WHERE
			// clause (NL2SQL's dominant failure). Re-probe the actual distinct
			// values and match case-insensitively before relaxing/join-checking.
			suggestedFix:
				"the filter/join produced no rows — the most likely cause is a wrong filter literal or casing (e.g. WHERE category='Grocery' when the data stores 'grocery_store'). Re-check the column's actual distinct values and use case-insensitive matching (LOWER(col) LIKE '%...%' or ILIKE), then relax the criteria or verify the join keys",
		};
	return ok(`${featureCount} features`);
}

export function guardColorBy(
	features: ReadonlyArray<GeoJSON.Feature>,
	style: GeoJsonInputLayer["style"],
): GuardResult {
	const spec = computeLegend(features, style);
	if (spec.kind === "none") return ok("no colorBy");
	const distinct = new Set(spec.entries.map((e) => e.swatch.join(","))).size;
	if (spec.warning || distinct < 2)
		return {
			ok: false,
			severity: "fail",
			reason: spec.warning ?? `only ${distinct} distinct color(s)`,
			suggestedFix:
				"bucketize the free-text column into a few clean categories before color-by, or pick a different column",
		};
	return ok(`${distinct} distinct colors`);
}
