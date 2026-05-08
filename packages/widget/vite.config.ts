import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * Builds two artifacts from a single entry point:
 *
 *   dist/geochatbot.js        — ESM with code-split lazy chunks.
 *                               Heavy deps (MapLibre, deck.gl, loaders) are
 *                               loaded on demand; the entry chunk stays lean.
 *
 *   dist/geochatbot.umd.cjs   — UMD, fully monolithic (inlined). UMD cannot
 *                               emit sibling chunks, so all deps are bundled
 *                               in. Use this for simple <script> CDN drops.
 *
 * Lit, apache-arrow, and the DuckDB-WASM JS bindings are bundled in both
 * artifacts. The duckdb-wasm worker/WASM blobs are always fetched at runtime
 * (they're emitted as sibling files by the DuckDB package itself).
 */
export default defineConfig({
  build: {
    target: 'es2022',
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'GeoChatBot',
      // formats is overridden by rollupOptions.output below; keep in sync.
      formats: ['es', 'umd'],
      fileName: (format) => (format === 'es' ? 'geochatbot.js' : `geochatbot.${format}.cjs`),
    },
    sourcemap: true,
    rollupOptions: {
      // Bundle all deps; empty externals = single self-contained artifact.
      external: [],
      output: [
        {
          // ESM — code splitting enabled so lazy-imported chunks land as
          // sibling files (MapView, each loader, etc.).
          format: 'es',
          entryFileNames: 'geochatbot.js',
          chunkFileNames: '[name]-[hash].js',
          inlineDynamicImports: false,
        },
        {
          // UMD — Rollup forbids multi-chunk UMD output, so all dynamic
          // imports are inlined here. This bundle is larger but self-contained
          // and works with a plain <script> tag and window.GeoChatBot.
          format: 'umd',
          name: 'GeoChatBot',
          entryFileNames: 'geochatbot.umd.cjs',
          inlineDynamicImports: true,
        },
      ],
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
