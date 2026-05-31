// packages/widget/src/agent/profile/augment.ts
import type { DatasetProfile } from "../prompts/builders.js";
import { detectColumnFlags } from "./column-flags.js";
import { type RegionColumn, inferRegion } from "./region.js";
import { detectRole } from "./roles.js";

/** Below this cardinality we surface the COMPLETE distinct value set. */
const ENUM_CAP = 12;

export function augmentProfile(profile: DatasetProfile): DatasetProfile {
	const columns = profile.columns.map((c) => {
		// distinctRatio = distinct / nonNull (NOT / total rows), per RoleInput's
		// contract — a column that is mostly null but unique among the values
		// that ARE present is still high-cardinality.
		const nonNullCount = Math.max(0, profile.rows - (c.nulls ?? 0));
		const distinctRatio =
			nonNullCount > 0 && c.cardinality != null
				? Math.min(1, c.cardinality / nonNullCount)
				: 0;
		const { role, needsBucketing } = detectRole({
			name: c.name,
			type: c.type,
			distinctRatio,
			nonNullCount,
			samples: (c.samples ?? []).map((s) => String(s)),
		});
		// Quality flags: constant / categorical-code (prevents one-colour maps
		// and averaging a code column).
		const { constant, categoricalNumeric } = detectColumnFlags({
			type: c.type,
			...(c.cardinality !== undefined ? { cardinality: c.cardinality } : {}),
			nonNullCount,
		});
		// Value-completeness: when a low-cardinality column's samples already
		// cover every distinct value, mark them complete so the planner can
		// filter with exact `=` (and the model copies the real literal/casing
		// instead of guessing). NL2SQL's single biggest accuracy-per-line win.
		const valuesComplete =
			c.cardinality !== undefined &&
			c.cardinality <= ENUM_CAP &&
			(c.samples?.length ?? 0) >= c.cardinality;
		return {
			...c,
			role,
			needsBucketing,
			constant,
			categoricalNumeric,
			...(valuesComplete ? { valuesComplete: true } : {}),
		};
	});

	const regionCols: RegionColumn[] = columns
		.filter((c) => c.role)
		.map((c) => ({
			role: c.role as RegionColumn["role"],
			values: (c.samples ?? []).map((s) => String(s)),
		}));
	const inferredRegion = inferRegion(regionCols);

	return { ...profile, columns, ...(inferredRegion ? { inferredRegion } : {}) };
}
