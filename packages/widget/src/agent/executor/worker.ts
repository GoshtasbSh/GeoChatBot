/**
 * Phase 5 executor Web Worker entry.
 *
 * The worker hosts a fresh DuckDB-WASM instance (independent of the main
 * thread's engine). Datasets are streamed in as Apache Arrow IPC bytes;
 * the worker registers them locally before any Plan runs.
 *
 * Comlink wraps a single object exposing `init` / `execute` / `dispose`.
 * The host page uses {@link createWorkerExecutor} from `./client.ts`.
 *
 * NOTE: When `Worker` is unavailable (test envs), the host falls back to
 * an in-process Executor — this file is never loaded in that path.
 */

import * as Comlink from 'comlink';
import { tableFromIPC } from 'apache-arrow';

import { DuckDBEngine } from '../../data/engine/DuckDBEngine.js';
import type { LoadResult } from '../../data/contracts.js';
import { Executor } from './executor.js';
import './runners/index.js';
import type {
  CriticDecision,
  DatasetEntry,
  ProgressEvent,
  ResultEvent,
  StepErrorContext,
} from './types.js';
import type { OutputRef, Plan } from '../types.js';

/**
 * Wire-form of {@link StepErrorContext} sent from the worker to the host.
 *
 * `priorOutputs` is converted from `ReadonlyMap` to a plain record because
 * Comlink's structuredClone-based marshaling preserves Maps in modern
 * runtimes but not all legacy ones; a record is a stable lowest-common-
 * denominator. The host-side proxy reconstructs the Map before forwarding
 * the context to the user-supplied critic callback.
 */
interface WireStepErrorContext {
  planId: string;
  step: StepErrorContext['step'];
  resolvedArgs: Record<string, unknown>;
  error: { message: string; code?: string };
  priorOutputs: Record<string, OutputRef>;
  retryCount: number;
  maxRetries: number;
}

/**
 * Callback bag the worker invokes back across postMessage. Comlink wraps
 * each function in a Remote, so Comlink.proxy(fn) on the host side maps
 * to a callable across the boundary.
 *
 * `onStepError` is the Phase 6 critic hook: the worker awaits the host's
 * decision before retrying or aborting. It uses the wire form above so
 * the message survives any Comlink/structuredClone variability.
 */
interface RemoteCallbacks {
  onProgress(e: ProgressEvent): void;
  onResult(e: ResultEvent): void;
  onError(e: { planId: string; stepId: string; message: string; code?: string }): void;
  onStepError?(ctx: WireStepErrorContext): Promise<CriticDecision | undefined>;
}

export interface DatasetIPC {
  /** Logical name (planner-facing). */
  name: string;
  /** Arrow IPC bytes (zero-copy transferable on postMessage). */
  bytes: ArrayBuffer;
  /** Geometry encoding so the worker can re-create the geom view. */
  geometry?: LoadResult['geometry'];
  /** Source format for engine.registerArrow. */
  source: LoadResult['source'];
  /** Original filename, kept only for messages. */
  filename: string;
}

export interface ExecuteRequest {
  plan: Plan;
  planId: string;
}

class WorkerExecutor {
  private engine = new DuckDBEngine();
  private datasets: DatasetEntry[] = [];

  async init(): Promise<void> {
    await this.engine.init();
  }

  async registerDataset(ds: DatasetIPC): Promise<DatasetEntry> {
    const table = tableFromIPC(new Uint8Array(ds.bytes));
    const result: LoadResult = {
      name: ds.name,
      table,
      source: ds.source,
      filename: ds.filename,
      ...(ds.geometry ? { geometry: ds.geometry } : {}),
    };
    const reg = await this.engine.registerArrow(result);
    const entry: DatasetEntry = {
      name: ds.name,
      tableName: reg.tableName,
      ...(reg.geomView ? { geomView: reg.geomView } : {}),
      hasGeometry: !!reg.geomView,
    };
    // Replace any prior entry with the same logical name so that
    // re-registering after a schema change behaves consistently with
    // the main-thread `_execDatasets` filter in element.ts ingest.
    this.datasets = this.datasets.filter((d) => d.name !== entry.name);
    this.datasets.push(entry);
    return entry;
  }

  async execute(
    request: ExecuteRequest,
    callbacks: Comlink.Remote<RemoteCallbacks>,
  ): Promise<void> {
    const exec = new Executor({ engine: this.engine, datasets: this.datasets });
    // Surface postMessage boundary failures: a host-side callback that
    // throws (or a torn-down channel) would otherwise be silently
    // swallowed by `void`. We log to the worker console for diagnostics.
    // We deliberately do NOT propagate the failure into `execute()` —
    // a missed UI update should not abort an in-flight plan.
    const safeProxy = <T>(fn: (e: T) => Promise<void> | void) =>
      (e: T) => {
        try {
          const r = fn(e);
          if (r && typeof (r as Promise<void>).catch === 'function') {
            (r as Promise<void>).catch((err) => {
              // eslint-disable-next-line no-console
              console.warn('[geochatbot/worker] callback rejected', err);
            });
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[geochatbot/worker] callback threw', err);
        }
      };

    // Phase 6: when the host installed an `onStepError` proxy, expose a
    // critic hook to the executor. The wire form converts ReadonlyMap to
    // a plain record; the executor passes the Map directly so we serialise
    // here and trust the host to reconstruct if needed. Errors thrown by
    // the host critic are surfaced to the executor (which already maps
    // them to "abort with CRITIC_THREW" — see executor.ts).
    //
    // Capture the proxy on a local so TypeScript can narrow it; the type
    // of an optional Comlink.Remote method is `Promise<undefined> | Fn`,
    // which isn't directly callable.
    const remoteCritic = callbacks.onStepError;
    const onStepError =
      typeof remoteCritic === 'function'
        ? async (ctx: StepErrorContext): Promise<CriticDecision | undefined> => {
            const wire: WireStepErrorContext = {
              planId: ctx.planId,
              step: ctx.step,
              resolvedArgs: ctx.resolvedArgs,
              error: ctx.error,
              priorOutputs: Object.fromEntries(ctx.priorOutputs),
              retryCount: ctx.retryCount,
              maxRetries: ctx.maxRetries,
            };
            return remoteCritic(wire);
          }
        : undefined;

    await exec.execute(request.plan, request.planId, {
      onProgress: safeProxy<ProgressEvent>((e) => callbacks.onProgress(e)),
      onResult: safeProxy<ResultEvent>((e) => callbacks.onResult(e)),
      onError: safeProxy<{ planId: string; stepId: string; message: string; code?: string }>(
        (e) => callbacks.onError(e),
      ),
      ...(onStepError ? { onStepError } : {}),
    });
  }

  async dispose(): Promise<void> {
    await this.engine.dispose();
    this.datasets = [];
  }
}

Comlink.expose(new WorkerExecutor());

export type { WorkerExecutor };
