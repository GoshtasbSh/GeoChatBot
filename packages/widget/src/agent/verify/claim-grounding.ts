/**
 * Deterministic claim-grounding checker.
 *
 * The 2026-05-31 deep review's #1 correctness failure was a render.summary
 * whose superlative claim CONTRADICTED the table the same plan computed
 * (D9-Q3: table shows Middle=7.4 is highest, summary says "Elementary is
 * highest"). Because we OWN the computed table, argmax/argmin is ground
 * truth — so we can catch the contradiction with pure code, no LLM, in
 * <1ms. This is far more reliable than an LLM-as-judge on this claim class.
 *
 * Precision over recall: we only fire when the summary explicitly names a
 * KNOWN table row label as the superlative subject and that label is the
 * wrong one. Unverifiable claims (subject not in the table, no numeric
 * column to rank by, no superlative word) pass through untouched so we
 * never block a correct answer.
 */

import type { GuardResult } from "./outcome-guards.js";

export interface GroundingInput {
	summary: string;
	rows: ReadonlyArray<Record<string, unknown>>;
	columns: ReadonlyArray<string>;
}

const MAX_WORDS =
	/\b(highest|greatest|largest|most|top|maximum|max|best|biggest|leading)\b/i;
const MIN_WORDS =
	/\b(lowest|least|smallest|fewest|minimum|min|worst|bottom)\b/i;

const ok = (reason = "ok"): GuardResult => ({
	ok: true,
	severity: "ok",
	reason,
});

/** Coerce a cell to a finite number, or null if it isn't numeric. */
function asNumber(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "bigint") return Number(v);
	if (typeof v === "string") {
		// strip commas / currency / % so "15,126,000" and "11%" parse
		const cleaned = v.replace(/[$,%\s]/g, "");
		if (cleaned === "") return null;
		const n = Number(cleaned);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

/** Columns whose values are (mostly) numeric → rankable metrics. */
function numericColumns(input: GroundingInput): string[] {
	return input.columns.filter((c) => {
		let numeric = 0;
		let total = 0;
		for (const r of input.rows) {
			if (r[c] === null || r[c] === undefined) continue;
			total++;
			if (asNumber(r[c]) !== null) numeric++;
		}
		return total > 0 && numeric / total >= 0.8;
	});
}

/** Columns that are non-numeric text → candidate entity labels. */
function labelColumns(input: GroundingInput, numeric: string[]): string[] {
	const num = new Set(numeric);
	return input.columns.filter((c) => !num.has(c));
}

/** Split summary into rough sentences for windowed claim attribution. */
function sentences(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+|\n+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

function includesWord(haystack: string, needle: string): boolean {
	// word-ish containment, case-insensitive; tolerant of surrounding punctuation
	return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Check every superlative sentence in the summary against the table.
 * Returns a failing GuardResult on the first verifiable contradiction.
 */
export function checkClaimGrounding(input: GroundingInput): GuardResult {
	if (input.rows.length === 0) return ok("empty table — nothing to verify");

	const metrics = numericColumns(input);
	if (metrics.length === 0) return ok("no numeric column to rank by");
	const labels = labelColumns(input, metrics);
	if (labels.length === 0) return ok("no label column to attribute claims to");

	// All distinct label values across label columns, with their row.
	const labelToRow = new Map<string, Record<string, unknown>>();
	for (const r of input.rows) {
		for (const lc of labels) {
			const v = r[lc];
			if (typeof v === "string" && v.trim() !== "") {
				labelToRow.set(v, r);
			}
		}
	}
	if (labelToRow.size === 0) return ok("no usable string labels");

	for (const sentence of sentences(input.summary)) {
		const isMax = MAX_WORDS.test(sentence);
		const isMin = MIN_WORDS.test(sentence);
		if (!isMax && !isMin) continue;

		// Which known labels does this sentence name?
		const named = [...labelToRow.keys()].filter((lbl) =>
			includesWord(sentence, lbl),
		);
		if (named.length === 0) continue; // can't attribute → skip (no false positive)

		// For each metric, who is the true winner in this direction?
		for (const metric of metrics) {
			const ranked = input.rows
				.map((r) => ({ row: r, n: asNumber(r[metric]) }))
				.filter(
					(x): x is { row: Record<string, unknown>; n: number } => x.n !== null,
				);
			if (ranked.length === 0) continue;

			const winner = ranked.reduce((acc, x) =>
				isMin ? (x.n < acc.n ? x : acc) : x.n > acc.n ? x : acc,
			);
			const winnerLabel = labels
				.map((lc) => winner.row[lc])
				.find((v): v is string => typeof v === "string" && v.trim() !== "");
			if (!winnerLabel) continue;

			// Does the sentence name a DIFFERENT known label as the superlative?
			const wrongNamed = named.find((n) => n !== winnerLabel);
			// Only flag if the sentence does NOT also name the true winner —
			// avoids "Middle beats Elementary; Middle is highest" false trips.
			if (wrongNamed && !named.includes(winnerLabel)) {
				return {
					ok: false,
					severity: "fail",
					reason: `summary claims "${wrongNamed}" is the ${isMin ? "lowest" : "highest"} for ${metric}, but the table shows "${winnerLabel}" (${winner.n}) is`,
					suggestedFix:
						"rewrite the summary so its superlative/comparison claims match the computed table exactly — read the winning row from the data, do not infer from prior knowledge",
				};
			}

			// Right entity, but does the sentence assert a wrong value for it?
			if (named.includes(winnerLabel)) {
				const claimedNums = (sentence.match(/-?\d+(?:[.,]\d+)?/g) ?? [])
					.map((s) => asNumber(s))
					.filter((n): n is number => n !== null);
				if (claimedNums.length > 0) {
					const cell = winner.n;
					const matches = claimedNums.some(
						(c) =>
							Math.abs(c - cell) < 0.05 ||
							// tolerate rounding to the cell's displayed precision
							Math.round(c) === Math.round(cell) ||
							c.toFixed(1) === cell.toFixed(1),
					);
					if (!matches) {
						return {
							ok: false,
							severity: "fail",
							reason: `summary states a value for "${winnerLabel}" that does not match the table cell (${cell}) for ${metric}`,
							suggestedFix:
								"use the exact numbers from the computed table in the summary; do not paraphrase or round away the real value",
						};
					}
				}
			}
		}
	}

	return ok("summary claims are consistent with the table");
}
