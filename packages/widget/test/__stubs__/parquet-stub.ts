/**
 * Vitest stub for `@loaders.gl/parquet`.
 *
 * The real package ships a Node-only buffer polyfill (.node native addon)
 * that fails to resolve under Vitest's ESM loader. Tests do not exercise
 * parquet parsing, so we expose a no-op ParquetLoader here. The vitest
 * config aliases `@loaders.gl/parquet` to this file.
 *
 * Phase 1 follow-up: replace with a proper resolver config so the real
 * loader is exercised in tests that need it.
 */

export const ParquetLoader = {
	id: "parquet",
	name: "Parquet (stub)",
	module: "parquet",
	version: "0.0.0",
	extensions: ["parquet"],
	mimeTypes: ["application/x-parquet"],
	parse: async () => {
		throw new Error("ParquetLoader is stubbed in test environment.");
	},
};
