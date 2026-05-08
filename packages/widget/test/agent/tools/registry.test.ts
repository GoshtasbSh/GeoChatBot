import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { _resetRegistry, getTool, listTools, registerTool } from '../../../src/agent/tools/registry.js';
import type { ToolDef } from '../../../src/agent/tools/types.js';

const tool = (id: string): ToolDef => ({
  id, description: 'd', args: z.object({}), output_kind: 'table',
});

describe('tool registry', () => {
  afterEach(() => _resetRegistry());

  it('registers and retrieves a tool', () => {
    registerTool(tool('a.b'));
    expect(getTool('a.b')?.id).toBe('a.b');
  });

  it('throws on duplicate id', () => {
    registerTool(tool('a.b'));
    expect(() => registerTool(tool('a.b'))).toThrow(/duplicate/i);
  });

  it('returns undefined for unknown id', () => {
    expect(getTool('nope')).toBeUndefined();
  });

  it('lists all registered tools', () => {
    registerTool(tool('a'));
    registerTool(tool('b'));
    expect(listTools().map((t) => t.id).sort()).toEqual(['a', 'b']);
  });

  it('reset clears the registry (test-only)', () => {
    registerTool(tool('a'));
    _resetRegistry();
    expect(listTools()).toEqual([]);
  });
});
