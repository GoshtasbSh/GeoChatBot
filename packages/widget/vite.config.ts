import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * Builds two self-contained artifacts from a single entry:
 *   - dist/geochatbot.js      (ESM, importable via <script type="module">)
 *   - dist/geochatbot.umd.cjs (UMD, exposes window.GeoChatBot)
 *
 * Every npm dep (lit, deck.gl, maplibre-gl, loaders.gl, apache-arrow, jszip)
 * is bundled in. Only @duckdb/duckdb-wasm worker/wasm chunks are emitted
 * as siblings (via dynamic imports) — they load on demand at runtime.
 */
export default defineConfig({
  build: {
    target: 'es2022',
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'GeoChatBot',
      fileName: (format) => (format === 'es' ? 'geochatbot.js' : `geochatbot.${format}.cjs`),
      formats: ['es', 'umd'],
    },
    sourcemap: true,
    rollupOptions: {
      // Bundle all deps. Empty externals list -> single-file artifact.
      external: [],
      output: {
        // Keep DuckDB-WASM dynamic worker/wasm chunks as siblings.
        inlineDynamicImports: false,
      },
    },
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm'],
  },
  server: {
    headers: {
      // DuckDB-WASM benefits from cross-origin isolation for SharedArrayBuffer.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
