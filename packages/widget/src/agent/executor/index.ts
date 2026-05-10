/**
 * Phase 5 executor — public surface.
 *
 * Importing this module also registers all built-in runners as a side effect.
 */

import "./runners/index.js";

export { Executor, MissingRunnerError } from "./executor.js";
export type { ExecutorOptions } from "./executor.js";
export type {
	CriticDecision,
	DatasetEntry,
	ExecCtx,
	ExecutorEngine,
	ExecutorCallbacks,
	ProgressEvent,
	ResultEvent,
	ResultPayload,
	RunnerResult,
	RuntimeRunner,
	StepErrorContext,
} from "./types.js";
export { registerRunner, getRunner, listRunners } from "./runtime.js";
