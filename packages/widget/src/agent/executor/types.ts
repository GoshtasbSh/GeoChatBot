/**
 * Phase 5 executor types.
 *
 * The executor walks a {@link Plan}, dispatches each step to its registered
 * runtime runner, threads the substitute / output-ref state, and surfaces
 * progress + render results via callbacks.
 *
 * All non-render tools execute against a shared {@link ExecutorEngine}
 * (DuckDB-WASM in production, an in-memory stub in tests). Their outputs
 * are stored as DuckDB views — `OutputRef.ref` carries the view name.
 * Renderers consume those views and emit payloads suitable for both the
 * full-mode UI and the headless `result` event.
 */

import type { Table as ArrowTable } from "apache-arrow";
import type { OutputRef, Step, ToolOutputKind } from "../types.js";

/** Per-dataset metadata available to runners. */
export interface DatasetEntry {
	/** Logical name as the planner sees it (e.g. `sales`). */
	name: string;
	/** DuckDB table holding raw columns. */
	tableName: string;
	/** DuckDB view exposing the table + a `geom` column (if geometry is loaded). */
	geomView?: string;
	/** True when `geomView` exists and queries can rely on a `geom` column. */
	hasGeometry: boolean;
}

/** Subset of {@link DuckDBEngine} the executor depends on. Tests stub this. */
export interface ExecutorEngine {
	query(sql: string): Promise<ArrowTable>;
	hasSpatial: boolean;
}

/** Execution context handed to every runner. */
export interface ExecCtx {
	/** Plan id for correlation in events. */
	planId: string;
	/** Step currently executing. */
	step: Step;
	/** Engine handle for SQL / spatial work. */
	engine: ExecutorEngine;
	/** Datasets registered through the widget's ingest path. */
	datasets: Map<string, DatasetEntry>;
	/** Outputs from previous steps; populated as the executor advances. */
	outputs: Map<string, OutputRef>;
	/** Mint a fresh, deterministic-looking view name for a step output. */
	newView(prefix: string): string;
	/**
	 * Optional abort signal forwarded from the host (e.g. element.ts's
	 * `_execAbort`). Runners that perform external I/O — geocoder fetch,
	 * future tile fetch — should pass this to `fetch()` so the user's
	 * "Stop" button can interrupt long-running operations promptly.
	 */
	signal?: AbortSignal;
	/**
	 * Optional callback for runners to report fine-grained progress within
	 * a single step (e.g. geocode address 47/318). The message is a short
	 * human-readable string. The host routes it to the status overlay.
	 */
	onSubProgress?: (message: string) => void;
}

/** Headless-equivalent payload for `render.*` runners. */
export type ResultPayload =
	| {
			kind: "layer";
			/** GeoJSON FeatureCollection. */
			geojson: { type: "FeatureCollection"; features: unknown[] };
			/** Optional layer name; defaults to the source view. */
			name?: string;
			/** Optional MapLibre style hints. */
			style?: Record<string, unknown>;
	  }
	| {
			kind: "chart";
			spec: {
				kind: "bar" | "line" | "scatter" | "pie" | "grouped_bar";
				x: string;
				y: string;
				group?: string;
				data: ReadonlyArray<Record<string, unknown>>;
			};
	  }
	| {
			kind: "table";
			rows: ReadonlyArray<Record<string, unknown>>;
			columns: ReadonlyArray<string>;
	  }
	| {
			kind: "summary";
			text: string;
	  };

/** What a runner returns. */
export interface RunnerResult {
	/** OutputRef stored under `step.output_var` if present. */
	output: OutputRef;
	/** Render payload — only for render.* tools. */
	payload?: ResultPayload;
}

/** Pure runtime function for a single tool id. Args are already substituted. */
export type RuntimeRunner = (
	args: Record<string, unknown>,
	ctx: ExecCtx,
) => Promise<RunnerResult>;

/** Progress event mirrored on the host element. */
export interface ProgressEvent {
	planId: string;
	stepId: string;
	status: "running" | "success" | "fail";
	durationMs?: number;
	error?: string;
}

/** Result event (one per render.* step). */
export type ResultEvent = ResultPayload & {
	planId: string;
	stepId: string;
};

/**
 * Phase 6 critic-decision returned from {@link ExecutorCallbacks.onStepError}.
 *
 *   - `'patch'`  — replace the failed step with `patchedStep` and re-execute.
 *                  The patched step MUST have the same id; tool/args may
 *                  change. Patched `sql` steps are re-validated by the
 *                  runner (validate-sql.ts) before execution.
 *   - `'retry'`  — re-run the same step (no changes). Useful when a runner
 *                  failure was transient.
 *   - `'abort'`  — give up; halt as today.
 *
 * Either action consumes one slot from the per-step retry budget
 * ({@link ExecutorOptions.maxRetries}, default 2 per PLAN.md §6).
 */
export type CriticDecision =
	| { action: "patch"; patchedStep: import("../types.js").Step }
	| { action: "retry" }
	| { action: "abort" };

/** Argument bag passed to {@link ExecutorCallbacks.onStepError}. */
export interface StepErrorContext {
	planId: string;
	step: import("../types.js").Step;
	/** Args after `${var}` substitution — what the runner actually saw. */
	resolvedArgs: Record<string, unknown>;
	error: { message: string; code?: string };
	/**
	 * Snapshot of all prior step outputs available at the time of failure.
	 * Lets a critic build its prompt without needing access to the
	 * Executor's internal Map.
	 */
	priorOutputs: ReadonlyMap<string, import("../types.js").OutputRef>;
	/** How many times this step has been retried/patched so far (0 on first failure). */
	retryCount: number;
	/** Maximum retries permitted by the executor for this step. */
	maxRetries: number;
}

/** Callback bag the host element supplies to {@link Executor.execute}. */
export interface ExecutorCallbacks {
	onProgress?: (e: ProgressEvent) => void;
	/** Sub-step progress from long-running runners (e.g. geocode batch). */
	onSubProgress?: (message: string) => void;
	onResult?: (e: ResultEvent) => void;
	onError?: (e: {
		planId: string;
		stepId: string;
		message: string;
		code?: string;
	}) => void;
	/**
	 * Phase 6 hook: invoked when a step throws. A critic implementation may
	 * inspect prior outputs and either patch / retry / abort. Returning
	 * `undefined` (or omitting the callback) is equivalent to `'abort'`.
	 */
	onStepError?: (ctx: StepErrorContext) => Promise<CriticDecision | undefined>;
}

/** Convenience predicate for branching on output kind. */
export function isLayerKind(k: ToolOutputKind): boolean {
	return k === "layer";
}
