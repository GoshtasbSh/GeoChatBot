/**
 * `geocode.address` runtime — geocodes address-like columns to lat/lon
 * points via OpenStreetMap Nominatim. Concatenates one or more columns
 * (street + city + state + zip + ...) so the search has enough context
 * to resolve unambiguously, and optionally biases the search to a
 * single country.
 *
 * Constraints (per Nominatim usage policy):
 *   - rate-limited to 1 request / second
 *   - capped at 100 rows per call to keep total latency bounded
 *   - rows that don't geocode (no result, network error, parse failure)
 *     are dropped from the output rather than failing the whole step.
 *
 * No API key required; works directly from the browser.
 */

import { z } from "zod";
import { lookupPlace } from "../../data/gazetteer.js";
import { registerRunner } from "../runtime.js";
import { materializeView, quoteIdent, resolveTable } from "../sql-helpers.js";
import type { ExecCtx, RunnerResult } from "../types.js";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const RATE_LIMIT_MS = 1100;
// Raised from 100 → 400: Nominatim's public policy is 1 req/s which we
// honour (RATE_LIMIT_MS=1100ms). 400 rows ≈ 7 minutes — acceptable for a
// one-time survey geocode batch. Operator-hosted Nominatim instances have
// no cap. Public Nominatim usage policy: https://operations.osmfoundation.org/policies/nominatim/
const MAX_GEOCODE_ROWS = 400;

const GeocodeArgs = z.object({
	layer: z.unknown(),
	address_cols: z.array(z.string().min(1)).min(1),
	country_code: z.string().length(2).optional(),
	region_hint: z.string().min(1).max(120).optional(),
});

interface GeocodeHit {
	rid: number;
	lon: number;
	lat: number;
}

interface Viewbox {
	lonMin: number;
	latMin: number;
	lonMax: number;
	latMax: number;
}

