// packages/widget/src/agent/profile/augment.ts
import type { DatasetProfile } from "../prompts/builders.js";
import { type RegionColumn, inferRegion } from "./region.js";
import { detectRole } from "./roles.js";

export function augmentProfile(profile: DatasetProfile): DatasetProfile {
	const ratio = (card?: number) =>
		profile.rows > 0 && card != null ? Math.min(1, card / profile.rows) : 0;

	const columns = profile.columns.map((c) => {
		const { role, needsBucketing } = detectRole({
			name: c.name,
			type: c.type,
			distinctRatio: ratio(c.cardinality),
			nonNullCount: profile.rows - (c.nulls ?? 0),
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
