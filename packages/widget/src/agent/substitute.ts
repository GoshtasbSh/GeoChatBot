import type { OutputRef } from "./types.js";

const WHOLE_STRING_VAR = /^\$\{(\w+)\}$/;

/**
 * Resolve `${var}` references inside an args structure to OutputRefs.
 * Only WHOLE-STRING `${var}` references substitute. Partial matches like
 * `"${x}_suffix"` or `"SELECT ${x} FROM t"` are left as literal strings —
 * preventing prompt-injection-via-substitution into SQL.
 *
 * Walks objects and arrays recursively. Does NOT mutate input.
 */
export function substitute(
	value: unknown,
	refs: Map<string, OutputRef>,
): unknown {
	if (typeof value === "string") {
		const m = value.match(WHOLE_STRING_VAR);
		if (!m) return value;
		const name = m[1];
		if (name === undefined) return value;
		return refs.get(name) ?? value;
	}
	if (Array.isArray(value)) {
		return value.map((v) => substitute(v, refs));
	}
	if (value && typeof value === "object") {
		// Object.create(null) so a crafted `__proto__` key in the input cannot
		// mutate this object's prototype. We also skip `__proto__` /
		// `constructor` / `prototype` keys defensively — these are never valid
		// tool args and an LLM that emits them is suspicious.
		const out: Record<string, unknown> = Object.create(null) as Record<
			string,
			unknown
		>;
		for (const [k, v] of Object.entries(value)) {
			if (k === "__proto__" || k === "constructor" || k === "prototype")
				continue;
			out[k] = substitute(v, refs);
		}
		return out;
	}
	return value;
}
