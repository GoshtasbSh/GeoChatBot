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
			lines.push(
				`  - ${c.name}: ${c.type}${range}${nulls}${card}${samples}`.trimEnd(),
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
