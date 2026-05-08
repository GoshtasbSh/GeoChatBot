import { DuckDBEngine } from './DuckDBEngine.js';

export { DuckDBEngine } from './DuckDBEngine.js';

let singleton: DuckDBEngine | undefined;

/** Process-wide singleton accessor. */
export function getEngine(): DuckDBEngine {
  if (!singleton) singleton = new DuckDBEngine();
  return singleton;
}

/** Test helper: drop the singleton (does NOT dispose; caller must dispose first). */
export function __resetEngineForTests(): void {
  singleton = undefined;
}
