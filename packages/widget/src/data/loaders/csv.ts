import { load } from "@loaders.gl/core";
import { CSVLoader } from "@loaders.gl/csv";
import { type Table, tableFromJSON } from "apache-arrow";
import type {
	BinaryInput,
	DataLoader,
	LoadResult,
	LoaderOptions,
} from "../contracts";
import { LoaderError } from "../contracts";
import {
	assertNonEmpty,
	deriveTableName,
	detectLatLon,
	normalizeRows,
	toArrayBuffer,
} from "./_util";

const EXT_RE = /\.(csv|tsv)$/i;

export const csvLoader: DataLoader = {
	id: "csv",
	canLoad(filename: string): boolean {
		return EXT_RE.test(filename);
	},
	async load(
		file: BinaryInput,
		options: LoaderOptions = {},
	): Promise<LoadResult> {
		const { name, buffer } = await toArrayBuffer(file);
		assertNonEmpty(buffer, name);

		const isTsv = /\.tsv$/i.test(name);
		const csvOpts: Record<string, unknown> = {
			shape: "object-row-table",
			// Force header detection: user-uploaded CSVs virtually always have
			// a header row, and loaders.gl's "auto" mode misclassifies the
			// header as data when an intermediate column has an empty name
			// (HIGH-01). Explicit `true` is the safer default for the upload
			// path; downstream code already tolerates unusable column names.
			header: true,
			dynamicTyping: true,
		};
		if (options.delimiter) {
			csvOpts.delimitersToGuess = [options.delimiter];
		} else if (isTsv) {
			csvOpts.delimitersToGuess = ["\t"];
		}

		let parsed: unknown;
		try {
			parsed = await load(buffer, CSVLoader, {
				csv: csvOpts,
				worker: false,
			} as never);
		} catch (err) {
			// §J (2026-05-12): loaders.gl raises "deduce from empty table"
			// when a CSV has a header row but no data rows. That's not a
			// PARSE_ERROR — it's just an empty dataset — and the original
			// message is opaque. Surface it as EMPTY_FILE with a clear
			// message so the host UI can route it to the same "empty
			// file" affordance.
			const msg = describe(err);
			if (/deduce from empty table|no rows|empty table/i.test(msg)) {
				throw new LoaderError(
					"EMPTY_FILE",
					`${name}: file has a header row but no data rows.`,
					{ cause: err },
				);
			}
			throw new LoaderError(
				"PARSE_ERROR",
				`CSV parse failed for ${name}: ${msg}`,
				{ cause: err },
			);
		}

		const rows = extractRows(parsed);
		if (rows.length === 0) {
			throw new LoaderError("EMPTY_FILE", `${name}: no rows parsed.`);
		}
		const normalized = normalizeRows(rows);
		let table: Table;
		try {
			table = tableFromJSON(normalized as Record<string, unknown>[]);
		} catch (err) {
			throw new LoaderError(
				"PARSE_ERROR",
				`CSV → Arrow conversion failed for ${name}: ${describe(err)}`,
				{ cause: err },
			);
		}

		const geometry = detectLatLon(normalized, options);
		const source = isTsv ? "tsv" : "csv";
		return {
			name: deriveTableName(name, options.tableName),
			table,
			...(geometry ? { geometry } : {}),
			source,
			filename: name,
		};
	},
};

function extractRows(parsed: unknown): Array<Record<string, unknown>> {
	if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
	if (
		parsed &&
		typeof parsed === "object" &&
		Array.isArray((parsed as { data?: unknown }).data)
	) {
		return (parsed as { data: Array<Record<string, unknown>> }).data;
	}
	return [];
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
