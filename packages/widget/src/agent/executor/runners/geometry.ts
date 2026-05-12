/**
 * Geometry tool runtimes (DuckDB Spatial backed).
 *
 * Each runner builds a SELECT that produces a `geom` column and any
 * carry-through attributes, then materializes a temporary view via
 * {@link materializeView}. Outputs are layer-kind OutputRefs.
 *
 * Tools NOT implemented in this Phase 5 v1 (deferred to Phase 5 expansion):
 *   - geometry.voronoi  (Turf concaveman / voronoi)
 *   - geometry.reproject (proj4js, ~50 KB lazy load)
 *
 * For convex_hull, Phase 5 v1 supports `mode: 'convex'` only;
 * `mode: 'concave'` falls back to the convex hull with a console warning.
 */

import { z } from "zod";
import { registerRunner } from "../runtime.js";
import { materializeView, quoteIdent, resolveLayer } from "../sql-helpers.js";
import type { ExecCtx, RunnerResult } from "../types.js";

/* -------------------------------------------------------------------------- */
/* geometry.reproject (passthrough — proj4js not yet bundled)                 */
/* -------------------------------------------------------------------------- */

const ReprojectArgs = z.object({ layer: z.unknown(), to_crs: z.string() });

export async function runReproject(
	args: Record<string, unknown>,
	ctx: ExecCtx,
): Promise<RunnerResult> {
	const { layer } = ReprojectArgs.parse(args);
	const view = resolveLayer(layer, ctx);
	// proj4js (~50 KB) is deferred to Phase 5 expansion. Return the layer
	// unchanged so downstream distance/buffer steps still run. Results will be
	// in the original CRS units (degrees for EPSG:4326 data).
	// eslint-disable-next-line no-console
	console.warn(
		"[geochatbot] geometry.reproject not yet implemented — returning layer unchanged",
	);
	return { output: { kind: "layer", ref: view } };
}

registerRunner("geometry.reproject", runReproject);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const Units = z.enum(["meters", "kilometers", "miles", "feet"]);

/**
 * Convert a distance + units arg into a value in the geometry's native CRS
 * units. ST_Buffer in DuckDB Spatial uses CRS units (meters for projected,
 * degrees for EPSG:4326). Phase 5 v1 punts on full unit conversion: for
 * `meters` we pass through; for other units we convert to meters and let
 * the planner schedule a `geometry.reproject` if accuracy matters.
 */
function distanceInMeters(
	distance: number,
	units: z.infer<typeof Units>,
): number {
	switch (units) {
		case "meters":
			return distance;
		case "kilometers":
			return distance * 1000;
		case "miles":
			return distance * 1609.344;
		case "feet":
			return distance * 0.3048;
	}
}

/* -------------------------------------------------------------------------- */
/* geometry.buffer                                                            */
/* -------------------------------------------------------------------------- */

const BufferArgs = z.object({
	layer: z.unknown(),
	distance: z.number().positive(),
	units: Units.default("meters"),
});

export async function runBuffer(
	args: Record<string, unknown>,
	ctx: ExecCtx,
): Promise<RunnerResult> {
	const { layer, distance, units } = BufferArgs.parse(args);
	const view = resolveLayer(layer, ctx);
	const meters = distanceInMeters(distance, units);
	// AUDIT-012 (math): ST_Buffer in DuckDB-Spatial uses the geometry's
	// native CRS units — meters for projected, *degrees* for EPSG:4326.
	// Passing `500` for a 500-metre buffer against lat/lon data
	// produces a 500-degree buffer (the entire planet). Detect this
	// case at runtime by sampling the view's bbox; if every sampled
	// coord lives in [-180,180]×[-90,90] we treat it as geographic and
	// convert metres → approximate degrees (1° ≈ 111_320 m at equator)
	// with a console hint so the user knows the result is approximate.
	// The planner's "Reproject before distance" rule should have caught
	// this in agentic mode, but the runtime guard catches LLM mistakes
	// and direct host calls that bypass the planner.
	const bbox = await bboxForView(ctx, view);
	const looksGeographic =
		bbox !== null &&
		Math.abs(bbox.minX) <= 180 &&
		Math.abs(bbox.maxX) <= 180 &&
		Math.abs(bbox.minY) <= 90 &&
		Math.abs(bbox.maxY) <= 90;
	const distanceInQueryUnits = looksGeographic ? meters / 111_320 : meters;
	if (looksGeographic) {
		// eslint-disable-next-line no-console
		console.warn(
			`[geochatbot] geometry.buffer: input CRS looks geographic (bbox fits in WGS84); converting ${meters} m to ~${distanceInQueryUnits.toFixed(6)}° for ST_Buffer. For accurate distances reproject to a metric CRS first.`,
		);
	}
	const sql = `SELECT * REPLACE (ST_Buffer(geom, ${distanceInQueryUnits}) AS geom) FROM ${quoteIdent(view)}`;
	const out = await materializeView(ctx, "buffer", sql);
	return { output: { kind: "layer", ref: out } };
}

