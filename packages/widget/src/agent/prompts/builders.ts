import { z } from "zod";
import { DEFERRED_TOOL_IDS } from "../tools/deferred.js";
import { listTools } from "../tools/registry.js";
import type { ToolDef } from "../tools/types.js";
import templateRaw from "./planner.system.md?raw";

export interface DatasetProfile {
	name: string;
	kind: "table" | "layer";
	rows: number;
	geometry?: {
		kind: "point" | "line" | "polygon" | "multi";
		column: string;
		crs?: string;
		bbox?: [number, number, number, number];
	};
	columns: Array<{
		name: string;
		type: string;
		range?: [number | string, number | string];
		nulls?: number;
		cardinality?: number;
		/**
		 * Up to 3 representative example values, already truncated to 80 chars
		 * each. Drawn from the dataset profile's top-frequency strings or the
		 * numeric range — never raw arbitrary rows. Helps the planner identify
		 * column semantics (e.g., distinguishing an "Address" column from a
		 * "Notes" column) without exposing arbitrary user data.
		 */
		samples?: unknown[];
		role?: import("../profile/roles.js").ColumnRole;
		needsBucketing?: boolean;
	}>;
	sample: unknown[];
	inferredRegion?: import("../profile/region.js").InferredRegion;
}

/**
 * Color-by suitability score for a column. Higher = better candidate for
 * `style.colorBy` on a map render. The planner reads the score when the
 * user says "color code the points" without specifying a column.
 *
 * Scoring rubric (audit 2026-05-21 — landed alongside the legend fix):
 *   3 — strong:  low-card categorical (3-12 distinct strings) OR a name
 *                that screams "status/category/type/outcome/class" with
 *                cardinality > 1 OR a continuous numeric (cardinality > 20).
 *   2 — medium:  boolean, low-card date, or a string with cardinality
 *                13-30 (acceptable but may need bucketing).
 *   1 — weak:    high-card free text (cardinality > 30) — should be
 *                bucketed via SQL before render, not passed raw.
 *   0 — no:      address-like, WKT, ID-like unique strings, single-value
 *                columns, the geometry column itself.
 */
export type ColorByScore = 0 | 1 | 2 | 3;
export interface ColorByCandidate {
	score: ColorByScore;
	reason: string;
}

const STATUS_NAME_RE =
	/(^|[_\s-])(status|state|type|category|outcome|result|class|group|kind|disposition|level|severity|stage|phase|tier|grade|condition|label|tag)([_\s-]|$)/i;

/**
 * Compute the color-by suitability of a single column from already-known
 * profile metadata (cardinality, type, name, samples). Pure function so
 * unit tests can pin the rubric without spinning up Arrow/DuckDB.
 */
