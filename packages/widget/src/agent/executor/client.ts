/**
 * Main-thread client for the Phase 5 executor.
 *
 * Two execution paths:
 *
 * 1. **Worker-backed (production):** spawns the executor worker (see
 *    `./worker.ts`), wraps it via Comlink, replicates dataset Arrow IPC
 *    bytes to the worker's DuckDB instance, then forwards `execute()`.
 *
 * 2. **In-process (tests / unsupported envs):** uses the main thread's
 *    {@link DuckDBEngine} singleton + the Executor directly. This is
 *    activated automatically when `Worker` is unavailable so the test
 *    harness doesn't need a Worker polyfill.
 *
 * The two paths expose the SAME interface so the host element doesn't
 * branch on env at the call site.
 */

import { Executor } from './executor.js';
import type {
  CriticDecision,
  DatasetEntry,
  ExecutorCallbacks,
  ExecutorEngine,
  StepErrorContext,
} from './types.js';
import type { OutputRef, Plan } from '../types.js';

export interface ExecutorHandle {
  execute(plan: Plan, planId: string, callbacks?: ExecutorCallbacks): Promise<void>;
  dispose(): Promise<void>;
}

export interface InProcessOptions {
  engine: ExecutorEngine;
  datasets: DatasetEntry[];
}

/** Build an in-process executor — used in tests and when Worker is missing. */
export function createInProcessExecutor(opts: InProcessOptions): ExecutorHandle {
  const exec = new Executor({ engine: opts.engine, datasets: opts.datasets });
  return {
    execute: (plan, planId, callbacks) => exec.execute(plan, planId, callbacks),
    dispose: async () => {
      /* shared engine is owned by the caller */
    },
  };
}

/**
 * Best-effort feature check. Workers in test envs (vitest node) are absent;
 * in modern browsers they exist + Vite's `worker: { format: 'es' }` config
 * makes `new Worker(new URL(...), { type: 'module' })` work.
 */
export function canUseExecutorWorker(): boolean {
  return typeof Worker !== 'undefined' && typeof URL !== 'undefined';
}

/**
 * Spawn the worker-backed executor. The caller streams datasets in via
 * the returned handle's `registerDataset` (added by the worker wrapper).
 *
 * Returns null if Worker isn't available — the caller should fall back to
 * the in-process path. We avoid throwing here so the host element can
 * decide the strategy without a try/catch.
 */
export async function createWorkerExecutor(): Promise<WorkerExecutorHandle | null> {
  if (!canUseExecutorWorker()) return null;

  // Lazy-import Comlink + the worker URL so this codepath stays out of the
  // node test bundle entirely. Vite resolves `new Worker(new URL(..., import.meta.url))`
  // at build time and emits a sibling chunk.
  //
  // The whole spawn-and-init sequence is wrapped in a try/catch because
  // some environments (ServiceWorker scope, hardened CSP, Worker quotas
  // exceeded) may fail at the `new Worker(...)` call or during `init()`.
  // We swallow the error and return null so the host can fall back to
  // the in-process executor without the call site needing a try/catch.
  // The reason is logged for diagnosability.
  let Comlink: typeof import('comlink');
  let worker: Worker | undefined;
  try {
    Comlink = await import('comlink');
    const workerUrl = new URL('./worker.js', import.meta.url);
    worker = new Worker(workerUrl, { type: 'module' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[geochatbot] worker spawn failed; falling back to in-process executor', err);
    return null;
  }

  const remote = Comlink.wrap<RemoteWorkerApi>(worker);
  try {
    await remote.init();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[geochatbot] worker init failed; tearing down and falling back', err);
    try { worker.terminate(); } catch { /* already torn down */ }
    return null;
  }

  return {
    async registerDataset(ds) {
      return remote.registerDataset(ds);
    },
    async execute(plan, planId, callbacks) {
      const cb: ExecutorCallbacks = callbacks ?? {};
      // The worker emits an `onStepError` payload with `priorOutputs` as
      // a plain Record (see WireStepErrorContext in worker.ts). The user-
      // supplied critic expects a Map, so we wrap here. We also keep the
      // wrapped bag a fresh object so Comlink.proxy can transfer it
      // without aliasing the caller's closure.
      const wrapped: ExecutorCallbacks = { ...cb };
      if (cb.onStepError) {
        const userCritic = cb.onStepError;
        wrapped.onStepError = async (
          wire: WireStepErrorContextLike,
        ): Promise<CriticDecision | undefined> => {
          const ctx: StepErrorContext = {
            planId: wire.planId,
            step: wire.step,
            resolvedArgs: wire.resolvedArgs,
            error: wire.error,
            priorOutputs:
              wire.priorOutputs instanceof Map
                ? wire.priorOutputs
                : new Map<string, OutputRef>(Object.entries(wire.priorOutputs)),
            retryCount: wire.retryCount,
            maxRetries: wire.maxRetries,
          };
          return userCritic(ctx);
        };
      }
      // Comlink.proxy wraps callbacks so the worker can invoke them
      // back across the postMessage boundary.
      await remote.execute({ plan, planId }, Comlink.proxy(wrapped));
    },
    async dispose() {
      try {
        await remote.dispose();
      } finally {
        worker.terminate();
      }
    },
  };
}

interface RemoteWorkerApi {
  init(): Promise<void>;
  registerDataset(ds: WorkerDatasetIpc): Promise<DatasetEntry>;
  execute(req: { plan: Plan; planId: string }, cb: ExecutorCallbacks): Promise<void>;
  dispose(): Promise<void>;
}

/** What the worker accepts when registering a dataset. */
export interface WorkerDatasetIpc {
  name: string;
  bytes: ArrayBuffer;
  geometry?: import('../../data/contracts.js').GeometryEncoding;
  source: import('../../data/contracts.js').SourceFormat;
  filename: string;
}

export interface WorkerExecutorHandle extends ExecutorHandle {
  registerDataset(ds: WorkerDatasetIpc): Promise<DatasetEntry>;
}

/**
 * Mirrors `WireStepErrorContext` from `./worker.ts` without coupling
 * client.ts to the worker module (the worker is dynamically imported).
 * Either form of `priorOutputs` may arrive depending on whether
 * Comlink/structuredClone preserved the Map for this runtime.
 */
interface WireStepErrorContextLike {
  planId: string;
  step: StepErrorContext['step'];
  resolvedArgs: Record<string, unknown>;
  error: { message: string; code?: string };
  priorOutputs: Record<string, OutputRef> | ReadonlyMap<string, OutputRef>;
  retryCount: number;
  maxRetries: number;
}