async function bboxForView(
	ctx: ExecCtx,
	view: string,
): Promise<{ minX: number; minY: number; maxX: number; maxY: number } | null> {
	try {
		const t = await ctx.engine.query(
			`SELECT
        MIN(ST_XMin(geom)) AS minX,
        MIN(ST_YMin(geom)) AS minY,
        MAX(ST_XMax(geom)) AS maxX,
        MAX(ST_YMax(geom)) AS maxY
      FROM ${quoteIdent(view)}
      WHERE geom IS NOT NULL`,
		);
		const row = t.toArray()[0] as Record<string, unknown> | undefined;
		if (!row) return null;
		const minX = Number(row.minX);
		const minY = Number(row.minY);
		const maxX = Number(row.maxX);
		const maxY = Number(row.maxY);
		if (
			!Number.isFinite(minX) ||
			!Number.isFinite(minY) ||
			!Number.isFinite(maxX) ||
			!Number.isFinite(maxY)
		) {
			return null;
		}
		return { minX, minY, maxX, maxY };
	} catch {
		return null;
	}
}

registerRunner("geometry.buffer", runBuffer);

/* -------------------------------------------------------------------------- */
/* geometry.centroid                                                          */
/* -------------------------------------------------------------------------- */

const CentroidArgs = z.object({ layer: z.unknown() });

export async function runCentroid(
	args: Record<string, unknown>,
	ctx: ExecCtx,
): Promise<RunnerResult> {
	const { layer } = CentroidArgs.parse(args);
	const view = resolveLayer(layer, ctx);
	const sql = `SELECT * REPLACE (ST_Centroid(geom) AS geom) FROM ${quoteIdent(view)}`;
	const out = await materializeView(ctx, "centroid", sql);
	return { output: { kind: "layer", ref: out } };
}

registerRunner("geometry.centroid", runCentroid);

/* -------------------------------------------------------------------------- */
/* geometry.intersect / union / difference                                    */
/* -------------------------------------------------------------------------- */

const TwoLayerArgs = z.object({ a: z.unknown(), b: z.unknown() });

export async function runIntersect(
	args: Record<string, unknown>,
	ctx: ExecCtx,
): Promise<RunnerResult> {
	const { a, b } = TwoLayerArgs.parse(args);
	const va = resolveLayer(a, ctx);
	const vb = resolveLayer(b, ctx);
	// AUDIT-009 (math/SQL): when `a` and `b` share any column name
	// (`id`, `name`, `value` — extremely common) the naive
	// `SELECT a.* EXCLUDE (geom), b.* EXCLUDE (geom)` produces a
	// DuckDB "duplicate column name" binder error. We introspect both
	// views and emit per-side `a_<col>` / `b_<col>` aliases.
	const projection = await buildPrefixedProjection(ctx, va, vb);
	const sql = `SELECT
      ${projection},
      ST_Intersection(a.geom, b.geom) AS geom
    FROM ${quoteIdent(va)} a
    JOIN ${quoteIdent(vb)} b ON ST_Intersects(a.geom, b.geom)`;
	const out = await materializeView(ctx, "intersect", sql);
	return { output: { kind: "layer", ref: out } };
}

registerRunner("geometry.intersect", runIntersect);

export async function runUnion(
	args: Record<string, unknown>,
	ctx: ExecCtx,
): Promise<RunnerResult> {
	const { a, b } = TwoLayerArgs.parse(args);
	const va = resolveLayer(a, ctx);
	const vb = resolveLayer(b, ctx);
	// AUDIT-010 (math/SQL): the previous `SELECT geom ... UNION ALL
	// SELECT geom` discarded every non-geom attribute. Users expect
	// "stack both layers, keep their fields." DuckDB's
	// `UNION ALL BY NAME` does exactly that — columns missing from
	// one side are NULL-filled on the other.
	const sql = `SELECT * FROM ${quoteIdent(va)} UNION ALL BY NAME SELECT * FROM ${quoteIdent(vb)}`;
	const out = await materializeView(ctx, "union", sql);
	return { output: { kind: "layer", ref: out } };
}

registerRunner("geometry.union", runUnion);

export async function runDifference(
	args: Record<string, unknown>,
	ctx: ExecCtx,
): Promise<RunnerResult> {
	const { a, b } = TwoLayerArgs.parse(args);
	const va = resolveLayer(a, ctx);
	const vb = resolveLayer(b, ctx);
	// AUDIT-011 (math/SQL): `GROUP BY a.*` star-expansion isn't
	// portable in DuckDB and breaks when `a` contains BLOB / geometry
	// columns that aren't groupable. Materialize a per-row surrogate
	// id with row_number(), aggregate by that, then re-join the
	// attribute columns.
	const colsA = await listColumns(ctx, va);
	const carryCols = colsA.filter((c) => c.toLowerCase() !== "geom");
	const carrySelect = carryCols.map((c) => `a.${quoteIdent(c)}`).join(", ");
	const sql = `
      WITH a_indexed AS (
        SELECT *, row_number() OVER () AS __rid FROM ${quoteIdent(va)}
      ),
      diffs AS (
        SELECT a.__rid,
          ST_Difference(
            ANY_VALUE(a.geom),
            COALESCE(ST_Union_Agg(b.geom), ST_GeomFromText('POLYGON EMPTY'))
          ) AS geom
        FROM a_indexed a
        LEFT JOIN ${quoteIdent(vb)} b ON ST_Intersects(a.geom, b.geom)
        GROUP BY a.__rid
      )
      SELECT ${carrySelect ? `${carrySelect},` : ""} d.geom AS geom
      FROM diffs d JOIN a_indexed a ON a.__rid = d.__rid`;
	const out = await materializeView(ctx, "difference", sql);
	return { output: { kind: "layer", ref: out } };
}

