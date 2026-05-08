/**
 * Runtime registry for Phase 5 tool runners.
 *
 * Parallel to {@link ../tools/registry.ts} which holds the LLM-facing
 * {@link ToolDef}s. Splitting the two registries keeps the planner
 * surface (zod arg schema + description) clean of execution code, and
 * lets the worker import only the runtime side.
 */

import type { RuntimeRunner } from './types.js';

const runners = new Map<string, RuntimeRunner>();

export function registerRunner(toolId: string, runner: RuntimeRunner): void {
  if (runners.has(toolId)) {
    throw new Error(`Duplicate runner for tool: ${toolId}`);
  }
  runners.set(toolId, runner);
}

export function getRunner(toolId: string): RuntimeRunner | undefined {
  return runners.get(toolId);
}

export function listRunners(): string[] {
  return [...runners.keys()];
}

/** Test-only: clear the registry so per-test side-effect imports re-register cleanly. */
export function _resetRunnerRegistry(): void {
  runners.clear();
}