export function scoreColorByCandidate(args: {
	name: string;
	type: string;
	cardinality?: number;
	samples?: unknown[];
	rows?: number;
	geometryColumn?: string;
}): ColorByCandidate {
	const { name, type, cardinality, samples, rows, geometryColumn } = args;
	const lname = name.toLowerCase();
	const ltype = type.toLowerCase();

	if (geometryColumn && name === geometryColumn) {
		return { score: 0, reason: "geometry column" };
	}

	// Hard "no" signals from the existing semantic-hint detector.
	const semantic = detectSemanticHint(name, type, samples);
	if (
		semantic === "wkt-geometry" ||
		semantic === "latitude" ||
		semantic === "longitude" ||
		semantic === "street-address"
	) {
		return { score: 0, reason: `${semantic} — not a color-by signal` };
	}
	if (
		/(^|[_\s-])(id|uuid|guid|name|address|notes?|comment|description)([_\s-]|$)/i.test(
			lname,
		)
	) {
		// "Name"-like columns are usually unique-per-row; "address"/"notes"
		// are free text. These should not be passed raw to colorBy.
		if (
			cardinality !== undefined &&
			rows !== undefined &&
			rows > 0 &&
			cardinality / rows > 0.5
		) {
			return { score: 0, reason: "ID-like / unique-per-row column" };
		}
	}

	// Cardinality of 0 or 1 = no information.
	if (cardinality !== undefined && cardinality <= 1) {
		return { score: 0, reason: "single distinct value" };
	}

	// Strong name-based signal.
	const nameHit = STATUS_NAME_RE.test(lname);

	// Boolean = always exactly 2 colors. Useful but limited.
	if (ltype.includes("bool")) {
		return { score: 2, reason: "boolean — produces 2 buckets" };
	}

	// Numeric: choropleth-style quantile/linear scale.
	if (
		ltype.includes("int") ||
		ltype.includes("float") ||
		ltype.includes("double") ||
		ltype.includes("decimal")
	) {
		if (cardinality !== undefined && cardinality < 3) {
			return { score: 1, reason: "near-constant numeric" };
		}
		if (cardinality !== undefined && cardinality > 20) {
			return {
				score: 3,
				reason: "continuous numeric — good choropleth candidate",
			};
		}
		return { score: 2, reason: "numeric with limited range" };
	}

	// String — the most common case.
	if (
		ltype.includes("utf8") ||
		ltype.includes("string") ||
		ltype.includes("varchar")
	) {
		if (cardinality === undefined) {
			// Unknown cardinality: if the name is a strong signal, bump to medium.
			return nameHit
				? { score: 2, reason: "status-like name — verify with distinct_values" }
				: { score: 1, reason: "string of unknown cardinality" };
		}
		if (cardinality >= 3 && cardinality <= 12) {
			// 2026-05-21: status-like names take the 3/3 tier exclusively so
			// `contact_status` beats `date` when both are technically low-card.
			// A generic low-card column scores 2/3 — still picked when nothing
			// better exists, but loses ties to a named status column.
			return nameHit
				? {
						score: 3,
						reason: `status-named low-card categorical (${cardinality} distinct)`,
					}
				: {
						score: 2,
						reason: `low-card categorical (${cardinality} distinct)`,
					};
		}
		if (cardinality === 2) {
			return { score: 2, reason: "binary categorical (2 distinct)" };
		}
		if (cardinality <= 30) {
			return {
				score: 2,
				reason: `medium-card categorical (${cardinality} distinct)`,
			};
		}
		// High cardinality: needs bucketing.
		if (nameHit) {
			return {
				score: 2,
				reason: `status-like name with high cardinality (${cardinality}) — bucket via SQL`,
			};
		}
		return {
			score: 1,
			reason: `high-card free text (${cardinality} distinct) — bucket via SQL or skip`,
		};
	}

	// Date/timestamp — usually too sparse to color by directly.
	if (ltype.includes("date") || ltype.includes("timestamp")) {
		if (cardinality !== undefined && cardinality >= 3 && cardinality <= 12) {
			return { score: 2, reason: "low-card date — usable but noisy" };
		}
		return { score: 1, reason: "date — extract bucket via SQL first" };
	}

	return { score: 1, reason: "unclassified — verify before using" };
}

/** Rank a dataset's columns from best → worst color-by candidate.
 *  Stable: ties preserve original column order. */
export function rankColorByCandidates(
	profile: DatasetProfile,
): Array<{ name: string; score: ColorByScore; reason: string }> {
	const out = profile.columns.map((c) => {
		const cand = scoreColorByCandidate({
			name: c.name,
			type: c.type,
			...(c.cardinality !== undefined ? { cardinality: c.cardinality } : {}),
			...(c.samples !== undefined ? { samples: c.samples } : {}),
			rows: profile.rows,
			...(profile.geometry?.column
				? { geometryColumn: profile.geometry.column }
				: {}),
		});
		return { name: c.name, score: cand.score, reason: cand.reason };
	});
	// Stable sort by score desc.
	return out
		.map((c, i) => ({ ...c, _i: i }))
		.sort((a, b) => b.score - a.score || a._i - b._i)
		.map(({ _i, ...rest }) => rest);
}

const DATASET_CAP = 5;
const SAMPLE_CAP = 3;

