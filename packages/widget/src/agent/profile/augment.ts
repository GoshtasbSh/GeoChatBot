// packages/widget/src/agent/profile/augment.ts
import type { DatasetProfile } from "../prompts/builders.js";
import { type RegionColumn, inferRegion } from "./region.js";
import { detectRole } from "./roles.js";

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
		return { ...c, role, needsBucketing };
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
