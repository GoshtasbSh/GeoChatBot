/**
 * Mini-gazetteer loader (audit R.4-c).
 *
 * A tiny hit-cache of ~110 high-ambiguity place names, used by the
 * geocode runner to skip a Nominatim round-trip when a region_hint
 * resolves locally. Not a replacement for Nominatim — purely a latency
 * and accuracy optimisation for well-known toponyms.
 *
 * Lookup semantics (intentionally conservative):
 *   - Case-insensitive match on `name`, `${name}, ${region}`,
 *     `${name}, ${region}, ${country}`, and any `aliases[]`.
 *   - A bare name (no comma) is treated as canonical ONLY if exactly
 *     one entry in the table carries that name. Multiple matches
 *     (e.g. "Springfield") deliberately return `undefined` so the
 *     caller can ask the user to disambiguate.
 */

import gaz from "./gazetteer-mini.json";

export interface GazEntry {
	name: string;
	region: string;
	country: string;
	lat: number;
	lon: number;
	wikidata_qid?: string;
	aliases?: string[];
}

const ENTRIES: readonly GazEntry[] = gaz as readonly GazEntry[];

/** Build O(1) lookup indices once, at module load. */
const byName = new Map<string, GazEntry[]>();
const byQualified = new Map<string, GazEntry>();
const byAlias = new Map<string, GazEntry>();

for (const entry of ENTRIES) {
	const nameKey = norm(entry.name);
	let bucket = byName.get(nameKey);
	if (!bucket) {
		bucket = [];
		byName.set(nameKey, bucket);
	}
	bucket.push(entry);

	const nrKey = norm(`${entry.name}, ${entry.region}`);
	if (!byQualified.has(nrKey)) byQualified.set(nrKey, entry);
	const nrcKey = norm(`${entry.name}, ${entry.region}, ${entry.country}`);
	if (!byQualified.has(nrcKey)) byQualified.set(nrcKey, entry);
	const ncKey = norm(`${entry.name}, ${entry.country}`);
	if (!byQualified.has(ncKey)) byQualified.set(ncKey, entry);

	if (entry.aliases) {
		for (const alias of entry.aliases) {
			const aKey = norm(alias);
			if (!byAlias.has(aKey)) byAlias.set(aKey, entry);
		}
	}
}

/**
 * Look up a place by name or qualified form.
 *
 * Returns `undefined` for bare ambiguous names (e.g. "Springfield"
 * matches 5 entries). The caller should fall back to Nominatim or
 * prompt the user.
 */
export function lookupPlace(query: string): GazEntry | undefined {
	if (typeof query !== "string") return undefined;
	const q = norm(query);
	if (!q) return undefined;

	// 1. Exact qualified match ("name, region" or "name, region, country").
	const qualified = byQualified.get(q);
	if (qualified) return qualified;

	// 2. Alias match.
	const aliased = byAlias.get(q);
	if (aliased) return aliased;

	// 3. Bare name — only resolve if unambiguous (exactly one entry).
	const bucket = byName.get(q);
	if (bucket && bucket.length === 1) return bucket[0];

	return undefined;
}

/** Read-only view of the full table (for diagnostics and tests). */
export function listGazetteer(): readonly GazEntry[] {
	return ENTRIES;
}

function norm(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.replace(/\s+/g, " ")
		.trim();
}