export function renderDatasetsBlock(datasets: DatasetProfile[]): string {
	const lines: string[] = [];
	for (const d of datasets.slice(0, DATASET_CAP)) {
		lines.push(`## ${d.name} (${d.kind})`);
		lines.push(`- rows: ${d.rows}`);
		if (d.geometry) {
			const bbox = d.geometry.bbox
				? ` bbox: [${d.geometry.bbox.join(", ")}]`
				: "";
			const crs = d.geometry.crs ? ` CRS: ${d.geometry.crs}` : "";
			lines.push(
				`- geometry: ${d.geometry.kind} (column: ${d.geometry.column},${crs}${bbox})`,
			);
		}
		lines.push("- columns:");
		for (const c of d.columns) {
			const range = c.range ? ` (range: ${c.range[0]}-${c.range[1]})` : "";
			const nulls = c.nulls !== undefined ? ` nulls: ${c.nulls}` : "";
			const card =
				c.cardinality !== undefined ? ` cardinality: ${c.cardinality}` : "";
			// Render up to 3 examples per column. Already inside the
			// UNTRUSTED_DATASET_PROFILE fence in planner.ts, so the model treats
			// these as opaque data — we still JSON.stringify and cap each value
			// to keep prompt-injection attempts bounded and the prompt small.
			const samples = renderColumnSamples(c.samples);
			// R.4-f (audit 2026-05-16): hybrid semantic detection. Pure-regex
			// pre-tag of the obvious types (lat/lon, address, ZIP, currency,
			// phone, ISO date, WKT). Saves the planner an inspect.column_pattern
			// round-trip on the most common cases. NL2SQL literature (Spider /
			// BIRD) consistently shows schema-linking is the #1 bottleneck —
			// even partial semantic hints lift accuracy markedly.
			const hint = detectSemanticHint(c.name, c.type, c.samples);
			const hintStr = hint ? ` hint:${hint}` : "";
			// 2026-05-21: color-by suitability hint. Weak models would
			// otherwise blindly pick the first column for a bare "color
			// code the points" request — producing a 2-color blob from a
			// sparse date column. The score gives the planner a pre-
			// computed ranking it can trust.
			const cand = scoreColorByCandidate({
				name: c.name,
				type: c.type,
				...(c.cardinality !== undefined ? { cardinality: c.cardinality } : {}),
				...(c.samples !== undefined ? { samples: c.samples } : {}),
				rows: d.rows,
				...(d.geometry?.column ? { geometryColumn: d.geometry.column } : {}),
			});
			const candStr = ` colorBy:${cand.score}/3 (${cand.reason})`;
			const roleStr = c.role
				? `  [role: ${c.role}${c.needsBucketing ? "; needs bucketing before group/color" : ""}]`
				: "";
			lines.push(
				`  - ${c.name}: ${c.type}${range}${nulls}${card}${samples}${hintStr}${candStr}${roleStr}`.trimEnd(),
			);
		}
		// Inferred region from city/state/lat/lon columns — gives the planner
		// a starting bbox for spatial queries without an extra inspect round-trip.
		if (d.inferredRegion) {
			lines.push(`- inferred region: ${d.inferredRegion.label}`);
		}
		// Top 3 colorBy picks at the dataset level — saves the planner from
		// scanning the per-column table when the user says "color code".
		const ranked = rankColorByCandidates(d)
			.filter((r) => r.score > 0)
			.slice(0, 3);
		if (ranked.length > 0) {
			const summary = ranked.map((r) => `${r.name} (${r.score}/3)`).join(", ");
			lines.push(`- best color-by candidates: ${summary}`);
		} else {
			lines.push(
				"- best color-by candidates: NONE — no column scored above 0; ask the user which column to color by",
			);
		}
		if (d.sample.length) {
			lines.push(
				`- sample rows (${Math.min(d.sample.length, SAMPLE_CAP)}): ${JSON.stringify(d.sample.slice(0, SAMPLE_CAP))}`,
			);
		}
		lines.push("");
	}
	return lines.join("\n").trim();
}

export function renderToolsBlock(): string {
	// Hide deferred/unimplemented tools so the planner can't pick a dead-end.
	const tools = listTools().filter((t) => !DEFERRED_TOOL_IDS.has(t.id));
	const groups = new Map<string, ToolDef[]>();
	for (const t of tools) {
		const ns = t.id.includes(".") ? (t.id.split(".")[0] ?? t.id) : t.id;
		const key = ns === "sql" ? "sql" : `${ns}.*`;
		const arr = groups.get(key) ?? [];
		arr.push(t);
		groups.set(key, arr);
	}
	const order = [
		"geocode.*",
		"geometry.*",
		"joins.*",
		"stats.*",
		"render.*",
		"sql",
	];
	// Surface any namespace we forgot to enumerate — without this an
	// unlisted tool stays registered but invisible to the LLM, which is
	// how `geocode.*` was silently dropped from the catalog before.
	const remaining = [...groups.keys()].filter((k) => !order.includes(k)).sort();
	const ordered = [...order.filter((k) => groups.has(k)), ...remaining];

	const out: string[] = [];
	for (const ns of ordered) {
		out.push(`## ${ns}`);
		const grp = groups.get(ns);
		if (!grp) continue;
		for (const t of grp) {
			const sig = `${t.id}(${argSignature(t)})`;
			out.push(`### ${sig}`);
			out.push(t.description);
			const ex0 = t.examples?.[0];
			if (ex0) {
				out.push(`  e.g. ${JSON.stringify(ex0.args)}`);
			}
			out.push("");
		}
	}
	return out.join("\n").trim();
}

function renderColumnSamples(samples: unknown[] | undefined): string {
	if (!Array.isArray(samples) || samples.length === 0) return "";
	const out: string[] = [];
	for (const s of samples.slice(0, 3)) {
		let str: string;
		try {
			str = typeof s === "string" ? s : JSON.stringify(s);
		} catch {
			str = String(s);
		}
		if (typeof str !== "string") continue;
		// Hard-cap each rendered sample so a 5 KB cell can't blow up the prompt.
		if (str.length > 80) str = `${str.slice(0, 77)}...`;
		out.push(JSON.stringify(str));
	}
	if (out.length === 0) return "";
	return ` examples: [${out.join(", ")}]`;
}

