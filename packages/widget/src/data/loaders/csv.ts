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
			header: "auto",
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
			throw new LoaderError(
				"PARSE_ERROR",
				`CSV parse failed for ${name}: ${describe(err)}`,
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
