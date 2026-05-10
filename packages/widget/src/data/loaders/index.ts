import type { BinaryInput, LoadResult, LoaderOptions } from "../contracts";
import { LoaderError } from "../contracts";

/**
 * Dispatch a file to the appropriate loader via dynamic import so that
 * heavy deps (@loaders.gl/csv, /shapefile, /excel, /parquet, jszip, …)
 * are excluded from the initial bundle (PLAN §3 hard rule).
 *
 * Each branch only loads its module on first invocation. Subsequent calls
 * for the same format reuse the already-resolved module from the module cache.
 */
export async function loadFile(
	file: BinaryInput,
	options?: LoaderOptions,
): Promise<LoadResult> {
	const filename =
		typeof File !== "undefined" && file instanceof File
			? file.name
			: (file as { name: string }).name;

	if (/\.(csv|tsv)$/i.test(filename)) {
		return (await import("./csv.js")).csvLoader.load(file, options);
	}
	if (/\.(geojson|json)$/i.test(filename)) {
		return (await import("./geojson.js")).geojsonLoader.load(file, options);
	}
	if (/\.(zip|shp)$/i.test(filename)) {
		return (await import("./shapefile.js")).shapefileLoader.load(file, options);
	}
	if (/\.(xlsx|xls)$/i.test(filename)) {
		return (await import("./excel.js")).excelLoader.load(file, options);
	}
	if (/\.parquet$/i.test(filename)) {
		return (await import("./parquet.js")).parquetLoader.load(file, options);
	}

	throw new LoaderError(
		"UNSUPPORTED_FORMAT",
		`Unsupported file format: ${filename}. Supported: .csv, .tsv, .geojson, .json, .zip, .shp, .xlsx, .xls, .parquet`,
	);
}