export async function runGeocodeAddress(
	args: Record<string, unknown>,
	ctx: ExecCtx,
): Promise<RunnerResult> {
	const { layer, address_cols, country_code, region_hint } =
		GeocodeArgs.parse(args);
	const view = resolveTable(layer, ctx);

	// Concatenate address columns with ", " separators, casting NULLs to
	// empty strings so a missing zip or country doesn't produce the literal
	// word "null" in the search query.
	const concatExpr = address_cols
		.map((c) => `COALESCE(CAST(${quoteIdent(c)} AS VARCHAR), '')`)
		.join(` || ', ' || `);

	const at = await ctx.engine.query(
		`SELECT ROW_NUMBER() OVER () AS _gcb_rid, (${concatExpr}) AS _gcb_addr
     FROM ${quoteIdent(view)}
     LIMIT ${MAX_GEOCODE_ROWS}`,
	);
	const rows = at.toArray() as Array<{
		_gcb_rid: number | bigint;
		_gcb_addr: unknown;
	}>;

	if (rows.length === 0) {
		throw new Error(
			`geocode.address: layer "${typeof layer === "string" ? layer : view}" is empty`,
		);
	}

	// Resolve a viewbox from region_hint before the per-row loop.
	// Nominatim rural-coverage improves dramatically when the search is
	// constrained to the correct city/county via viewbox+bounded=1.
	// Evidence: "6116 Harvard Ave, Keystone Heights FL" → 0 results;
	// "6116 Harvard Ave" + viewbox around Keystone Heights → FOUND.
	let viewbox: Viewbox | undefined;
	if (region_hint?.trim()) {
		// R.4-c: try the local mini-gazetteer first to skip a Nominatim hop.
		const cached = lookupPlace(region_hint.trim());
		if (cached) {
			const PAD = 0.3; // ~20 miles — covers any city or county
			viewbox = {
				lonMin: cached.lon - PAD,
				latMin: cached.lat - PAD,
				lonMax: cached.lon + PAD,
				latMax: cached.lat + PAD,
			};
		} else {
			ctx.onSubProgress?.("Locating region…");
			const center = await geocodeOne(region_hint.trim(), country_code, undefined, ctx.signal);
			if (center) {
				const PAD = 0.3; // ~20 miles — covers any city or county
				viewbox = {
					lonMin: center.lon - PAD,
					latMin: center.lat - PAD,
					lonMax: center.lon + PAD,
					latMax: center.lat + PAD,
				};
			}
		}
	}

	const hits: GeocodeHit[] = [];
	let attempts = 0;
	for (let i = 0; i < rows.length; i++) {
		if (ctx.signal?.aborted) {
			const err = new Error("geocode aborted");
			err.name = "AbortError";
			throw err;
		}
		const row = rows[i];
		if (!row) continue;
		const rid = Number(row._gcb_rid);
		let addr = String(row._gcb_addr ?? "")
			.replace(/,\s*,/g, ",")
			.replace(/^\s*,\s*|\s*,\s*$/g, "")
			.trim();
		if (!addr) continue;
		// With a viewbox, send ONLY the street address — the viewbox supplies
		// the geographic context and appending city/state confuses Nominatim's
		// rural-address parser. Without a viewbox, append region_hint.
		if (!viewbox && region_hint?.trim()) {
			addr = `${addr}, ${region_hint.trim()}`;
		}
		attempts++;
		const hit = await geocodeOne(addr, viewbox ? undefined : country_code, viewbox, ctx.signal);
		if (hit) hits.push({ rid, lon: hit.lon, lat: hit.lat });
		if (ctx.onSubProgress && (i % 5 === 0 || i === rows.length - 1)) {
			ctx.onSubProgress(
				`Geocoding address ${i + 1} of ${rows.length} (${hits.length} matched so far)…`,
			);
		}
		if (i < rows.length - 1) await sleep(RATE_LIMIT_MS, ctx.signal);
	}

	if (hits.length === 0) {
		const colList = address_cols.map((c) => `"${c}"`).join(", ");
		throw new Error(
			`geocode.address: 0 of ${attempts} addresses resolved. Address columns tried: ${colList}${region_hint ? ` with region_hint="${region_hint}"` : ""}${country_code ? ` country_code="${country_code}"` : ""}. Likely fixes: (1) include a city/state/zip column in address_cols; (2) set region_hint to the city or state the data is in (e.g. "Cedar Key, FL, USA"); (3) set country_code (e.g. "us"). Single-street-column data without context cannot be geocoded.`,
		);
	}

	// Build a VALUES table of geocoded coordinates and INNER JOIN it back
	// to the original view (only successfully-geocoded rows survive). The
	// geom column is materialised via ST_Point.
	const valuesSql = hits
		.map((h) => `(${h.rid}::BIGINT, ${h.lon}, ${h.lat})`)
		.join(", ");
	const sql = `WITH _src AS (
      SELECT ROW_NUMBER() OVER () AS _gcb_rid, *
      FROM ${quoteIdent(view)}
      LIMIT ${MAX_GEOCODE_ROWS}
    ),
    _geo (_gcb_rid, _gcb_lon, _gcb_lat) AS (VALUES ${valuesSql})
    SELECT _src.* EXCLUDE (_gcb_rid),
           ST_Point(_geo._gcb_lon, _geo._gcb_lat) AS geom
    FROM _src
    JOIN _geo USING (_gcb_rid)`;
	const out = await materializeView(ctx, "geocoded", sql);
	return { output: { kind: "layer", ref: out } };
}

registerRunner("geocode.address", runGeocodeAddress);

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

async function geocodeOne(
	addr: string,
	countryCode: string | undefined,
	viewbox: Viewbox | undefined,
	signal?: AbortSignal,
): Promise<{ lon: number; lat: number } | null> {
	try {
		const params = new URLSearchParams({ format: "json", limit: "1", q: addr });
		if (viewbox) {
			// viewbox=lonMin,latMin,lonMax,latMax + bounded=1 constrains the
			// search to the target city/county. This is what makes Nominatim
			// resolve rural US streets that it misses with free-text queries.
			params.set(
				"viewbox",
				`${viewbox.lonMin},${viewbox.latMin},${viewbox.lonMax},${viewbox.latMax}`,
			);
			params.set("bounded", "1");
			// countrycodes is redundant with a tight viewbox and can suppress
			// results in edge cases (e.g. addresses near a national border)
		} else if (countryCode) {
			params.set("countrycodes", countryCode.toLowerCase());
		}
		const url = `${NOMINATIM_URL}?${params.toString()}`;
		const init: RequestInit = { headers: { Accept: "application/json" } };
		if (signal) init.signal = signal;
		const resp = await fetch(url, init);
		if (!resp.ok) return null;
		const body = (await resp.json()) as Array<{ lat?: string; lon?: string }>;
		const first = body[0];
		if (!first?.lat || !first?.lon) return null;
		const lat = Number.parseFloat(first.lat);
		const lon = Number.parseFloat(first.lon);
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
		return { lat, lon };
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") throw err;
		return null;
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(t);
			const err = new Error("geocode aborted during rate-limit pause");
			err.name = "AbortError";
			reject(err);
		};
		if (signal) {
			if (signal.aborted) {
				clearTimeout(t);
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

