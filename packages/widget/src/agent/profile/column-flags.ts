/**
 * Column quality flags surfaced to the planner to prevent two cheap, common
 * EDA mistakes (research: LLM data-science-agent survey; PV-SQL):
 *
 *  - CONSTANT column (1 distinct value) → must not be a color/group key, or
 *    the map is one colour / the chart is one bucket.
 *  - CATEGORICAL CODE stored as a number (few distinct values over many rows,
 *    e.g. 0/1 flags, FIPS codes, zip-as-int) → must not be averaged/summed as
 *    if it were a continuous measure.
 *
 * Pure, deterministic, derived from stats the profiler already computes.
 */

export interface ColumnFlagInput {
	type: string;
	cardinality?: number;
	nonNullCount: number;
}

export interface ColumnFlags {
	constant: boolean;
	categoricalNumeric: boolean;
}

const NUMERIC_TYPE =
	/\b(int|integer|bigint|smallint|tinyint|double|float|real|decimal|numeric|number)\b/i;

// A numeric column is "really categorical" when it has few distinct values
// AND enough rows that the low distinct count is meaningful (not just a tiny
// dataset). Thresholds chosen conservatively to avoid flagging genuine
// small-range measures.
const CAT_NUM_MAX_DISTINCT = 12;
const CAT_NUM_MIN_ROWS = 30;
const CAT_NUM_RATIO = 0.2; // distinct / rows must be below this

export function detectColumnFlags(input: ColumnFlagInput): ColumnFlags {
	const { type, cardinality, nonNullCount } = input;
	if (cardinality === undefined) {
		return { constant: false, categoricalNumeric: false };
	}
	const constant = nonNullCount > 0 && cardinality <= 1;

	const isNumeric = NUMERIC_TYPE.test(type);
	const categoricalNumeric =
		isNumeric &&
		!constant &&
		nonNullCount >= CAT_NUM_MIN_ROWS &&
		cardinality <= CAT_NUM_MAX_DISTINCT &&
		cardinality / nonNullCount < CAT_NUM_RATIO;

	return { constant, categoricalNumeric };
}
