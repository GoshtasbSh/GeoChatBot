import { z } from "zod";
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
	}>;
	sample: unknown[];
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
			lines.push(
				`  - ${c.name}: ${c.type}${range}${nulls}${card}${samples}${hintStr}`.trimEnd(),
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
	const tools = listTools();
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
	const allNumeric = sampleStrs.length > 0 &&
		sampleStrs.every((s) => /^-?\d+(\.\d+)?$/.test(s.trim()));
	if (allNumeric && ltype.includes("double")) {
		const nums = sampleStrs.map((s) => Number.parseFloat(s));
		const looksLat = nums.every((n) => Math.abs(n) <= 90);
		const looksLon = nums.every((n) => Math.abs(n) <= 180);
		if (looksLat && /(lat|y)/i.test(lname)) return "latitude";
		if (looksLon && /(lon|lng|x)/i.test(lname)) return "longitude";
	}

	if (sampleStrs.some((s) => /^\$\s?\d/.test(s) || /^\d+[\d,]*\.\d{2}$/.test(s)))
		return "currency";

	if (sampleStrs.some((s) =>
		/^\(\d{3}\)\s?\d{3}[-.\s]?\d{4}$|^\+?\d[\d\s().-]{7,}\d$/.test(s.trim()),
	)) {
		// Phone heuristic — at least one sample looks phone-shaped.
		if (/(phone|tel|mobile|cell)/i.test(lname)) return "phone";
	}

	if (sampleStrs.some((s) => /^\d{4}-\d{2}-\d{2}/.test(s.trim())))
		return "iso-date";

	if (sampleStrs.some((s) => /^POINT\s*\(|^POLYGON\s*\(|^MULTIPOINT\s*\(|^MULTIPOLYGON\s*\(|^LINESTRING\s*\(/i.test(s.trim())))
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
