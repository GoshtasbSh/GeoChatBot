/**
 * Tool IDs that exist in the catalog history but are NOT implemented in
 * Phase 5 v1 (their runners throw "not implemented"). They are:
 *   1. HIDDEN from the planner's tool catalog (see prompts/builders.ts) so a
 *      weak model cannot pick a guaranteed dead-end (e.g. answering "where is
 *      crime worst?" with an unimplemented hotspot/density tool); and
 *   2. registered as throwing stubs (see executor/runners/stats.ts) as a
 *      backstop in case a hand-authored or cached plan references them.
 *
 * 2026-05-30: introduced after the deep review found gpt-oss-120b repeatedly
 * choosing these tools for vague spatial questions and dead-ending.
 */
export const DEFERRED_TOOL_IDS: ReadonlySet<string> = new Set([
	"stats.hex_bin",
	"stats.density_grid",
	"stats.morans_i",
	"stats.getis_ord_gi",
	"geometry.voronoi",
]);
