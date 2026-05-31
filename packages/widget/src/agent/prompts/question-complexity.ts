/**
 * Question complexity classifier for reasoning-effort gating.
 *
 * Pinning reasoning_effort to "high" hurts SIMPLE tasks — overthinking,
 * fixation, and output regressions on lookups — and costs latency (OpenAI
 * reasoning guidance; 2025 overthinking literature). We reserve high effort
 * for genuinely multi-step / analytical / spatial-reasoning questions and use
 * medium for straightforward lookups.
 *
 * Cheap, deterministic, no model call. Biased toward "simple" — only escalate
 * when the question clearly needs multi-step reasoning, so the common fast
 * path stays fast.
 */

export type QuestionComplexity = "simple" | "complex";

// Analytical / multi-step / spatial-reasoning cues. Presence of any → complex.
const COMPLEX_CUES =
	/\b(compare|correlat\w*|cluster\w*|spread out|hot[- ]?spot\w*|autocorrelat\w*|moran|trend|over time|relationship|distribut\w*|underperform\w*|pattern\w*|nearest|density|within \d|buffer|why|reason|explain|spatial|concentrat\w*|outlier\w*|anomal\w*|forecast|predict|segment\w*|profile of|where should|should .*(focus|prioriti|target)|recommend|prioriti\w*)\b/i;

// Comparative-over-space phrasing: "worse/better/higher … in any/particular area".
const SPATIAL_COMPARISON =
	/\b(worse|better|higher|lower|more|less|most|least)\b.*\b(area|region|place|neighborhood|zone|part|location|where)\b|\b(any particular|particular|certain|specific)\b.*\b(area|region|place|zone|part)\b/i;

// "X, and which … above/below …" style multi-step comparative questions.
const MULTI_STEP =
	/\b(and which|then|after that|as well as|broken down by|grouped by|relative to|compared to)\b|,.*\bwhich\b.*\b(above|below|more|less|higher|lower)\b/i;

/**
 * Classify a question as "simple" (single-step lookup/map/aggregate) or
 * "complex" (multi-step, analytical, or spatial reasoning). Defaults to
 * "simple" so the fast path is the default.
 */
export function classifyQuestionComplexity(
	question: string,
): QuestionComplexity {
	const q = question.trim();
	if (q === "") return "simple";
	if (COMPLEX_CUES.test(q) || MULTI_STEP.test(q) || SPATIAL_COMPARISON.test(q))
		return "complex";
	return "simple";
}
