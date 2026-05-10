import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			// `@loaders.gl/parquet` ships a Node-only buffer polyfill (.node addon)
			// that fails to resolve under Vitest's ESM loader. Stub it for tests so
			// any module in the loaders import graph (csv, geojson, element, etc.)
			// can be loaded. Phase 1 will replace this with proper resolver config.
			"@loaders.gl/parquet": resolve(
				__dirname,
				"test/__stubs__/parquet-stub.ts",
			),
		},
	},
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		exclude: ["**/node_modules/**", "test/loaders/parquet.test.ts"],
		reporters: ["default"],
		setupFiles: [
			"test/__stubs__/drag-event-polyfill.ts",
			"test/__stubs__/indexeddb-polyfill.ts",
			"test/__stubs__/embedder-polyfill.ts",
		],
	},
});