/**
 * Audit 2026-05-16 R.4-f. Detect the most common column semantics from
 * the column name + a handful of sample values. Returns a single
 * short tag (e.g. `latitude`, `currency`, `iso-date`) that the planner
 * can use to short-circuit `inspect.column_pattern` round-trips.
 *
 * Conservative: only emits a hint when at least one sample matches the
 * type pattern (or when the name is a strong signal on its own). Never
 * fires on geometry columns (they're already covered by the dataset
 * profile's `geometry` block).
 */
export function detectSemanticHint(
	name: string,
	type: string,
	samples: unknown[] | undefined,
): string | undefined {
	const lname = String(name ?? "").toLowerCase();
	const ltype = String(type ?? "").toLowerCase();
	const sampleStrs: string[] = [];
	if (Array.isArray(samples)) {
		for (const s of samples.slice(0, 5)) {
			if (s === null || s === undefined) continue;
			const str = typeof s === "string" ? s : String(s);
			if (str.length > 0 && str.length <= 200) sampleStrs.push(str);
		}
	}

	// Name-only strong signals.
	if (/^(lat|latitude|y_coord|y)$/i.test(name)) return "latitude";
	if (/^(lon|lng|long|longitude|x_coord|x)$/i.test(name)) return "longitude";
	if (/^(wkt|geom|geometry|the_geom)$/i.test(name)) return "wkt-geometry";
	if (/(zip|zipcode|postal[_-]?code)/i.test(lname)) return "zip-or-postal";
	if (/(country)/i.test(lname) && !/code/i.test(lname)) return "country-name";
	if (/(country[_-]?code|iso[_-]?country)/i.test(lname)) return "country-code";
	if (/^state$/i.test(name) || /(state[_-]?code|state[_-]?abbr)/i.test(lname))
		return "state";

	// Sample-based detection.
	const allNumeric =
		sampleStrs.length > 0 &&
		sampleStrs.every((s) => /^-?\d+(\.\d+)?$/.test(s.trim()));
	if (allNumeric && ltype.includes("double")) {
		const nums = sampleStrs.map((s) => Number.parseFloat(s));
		const looksLat = nums.every((n) => Math.abs(n) <= 90);
		const looksLon = nums.every((n) => Math.abs(n) <= 180);
		if (looksLat && /(lat|y)/i.test(lname)) return "latitude";
		if (looksLon && /(lon|lng|x)/i.test(lname)) return "longitude";
	}

	if (
		sampleStrs.some((s) => /^\$\s?\d/.test(s) || /^\d+[\d,]*\.\d{2}$/.test(s))
	)
		return "currency";

	if (
		sampleStrs.some((s) =>
			/^\(\d{3}\)\s?\d{3}[-.\s]?\d{4}$|^\+?\d[\d\s().-]{7,}\d$/.test(s.trim()),
		)
	) {
		// Phone heuristic — at least one sample looks phone-shaped.
		if (/(phone|tel|mobile|cell)/i.test(lname)) return "phone";
	}

	if (sampleStrs.some((s) => /^\d{4}-\d{2}-\d{2}/.test(s.trim())))
		return "iso-date";

	if (
		sampleStrs.some((s) =>
			/^POINT\s*\(|^POLYGON\s*\(|^MULTIPOINT\s*\(|^MULTIPOLYGON\s*\(|^LINESTRING\s*\(/i.test(
				s.trim(),
			),
		)
	)
		return "wkt-geometry";

	if (
		sampleStrs.some(
			(s) =>
				/^\d{1,6}\s+[A-Z]/i.test(s.trim()) &&
				/(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place)$/i.test(
					s.trim().split(/\s+/).slice(-1)[0] ?? "",
				),
		)
	) {
		return "street-address";
	}

	// Low-cardinality categorical string — modeled as a string with a
	// small number of distinct values (cardinality may be undefined here;
	// the column's own renderer adds it separately).
	if (ltype.includes("varchar") || ltype.includes("string")) {
		if (sampleStrs.length >= 2 && sampleStrs.every((s) => s.length <= 40)) {
			const uniq = new Set(sampleStrs.map((s) => s.toLowerCase())).size;
			if (uniq <= 3 && sampleStrs.length >= 3) return "low-card-categorical";
		}
	}

	return undefined;
}

function argSignature(t: ToolDef): string {
	// Use Zod's public `shape` accessor; tools registered with non-object
	// schemas (unions, intersections) intentionally render as `tool()`.
	if (!(t.args instanceof z.ZodObject)) return "";
	return Object.keys(t.args.shape).join(", ");
}

export function renderPrompt(parts: {
	datasets: string;
	tools: string;
	examples: string;
}): string {
	return templateRaw
		.replace("{{datasets_block}}", parts.datasets)
		.replace("{{tools_block}}", parts.tools)
		.replace("{{examples_block}}", parts.examples);
}
