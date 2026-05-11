/**
 * Shared contracts for the data layer.
 *
 * Apache Arrow is the universal interchange format inside the widget:
 *   File  ─►  DataLoader  ─►  Arrow.Table  ─►  DuckDBEngine (registers as view)
 *                                          └─►  DatasetProfile (column stats)
 *                                          └─►  MapView (deck.gl / GeoArrow)
 *
 * Geometry handling: loaders may produce
 *   - a column of WKB bytes (Uint8Array per row), OR
 *   - a column of GeoJSON geometry objects encoded as JSON strings, OR
 *   - paired lat/lon numeric columns (for CSV / Excel auto-detection).
 *
 * The geometry encoding is reported on `LoadResult.geometry` so downstream
 * consumers (engine, map, profiler) can branch.
 */

import type { Table as ArrowTable } from "apache-arrow";

export type SourceFormat =
	| "csv"
	| "tsv"
	| "geojson"
	| "shapefile"
	| "excel"
	| "parquet";

export type GeometryEncoding =
	| { kind: "wkb"; column: string }
	| { kind: "geojson-string"; column: string }
	| { kind: "lonlat"; lonColumn: string; latColumn: string };

export interface LoadResult {
	/** Logical table name (sanitized, safe for SQL identifiers). */
	name: string;
	/** Apache Arrow table — the canonical in-memory representation. */
	table: ArrowTable;
	/** How geometry is encoded inside `table`, if any. */
	geometry?: GeometryEncoding;
	/** Source format detected by the loader. */
	source: SourceFormat;
	/** Original filename (for messages, never trusted as identifier). */
	filename: string;
}

export interface LoaderOptions {
	/** Override the registered table name. */
	tableName?: string;
	/** For Excel: which sheet to load (defaults to first non-empty). */
	sheet?: string;
	/** For CSV: override the delimiter (defaults to auto-detect). */
	delimiter?: string;
	/** For CSV: explicit lat/lon column names; bypasses auto-detection. */
	latColumn?: string;
	lonColumn?: string;
	/** Disable lat/lon auto-detection for tabular formats. */
	noGeometry?: boolean;
}

export interface DataLoader {
	/** Stable id, e.g. "csv", "geojson". */
	readonly id: SourceFormat;
	/** Returns true if this loader handles the given filename. */
	canLoad(filename: string): boolean;
	/** Parse a file into an Arrow table + optional geometry descriptor. */
	load(file: BinaryInput, options?: LoaderOptions): Promise<LoadResult>;
}

export type BinaryInput =
	| File
	| { name: string; bytes: Uint8Array | ArrayBuffer };

export type LoaderErrorCode =
	| "UNSUPPORTED_FORMAT"
	| "EMPTY_FILE"
	| "FILE_TOO_LARGE"
	| "PARSE_ERROR"
	| "INVALID_GEOMETRY"
	| "IO_ERROR";

export class LoaderError extends Error {
	readonly code: LoaderErrorCode;
	constructor(
		code: LoaderErrorCode,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "LoaderError";
		this.code = code;
	}
}

/* -------------------------------------------------------------------------- */
/* DatasetProfile contract                                                    */
/* -------------------------------------------------------------------------- */

export type ProfileColumnKind =
	| "integer"
	| "float"
	| "boolean"
	| "string"
	| "date"
	| "timestamp"
	| "geometry"
	| "json"
	| "binary"
	| "other";

export interface NumericStats {
	min: number;
	max: number;
	mean: number;
	/** Count of finite values used for the stats. */
	count: number;
}

export interface CategoricalStats {
	/** Top values by frequency (capped). */
	top: Array<{ value: string; count: number }>;
	/** Approximate distinct count (HLL-ish if very large; exact if small). */
	distinct: number;
}

export interface DateRange {
	/** ISO 8601 string. */
	min: string;
	max: string;
	count: number;
}

export interface ColumnProfile {
	name: string;
	kind: ProfileColumnKind;
	/** Underlying Arrow type as string (e.g., "Float64", "Utf8"). */
	arrowType: string;
	nullable: boolean;
	nullCount: number;
	/** Populated when kind is integer/float. */
	numeric?: NumericStats;
	/** Populated when kind is string. */
	categorical?: CategoricalStats;
	/** Populated when kind is date/timestamp. */
	range?: DateRange;
}

export interface GeometryProfile {
	column: string;
	encoding: GeometryEncoding["kind"];
	/** [minX, minY, maxX, maxY] in WGS84. */
	bbox?: [number, number, number, number];
	/** Sampled count of non-null geometries used for bbox. */
	sampledCount: number;
	/** Coarse CRS guess: 'wgs84' (lon/lat in [-180,180]/[-90,90]) or 'projected' or 'unknown'. */
	crsGuess: "wgs84" | "projected" | "unknown";
}

export interface DatasetProfile {
	name: string;
	source: SourceFormat;
	rowCount: number;
	columns: ColumnProfile[];
	geometry?: GeometryProfile;
	/** Wall-clock ms it took to compute the profile. */
	profileMs: number;
}
