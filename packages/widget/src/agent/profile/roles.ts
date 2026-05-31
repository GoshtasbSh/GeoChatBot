// packages/widget/src/agent/profile/roles.ts
export type ColumnRole =
	| "address"
	| "city"
	| "state"
	| "zip"
	| "country"
	| "lat"
	| "lon"
	| "geometry"
	| "category"
	| "free_text_category"
	| "temporal"
	| "measure"
	| "id"
	| "unknown";

export interface RoleInput {
	name: string;
	type: "string" | "number" | "boolean" | "date" | "geometry" | string;
	distinctRatio: number; // distinctCount / nonNullCount, 0..1
	nonNullCount: number;
	samples: string[];
}
export interface RoleResult {
	role: ColumnRole;
	needsBucketing: boolean;
}

const STREET_RE = /^\s*\d+\s+\S+/;
const ZIP_RE = /^\d{5}(-\d{4})?$/;
const STATE_RE = /^[A-Z]{2}$/;

function frac(samples: string[], re: RegExp): number {
	const s = samples.filter((v) => v != null && String(v).length > 0);
	if (s.length === 0) return 0;
	return s.filter((v) => re.test(String(v))).length / s.length;
}

export function detectRole(c: RoleInput): RoleResult {
	const n = c.name.toLowerCase();
	const wrap = (role: ColumnRole): RoleResult => ({
		role,
		needsBucketing: role === "free_text_category",
	});

	if (c.type === "geometry") return wrap("geometry");
	if (/(^|[_\s-])(lat|latitude)([_\s-]|$)/.test(n)) return wrap("lat");
	if (/(^|[_\s-])(lon|lng|long|longitude)([_\s-]|$)/.test(n))
		return wrap("lon");
	if (/\bzip\b|postal/.test(n) || frac(c.samples, ZIP_RE) >= 0.6)
		return wrap("zip");
	if (/\bstate\b/.test(n) || frac(c.samples, STATE_RE) >= 0.6)
		return wrap("state");
	if (/\bcity\b|\btown\b/.test(n)) return wrap("city");
	if (/\bcountry\b/.test(n)) return wrap("country");
	if (
		/address|addr|street|location/.test(n) &&
		frac(c.samples, STREET_RE) >= 0.3
	)
		return wrap("address");
	if (frac(c.samples, STREET_RE) >= 0.6) return wrap("address");
	if (c.type === "date") return wrap("temporal");
	if (/(^|[_\s-])id$/.test(n) && c.distinctRatio >= 0.9) return wrap("id");
	if (c.type === "number") return wrap("measure");
	if (c.type === "string")
		return wrap(c.distinctRatio <= 0.5 ? "category" : "free_text_category");
	return wrap("unknown");
}
