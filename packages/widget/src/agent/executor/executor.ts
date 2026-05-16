/**
 * Phase 5 Executor — sequential step runner.
 *
 * Walks a {@link Plan} step-by-step, threading {@link OutputRef}s
 * through {@link substitute}, dispatching to runtime runners, and
 * surfacing progress / result events via callbacks.
 *
 * The Executor itself is environment-agnostic. In production it is
 * spawned inside a Web Worker via Comlink (see {@link ./worker.ts});
 * tests instantiate it on the main thread directly.
 */

import { substitute } from "../substitute.js";
import { getTool } from "../tools/registry.js";
import { StepSchema } from "../types.js";
import type { OutputRef, Plan, Step } from "../types.js";
import { getRunner } from "./runtime.js";
import { quoteIdent } from "./sql-helpers.js";
import type {
	CriticDecision,
	DatasetEntry,
	ExecCtx,
	ExecutorCallbacks,
	ExecutorEngine,
} from "./types.js";

export interface ExecutorOptions {
	engine: ExecutorEngine;
	/** Datasets the planner sees; resolves logical names to DuckDB views. */
	datasets: DatasetEntry[];
	/**
	 * Maximum critic-driven retries per step (PLAN.md §6: "max 2 retries").
	 * `0` disables Phase 6 critic re-entry entirely.
	 */
	maxRetries?: number;
}

/** Thrown by the executor when a step has no registered runner. */
export class MissingRunnerError extends Error {
	// Stable code that survives the executor's err->errorPayload extraction
	// (which prefers a `.code` field over `.name`). Lets the host UI
	// distinguish a hallucinated tool name from any other runner failure.
	readonly code = "MISSING_RUNNER" as const;
	constructor(
		public readonly stepId: string,
		public readonly tool: string,
	) {
		super(`no runner registered for tool ${tool} (step ${stepId})`);
		this.name = "MissingRunnerError";
	}
}

export class Executor {
	private readonly engine: ExecutorEngine;
	private readonly datasets: Map<string, DatasetEntry>;
	private readonly maxRetries: number;
	private viewCounter = 0;

	constructor(opts: ExecutorOptions) {
		this.engine = opts.engine;
		this.datasets = new Map(opts.datasets.map((d) => [d.name, d]));
		this.maxRetries = Math.max(0, opts.maxRetries ?? 2);
	}

	/**
	 * Execute a Plan to completion. Resolves once the last step finishes
	 * (success OR fail). Never throws — errors are surfaced via
	 * {@link ExecutorCallbacks.onError}.
	 */
	async execute(
		plan: Plan,
		planId: string,
		callbacks: ExecutorCallbacks = {},
		signal?: AbortSignal,
	): Promise<void> {
		const outputs = new Map<string, OutputRef>();

		for (const initialStep of plan.steps) {
			const halted = await this._runStepWithRetries(
				initialStep,
				planId,
				outputs,
				callbacks,
				signal,
			);
			if (halted) return; // first step that aborts terminates the whole plan
		}
	}