/**
 * Build a `<alias>.<col> AS <prefix>_<col>` projection for every
 * non-geometry column in views `va` and `vb`. Skip `geom` because the
 * caller appends `ST_Intersection(a.geom, b.geom) AS geom` separately.
 * Returns a fallback `_intersect_placeholder` column when both layers
 * are geom-only — keeps the SELECT well-formed.
 */
async function buildPrefixedProjection(
	ctx: ExecCtx,
	va: string,
	vb: string,
): Promise<string> {
	const colsA = await listColumns(ctx, va);
	const colsB = await listColumns(ctx, vb);
	const parts: string[] = [];
	for (const c of colsA) {
		if (c.toLowerCase() === "geom") continue;
		parts.push(`a.${quoteIdent(c)} AS ${quoteIdent(`a_${c}`)}`);
	}
	for (const c of colsB) {
		if (c.toLowerCase() === "geom") continue;
		parts.push(`b.${quoteIdent(c)} AS ${quoteIdent(`b_${c}`)}`);
	}
	return parts.length > 0 ? parts.join(", ") : "NULL AS _intersect_placeholder";
}

async function listColumns(ctx: ExecCtx, view: string): Promise<string[]> {
	const t = await ctx.engine.query(
		`SELECT name FROM pragma_table_info(${quoteIdent(view)})`,
	);
	const out: string[] = [];
	for (const row of t.toArray()) {
		const r = row as Record<string, unknown>;
		const n = r.name;
		if (typeof n === "string") out.push(n);
	}
	return out;
}

registerRunner("geometry.difference", runDifference);

/* -------------------------------------------------------------------------- */
/* geometry.dissolve                                                          */
/* -------------------------------------------------------------------------- */

const DissolveArgs = z.object({
	layer: z.unknown(),
	by_field: z.string().optional(),
});

export async function runDissolve(
	args: Record<string, unknown>,
	ctx: ExecCtx,
): Promise<RunnerResult> {
	const { layer, by_field } = DissolveArgs.parse(args);
	const view = resolveLayer(layer, ctx);
	const sql = by_field
		? `SELECT ${quoteIdent(by_field)}, ST_Union_Agg(geom) AS geom FROM ${quoteIdent(view)} GROUP BY ${quoteIdent(by_field)}`
		: `SELECT ST_Union_Agg(geom) AS geom FROM ${quoteIdent(view)}`;
	const out = await materializeView(ctx, "dissolve", sql);
	return { output: { kind: "layer", ref: out } };
}

registerRunner("geometry.dissolve", runDissolve);

/* -------------------------------------------------------------------------- */
/* geometry.simplify                                                          */
/* -------------------------------------------------------------------------- */

const SimplifyArgs = z.object({
	layer: z.unknown(),
	tolerance: z.number().positive(),
});

export async function runSimplify(
	args: Record<string, unknown>,
	ctx: ExecCtx,
): Promise<RunnerResult> {
	const { layer, tolerance } = SimplifyArgs.parse(args);
	const view = resolveLayer(layer, ctx);
	const sql = `SELECT * REPLACE (ST_Simplify(geom, ${tolerance}) AS geom) FROM ${quoteIdent(view)}`;
	const out = await materializeView(ctx, "simplify", sql);
	return { output: { kind: "layer", ref: out } };
}

registerRunner("geometry.simplify", runSimplify);

/* -------------------------------------------------------------------------- */
/* geometry.convex_hull                                                       */
/* -------------------------------------------------------------------------- */

const HullArgs = z.object({
	layer: z.unknown(),
	mode: z.enum(["convex", "concave"]).default("concave"),
});

export async function runConvexHull(
	args: Record<string, unknown>,
	ctx: ExecCtx,
): Promise<RunnerResult> {
	const { layer, mode } = HullArgs.parse(args);
	const view = resolveLayer(layer, ctx);
	if (mode === "concave") {
		// Phase 5 v1 falls back to convex hull. The `concaveman` package
		// (~10 KB lazy-load) ships in Phase 5 expansion.
		// eslint-disable-next-line no-console
		console.warn(
			"[geochatbot] geometry.convex_hull mode=concave falling back to convex (concaveman not yet wired)",
		);
	}
	const sql = `SELECT ST_ConvexHull(ST_Union_Agg(geom)) AS geom FROM ${quoteIdent(view)}`;
	const out = await materializeView(ctx, "hull", sql);
	return { output: { kind: "layer", ref: out } };
}

registerRunner("geometry.convex_hull", runConvexHull);
