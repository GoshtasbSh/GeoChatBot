import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // Use the widget's TS source directly during dev so changes hot-reload.
      '@geochatbot/widget': resolve(__dirname, '../widget/src/index.ts'),
    },
  },
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm'],
  },
  worker: { format: 'es' },
  server: {
    port: 5174,
    headers: {
      // Required for DuckDB-WASM SharedArrayBuffer multithreading.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