	/**
	 * Run a single step with critic-driven retry semantics. Returns `true`
	 * when the plan should halt (terminal failure) and `false` when the
	 * plan may continue to the next step. The {@link ExecutorCallbacks.onStepError}
	 * hook is invoked on every failure up to {@link maxRetries} attempts.
	 */
	private async _runStepWithRetries(
		initialStep: Step,
		planId: string,
		outputs: Map<string, OutputRef>,
		callbacks: ExecutorCallbacks,
		signal?: AbortSignal,
	): Promise<boolean> {
		let step = initialStep;
		let retryCount = 0;
		// Loop bound: one initial attempt + up to maxRetries retries.
		// The +1 is the first attempt; subsequent iterations are critic-driven.
		while (true) {
			const startedAt = nowMs();
			callbacks.onProgress?.({ planId, stepId: step.id, status: "running" });

			// Substituted args are computed up-front because the catch path
			// below reports them to the critic. Substitution does not throw.
			const resolvedArgs = substitute(step.args, outputs) as Record<
				string,
				unknown
			>;
			const ctx: ExecCtx = {
				planId,
				step,
				engine: this.engine,
				datasets: this.datasets,
				outputs,
				newView: (prefix) => this.mintView(step, prefix),
				...(signal ? { signal } : {}),
				...(callbacks.onSubProgress
					? { onSubProgress: callbacks.onSubProgress }
					: {}),
			};

			try {
				// Look up the runner inside the try so a missing tool routes
				// through the Phase 6 critic path: a hallucinated tool name
				// gets a chance to be patched to a valid one within the retry
				// budget, instead of hard-halting the plan. The catch clause
				// below calls onStepError with the resolved args, retry count,
				// and prior outputs; the critic can return a 'patch' decision
				// that swaps the tool to a real one.
				const runner = getRunner(step.tool);
				if (!runner) throw new MissingRunnerError(step.id, step.tool);
				const result = await runner(resolvedArgs, ctx);
				if (step.output_var !== undefined) {
					outputs.set(step.output_var, result.output);
					// Also expose the output as a DuckDB temporary view named
					// exactly `output_var`. Lets a subsequent `sql` step write
					// `FROM <output_var>` directly inside its query body — partial-
					// string `${var}` substitution is deliberately disabled
					// (substitute.ts WHOLE_STRING_VAR) for SQL-injection safety,
					// so without this alias there is no way to reference a prior
					// step's output inside a SQL body. Output_var is zod-validated
					// to `^[a-z_][a-z0-9_]*$`, so quoting via quoteIdent (which
					// also length-caps + NUL-rejects) is paranoid-safe.
					// We only alias `layer`/`table` outputs — `scalar`/`rendered`
					// have no view to wrap.
					if (
						(result.output.kind === "layer" ||
							result.output.kind === "table") &&
						typeof result.output.ref === "string"
					) {
						try {
							await this.engine.query(
								`CREATE OR REPLACE TEMPORARY VIEW ${quoteIdent(step.output_var)} AS ` +
									`SELECT * FROM ${quoteIdent(result.output.ref)}`,
							);
						} catch {
							// Engines without spatial / older DuckDB may reject the
							// alias creation under edge cases. Fall back silently —
							// the output is still in the outputs Map and downstream
							// steps using ${var} substitution will still work; only
							// the bare-name access path is unavailable.
						}
					}
				}
				if (result.payload) {
					callbacks.onResult?.({ planId, stepId: step.id, ...result.payload });
				}
				callbacks.onProgress?.({
					planId,
					stepId: step.id,
					status: "success",
					durationMs: nowMs() - startedAt,
				});
				return false; // success — continue to next step
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const code =
					err && typeof err === "object" && "code" in (err as object)
						? String((err as { code: unknown }).code)
						: err instanceof Error
							? err.name
							: undefined;
				const errorPayload = code
					? { planId, stepId: step.id, message, code }
					: { planId, stepId: step.id, message };
				const failureProgress = {
					planId,
					stepId: step.id,
					status: "fail" as const,
					durationMs: nowMs() - startedAt,
					error: message,
				};

				// Phase 6 critic hook. If the host did not provide one, or we have
				// already used the retry budget, surface the failure terminally.
				const canRetry =
					retryCount < this.maxRetries && !!callbacks.onStepError;
				if (!canRetry) {
					callbacks.onError?.(errorPayload);
					callbacks.onProgress?.(failureProgress);
					return true;
				}

				// Always announce the failure to listeners before consulting the
				// critic — the UI may want to show "step failed, asking critic…"
				// before any patched step starts.
				callbacks.onProgress?.(failureProgress);

				let decision: CriticDecision | undefined;
				try {
					decision = await callbacks.onStepError?.({
						planId,
						step,
						resolvedArgs,
						error: code ? { message, code } : { message },
						priorOutputs: outputs,
						retryCount,
						maxRetries: this.maxRetries,
					});
				} catch (criticErr) {
					// A throwing critic is treated as "abort" — we report the
					// ORIGINAL step error (not the critic error) to onError so
					// the user sees the underlying failure. The critic error is
					// attached via `code` for diagnostics.
					callbacks.onError?.({
						...errorPayload,
						code: criticErr instanceof Error ? criticErr.name : "CRITIC_THREW",
					});
					return true;
				}

				if (!decision || decision.action === "abort") {
					callbacks.onError?.(errorPayload);
					return true;
				}

				if (decision.action === "patch") {
					const patched = decision.patchedStep;
					if (patched.id !== step.id) {
						// A critic that swaps the id would silently corrupt the plan;
						// refuse and abort.
						callbacks.onError?.({
							...errorPayload,
							code: "CRITIC_PATCH_INVALID",
							message: `critic returned patched step with id ${patched.id} (expected ${step.id})`,
						});
						return true;
					}
					// Re-validate the patched step against the schema. This closes
					// the gap where a critic could synthesize a malformed step
					// (e.g. tool name with a forbidden character, missing why).
					// SQL bodies are re-validated by the runner itself
					// (validate-sql.ts in runners/sql.ts), so DDL/DML cannot slip
					// back in via critic patches.
					const parsed = StepSchema.safeParse(patched);
					if (!parsed.success) {
						callbacks.onError?.({
							...errorPayload,
							code: "CRITIC_PATCH_INVALID",
							message: `critic patched step failed validation: ${parsed.error.message}`,
						});
						return true;
					}
					// Phase 5 alignment: also validate args against the tool's zod
					// schema, matching what validatePlan() does for planner output
					// (see validate-plan.ts:38-49). Without this, a patched step
					// with malformed args would burn a retry slot at runner-time
					// and surface as a generic ZodError instead of the precise
					// CRITIC_PATCH_INVALID code the host already handles.
					const tool = getTool(parsed.data.tool);
					if (!tool) {
						callbacks.onError?.({
							...errorPayload,
							code: "CRITIC_PATCH_INVALID",
							message: `critic patched step references unknown tool: ${parsed.data.tool}`,
						});
						return true;
					}
					const argRes = tool.args.safeParse(parsed.data.args);
					if (!argRes.success) {
						callbacks.onError?.({
							...errorPayload,
							code: "CRITIC_PATCH_INVALID",
							message: `critic patched step args failed schema: ${argRes.error.message}`,
						});
						return true;
					}
					step = parsed.data;
				}
				// 'retry' falls through with the current step unchanged.
				retryCount++;
			}
		}
	}

	private mintView(step: Step, prefix: string): string {
		this.viewCounter++;
		const safePrefix = prefix.replace(/[^a-z0-9_]/gi, "_");
		return `gcb_${safePrefix}_${step.id}_${this.viewCounter}`;
	}
}

function nowMs(): number {
	return typeof performance !== "undefined" &&
		typeof performance.now === "function"
		? performance.now()
		: Date.now();
}
