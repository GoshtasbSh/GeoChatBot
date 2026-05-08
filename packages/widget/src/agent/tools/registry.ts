import type { ToolDef } from './types.js';

const tools = new Map<string, ToolDef>();

export function registerTool(t: ToolDef): void {
  if (tools.has(t.id)) {
    throw new Error(`Duplicate tool id: ${t.id}`);
  }
  tools.set(t.id, t);
}

export function getTool(id: string): ToolDef | undefined {
  return tools.get(id);
}

export function listTools(): ToolDef[] {
  return [...tools.values()];
}

/** Test-only: reset the registry between tests. Not exported from the public package. */
export function _resetRegistry(): void {
  tools.clear();
}
