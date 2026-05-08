import { csvLoader } from './csv';
import { geojsonLoader } from './geojson';
import { shapefileLoader } from './shapefile';
import { excelLoader } from './excel';
import { parquetLoader } from './parquet';
import type { BinaryInput, DataLoader, LoaderOptions, LoadResult } from '../contracts';
import { LoaderError } from '../contracts';

export { csvLoader, geojsonLoader, shapefileLoader, excelLoader, parquetLoader };

export const loaders: DataLoader[] = [
  csvLoader,
  geojsonLoader,
  shapefileLoader,
  excelLoader,
  parquetLoader,
];

/** Pick the first loader whose `canLoad(filename)` returns true. */
export function detectLoader(filename: string): DataLoader | undefined {
  return loaders.find((l) => l.canLoad(filename));
}

/** Detect a loader for `file` and run it; throws UNSUPPORTED_FORMAT otherwise. */
export async function loadFile(file: BinaryInput, options?: LoaderOptions): Promise<LoadResult> {
  const filename =
    typeof File !== 'undefined' && file instanceof File
      ? file.name
      : (file as { name: string }).name;
  const loader = detectLoader(filename);
  if (!loader) {
    throw new LoaderError(
      'UNSUPPORTED_FORMAT',
      `Unsupported file format: ${filename}. Supported: .csv, .tsv, .geojson, .json, .zip, .shp, .xlsx, .xls, .parquet`,
    );
  }
  return loader.load(file, options);
}
