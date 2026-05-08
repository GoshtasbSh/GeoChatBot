import type { OutputRef } from './types.js';

const WHOLE_STRING_VAR = /^\$\{(\w+)\}$/;

/**
 * Resolve `${var}` references inside an args structure to OutputRefs.
 * Only WHOLE-STRING `${var}` references substitute. Partial matches like
 * `"${x}_suffix"` or `"SELECT ${x} FROM t"` are left as literal strings —
 * preventing prompt-injection-via-substitution into SQL.
 *
 * Walks objects and arrays recursively. Does NOT mutate input.
 */
export function substitute(value: unknown, refs: Map<string, OutputRef>): unknown {
  if (typeof value === 'string') {
    const m = value.match(WHOLE_STRING_VAR);
    if (!m) return value;
    return refs.get(m[1]!) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => substitute(v, refs));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, refs);
    return out;
  }
  return value;
}
