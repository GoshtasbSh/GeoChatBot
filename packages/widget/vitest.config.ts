import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // @loaders.gl/parquet ships a Node buffer polyfill that fails to resolve
    // under Vitest's ESM loader. Quarantined until a proper resolver alias
    // is added in Phase 1.
    exclude: ['**/node_modules/**', 'test/loaders/parquet.test.ts'],
    reporters: ['default'],
  },
});
