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

	// 1b. Try country-code normalisation: user input "USA" should match
	// the stored "US" key. Also handle "United States", "U.S.A.", etc.
	const qNormCountry = normalizeCountrySuffix(q);
	if (qNormCountry !== q) {
		const requalified = byQualified.get(qNormCountry);
		if (requalified) return requalified;
	}

	// 2. Alias match.
	const aliased = byAlias.get(q);
	if (aliased) return aliased;

	// 3. Bare name — only resolve if unambiguous (exactly one entry).
	const bucket = byName.get(q);
	if (bucket && bucket.length === 1) return bucket[0];

	// 4. Strip the trailing country segment and retry as "name, region".
	// Handles inputs like "Cedar Key, FL, USA" → "cedar key, fl".
	const withoutCountry = stripCountrySuffix(q);
	if (withoutCountry && withoutCountry !== q) {
		const partial = byQualified.get(withoutCountry);
		if (partial) return partial;
		const partialBucket = byName.get(withoutCountry);
		if (partialBucket && partialBucket.length === 1) return partialBucket[0];
	}

	return undefined;
}

const COUNTRY_SYNONYMS: Record<string, string> = {
	usa: "us",
	"u.s.a.": "us",
	"u.s.": "us",
	america: "us",
	"united states": "us",
	"united states of america": "us",
	uk: "gb",
	"u.k.": "gb",
	britain: "gb",
	"great britain": "gb",
	"united kingdom": "gb",
};

function normalizeCountrySuffix(q: string): string {
	const m = q.match(/^(.+),\s*([^,]+)$/);
	if (!m) return q;
	const head = m[1];
	const tail = m[2]?.trim();
	if (!tail) return q;
	const replacement = COUNTRY_SYNONYMS[tail];
	if (!replacement) return q;
	return `${head}, ${replacement}`;
}

function stripCountrySuffix(q: string): string | undefined {
	const m = q.match(/^(.+),\s*([^,]+)$/);
	if (!m) return undefined;
	const head = m[1]?.trim();
	const tail = m[2]?.trim();
	if (!head || !tail) return undefined;
	if (tail.length <= 3 || COUNTRY_SYNONYMS[tail]) return head;
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
