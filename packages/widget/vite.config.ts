import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    target: 'es2022',
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'GeoChatBot',
      fileName: (format) => format === 'es' ? 'geochatbot.js' : `geochatbot.${format}.cjs`,
      formats: ['es', 'umd'],
    },
    sourcemap: true,
    rollupOptions: {
      // DuckDB-WASM ships its own workers/wasm; let Vite copy them via dynamic imports.
      output: {
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
