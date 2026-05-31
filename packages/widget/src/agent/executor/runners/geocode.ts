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
import type { DatasetProfile } from "../../prompts/builders.js";
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
	address_cols: z.array(z.string().min(1)).optional(),
	country_code: z.string().length(2).optional(),
	region_hint: z.string().min(1).max(120).optional(),
});

export function pickAddressCols(
	profile: Pick<DatasetProfile, "columns">,
): string[] {
	const order = ["address", "city", "state", "zip", "country"];
	return profile.columns
		.filter((c) => c.role && order.includes(c.role))
		.sort(
			(a, b) =>
				order.indexOf(a.role as string) - order.indexOf(b.role as string),
		)
		.map((c) => c.name);
}

export function pickRegionHint(
	profile: Pick<DatasetProfile, "inferredRegion">,
): string | undefined {
	return profile.inferredRegion?.label;
}

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

	// Auto-fill address_cols and region_hint from the active dataset profile
	// when the planner didn't specify them. Explicit args always take priority.
	const profile = ctx.activeProfile;
	const effectiveAddressCols =
		address_cols && address_cols.length > 0
			? address_cols
			: profile
				? pickAddressCols(profile)
				: [];
	if (effectiveAddressCols.length === 0)
		throw new Error(
			"geocode.address: no address columns given and none could be inferred from the dataset profile (need a column with role 'address').",
		);
	const effectiveRegionHint =
		region_hint ?? (profile ? pickRegionHint(profile) : undefined);

	// Concatenate address columns with ", " separators, casting NULLs to
	// empty strings so a missing zip or country doesn't produce the literal
	// word "null" in the search query.
	const concatExpr = effectiveAddressCols
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

	// Resolve a viewbox from effectiveRegionHint before the per-row loop.
	// Nominatim rural-coverage improves dramatically when the search is
	// constrained to the correct city/county via viewbox+bounded=1.
	// Evidence: "6116 Harvard Ave, Keystone Heights FL" → 0 results;
	// "6116 Harvard Ave" + viewbox around Keystone Heights → FOUND.
	let viewbox: Viewbox | undefined;
	if (effectiveRegionHint?.trim()) {
		// R.4-c: try the local mini-gazetteer first to skip a Nominatim hop.
		const cached = lookupPlace(effectiveRegionHint.trim());
		if (cached) {
			const PAD = 0.08;
			// Tightened from 0.3° (~20 mi) → 0.08° (~5 mi). The wider box
			// caused mainland-county street centroids to match small-island
			// queries (CRITICAL-03: Cedar Key addresses resolved to inland
			// Levy County locations 7-21 mi away). 0.08° still covers small
			// US cities and rural ZIPs in a single hit; queries for larger
			// metros should pass region_hint at the city level.
			viewbox = {
				lonMin: cached.lon - PAD,
				latMin: cached.lat - PAD,
				lonMax: cached.lon + PAD,
				latMax: cached.lat + PAD,
			};
		} else {
			ctx.onSubProgress?.("Locating region…");
			const center = await geocodeOne(
				effectiveRegionHint.trim(),
				country_code,
				undefined,
				ctx.signal,
			);
			if (center) {
				const PAD = 0.08;
				// Tightened from 0.3° (~20 mi) → 0.08° (~5 mi). The wider box
				// caused mainland-county street centroids to match small-island
				// queries (CRITICAL-03: Cedar Key addresses resolved to inland
				// Levy County locations 7-21 mi away). 0.08° still covers small
				// US cities and rural ZIPs in a single hit; queries for larger
				// metros should pass region_hint at the city level.
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

	// Stage 1 — Census Bureau geocoder (parallel, US-only).
	//
	// Census TIGER/Line has comprehensive coverage of US street addresses
	// including small towns where Nominatim/OSM lacks data (e.g. Keystone
	// Heights, FL had ~95% of audit-CSV addresses indexed by Census but
	// 0% in OSM). We try Census FIRST when country_code is "us" (or no
	// country_code is set), and only fall back to Nominatim for the rows
	// that don't match. Census supports parallel requests (no documented
	// rate limit) and resolves ~5x faster than 1 req/s Nominatim.
	const isUS = !country_code || country_code.toLowerCase() === "us";
	const censusUnmatched: Array<{ rid: number; addr: string }> = [];
	if (isUS) {
		const candidates: Array<{ rid: number; addr: string }> = [];
		for (const row of rows) {
			if (!row) continue;
			const rid = Number(row._gcb_rid);
			const baseAddr = String(row._gcb_addr ?? "")
				.replace(/,\s*,/g, ",")
				.replace(/^\s*,\s*|\s*,\s*$/g, "")
				.trim();
			if (!baseAddr) continue;
			// Always append effectiveRegionHint when calling Census — Census's
			// TIGER lookup wants city+state+ZIP context. The viewbox is
			// only for Nominatim.
			const addr = effectiveRegionHint?.trim()
				? `${baseAddr}, ${effectiveRegionHint.trim()}`
				: baseAddr;
			candidates.push({ rid, addr });
		}
		attempts += candidates.length;
		const CENSUS_PARALLEL = 6;
		for (let i = 0; i < candidates.length; i += CENSUS_PARALLEL) {
			if (ctx.signal?.aborted) {
				const err = new Error("geocode aborted");
				err.name = "AbortError";
				throw err;
			}
			const chunk = candidates.slice(i, i + CENSUS_PARALLEL);
			const results = await Promise.all(
				chunk.map((c) => censusOne(c.addr, ctx.signal)),
			);
			for (let j = 0; j < chunk.length; j++) {
				const c = chunk[j];
				const r = results[j];
				if (!c) continue;
				if (r) {
					hits.push({ rid: c.rid, lon: r.lon, lat: r.lat });
				} else {
					censusUnmatched.push(c);
				}
			}
			if (ctx.onSubProgress) {
				const done = Math.min(i + CENSUS_PARALLEL, candidates.length);
				ctx.onSubProgress(
					`Census geocode ${done} of ${candidates.length} (${hits.length} matched)…`,
				);
			}
		}
	}

	// Stage 2 — Nominatim fallback for rows Census couldn't match (or
	// non-US datasets). Uses the original 1 req/s, viewbox-bounded path.
	const fallbackRows = isUS
		? censusUnmatched
		: rows
				.filter((r): r is { _gcb_rid: number | bigint; _gcb_addr: unknown } =>
					Boolean(r),
				)
				.map((row) => {
					const baseAddr = String(row._gcb_addr ?? "")
						.replace(/,\s*,/g, ",")
						.replace(/^\s*,\s*|\s*,\s*$/g, "")
						.trim();
					return { rid: Number(row._gcb_rid), addr: baseAddr };
				})
				.filter((c) => c.addr.length > 0);
	if (!isUS) attempts += fallbackRows.length;

	for (let i = 0; i < fallbackRows.length; i++) {
		if (ctx.signal?.aborted) {
			const err = new Error("geocode aborted");
			err.name = "AbortError";
			throw err;
		}
		const c = fallbackRows[i];
		if (!c) continue;
		let addr = c.addr;
		if (!viewbox && effectiveRegionHint?.trim()) {
			addr = `${addr}, ${effectiveRegionHint.trim()}`;
		}
		const hit = await geocodeOne(
			addr,
			viewbox ? undefined : country_code,
			viewbox,
			ctx.signal,
		);
		if (hit) hits.push({ rid: c.rid, lon: hit.lon, lat: hit.lat });
		if (ctx.onSubProgress && (i % 5 === 0 || i === fallbackRows.length - 1)) {
			ctx.onSubProgress(
				`Nominatim fallback ${i + 1} of ${fallbackRows.length} (${hits.length} total matched)…`,
			);
		}
		if (i < fallbackRows.length - 1) await sleep(RATE_LIMIT_MS, ctx.signal);
	}

	if (hits.length === 0) {
		const colList = effectiveAddressCols.map((c) => `"${c}"`).join(", ");
		throw new Error(
			`geocode.address: 0 of ${attempts} addresses resolved. Address columns tried: ${colList}${effectiveRegionHint ? ` with region_hint="${effectiveRegionHint}"` : ""}${country_code ? ` country_code="${country_code}"` : ""}. Likely fixes: (1) include a city/state/zip column in address_cols; (2) set region_hint to the city or state the data is in (e.g. "Cedar Key, FL, USA"); (3) set country_code (e.g. "us"). Single-street-column data without context cannot be geocoded.`,
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

/**
 * Census Bureau geocoder for US street addresses. TIGER/Line has
 * comprehensive coverage including small towns where OSM lacks data.
 * No API key required, supports CORS, parallel-safe.
 *
 * Returns null on no match, network error, or non-200 response. Aborts
 * propagate via the signal.
 */
/**
 * Census endpoint. The U.S. Census Bureau API does NOT emit
 * Access-Control-Allow-Origin, so direct browser calls are blocked by
 * CORS. We default to a same-origin path (`/api/census-geocode/...`)
 * so a dev Vite proxy or production reverse-proxy can forward the
 * request server-side. Hosts that don't proxy can override at build
 * time via `__GEOCHATBOT_CENSUS_URL__` (define) or by setting
 * `window.__GEOCHATBOT_CENSUS_URL__` before the widget loads.
 */
const CENSUS_URL_DEFAULT = "/api/census-geocode/locations/onelineaddress";
function getCensusUrl(): string {
	const w = (globalThis as { __GEOCHATBOT_CENSUS_URL__?: string })
		.__GEOCHATBOT_CENSUS_URL__;
	if (typeof w === "string" && w.length > 0) return w;
	return CENSUS_URL_DEFAULT;
}

async function censusOne(
	addr: string,
	signal?: AbortSignal,
): Promise<{ lon: number; lat: number } | null> {
	try {
		const params = new URLSearchParams({
			address: addr,
			benchmark: "Public_AR_Current",
			format: "json",
		});
		const url = `${getCensusUrl()}?${params.toString()}`;
		const init: RequestInit = { headers: { Accept: "application/json" } };
		if (signal) init.signal = signal;
		const resp = await fetch(url, init);
		if (!resp.ok) return null;
		const body = (await resp.json()) as {
			result?: {
				addressMatches?: Array<{
					coordinates?: { x?: number; y?: number };
				}>;
			};
		};
		const first = body.result?.addressMatches?.[0];
		const x = first?.coordinates?.x;
		const y = first?.coordinates?.y;
		if (typeof x !== "number" || typeof y !== "number") return null;
		if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
		return { lon: x, lat: y };
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
