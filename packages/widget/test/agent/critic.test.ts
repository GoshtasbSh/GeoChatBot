import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Critic } from '../../src/agent/critic.js';
import { _resetRegistry, registerTool } from '../../src/agent/tools/registry.js';
import { z } from 'zod';
import type { Step, OutputRef } from '../../src/agent/types.js';
import type { StepErrorContext } from '../../src/agent/executor/types.js';

function makeCtx(overrides: Partial<StepErrorContext> = {}): StepErrorContext {
  const failing: Step = {
    id: 's1',
    tool: 'sql',
    args: { query: 'SELECT * FROM points' },
    output_var: 'a',
    why: 'pre-filter',
  };
  return {
    planId: 'p',
    step: failing,
    resolvedArgs: failing.args,
    error: { message: 'boom' },
    priorOutputs: new Map<string, OutputRef>(),
    retryCount: 0,
    maxRetries: 2,
    ...overrides,
  };
}

beforeEach(() => {
  _resetRegistry();
  // Register a minimal tool so the critic-side validator has something to
  // look up. The Critic itself does NOT validate the patched step against
  // the tool args schema — that's the executor's job (Task 1) — but it DOES
  // validate the response shape against CriticDecision.
  registerTool({
    id: 'sql',
    description: 'sql',
    args: z.object({ query: z.string() }),
    output_kind: 'table',
  });
});

describe('Critic', () => {
  it('returns retry when LLM responds {action: "retry"}', async () => {
    const llm = vi.fn().mockResolvedValue({ action: 'retry' });
    const critic = new Critic({ apiKey: 'k', model: 'm', datasets: [], llmCall: llm });
    const decision = await critic.diagnose(makeCtx());
    expect(decision).toEqual({ action: 'retry' });
  });

  it('returns abort when LLM responds {action: "abort"}', async () => {
    const llm = vi.fn().mockResolvedValue({ action: 'abort', reason: 'no recoverable path' });
    const critic = new Critic({ apiKey: 'k', model: 'm', datasets: [], llmCall: llm });
    const decision = await critic.diagnose(makeCtx());
    expect(decision).toEqual({ action: 'abort' });
  });

  it('returns patch with the proposed step when LLM responds {action: "patch", patchedStep}', async () => {
    const patched = {
      id: 's1',
      tool: 'sql',
      args: { query: 'SELECT * FROM points LIMIT 10' },
      output_var: 'a',
      why: 'fix LIMIT',
    };
    const llm = vi.fn().mockResolvedValue({ action: 'patch', patchedStep: patched });
    const critic = new Critic({ apiKey: 'k', model: 'm', datasets: [], llmCall: llm });
    const decision = await critic.diagnose(makeCtx());
    expect(decision).toEqual({ action: 'patch', patchedStep: patched });
  });

  it('coerces a malformed LLM response to abort', async () => {
    const llm = vi.fn().mockResolvedValue({ action: 'unknown_action' });
    const critic = new Critic({ apiKey: 'k', model: 'm', datasets: [], llmCall: llm });
    const decision = await critic.diagnose(makeCtx());
    expect(decision).toEqual({ action: 'abort' });
  });

  it('coerces patch with mismatching step id to abort', async () => {
    const patched = {
      id: 's999',
      tool: 'sql',
      args: { query: 'SELECT 1' },
      why: 'wrong id',
    };
    const llm = vi.fn().mockResolvedValue({ action: 'patch', patchedStep: patched });
    const critic = new Critic({ apiKey: 'k', model: 'm', datasets: [], llmCall: llm });
    const decision = await critic.diagnose(makeCtx());
    expect(decision).toEqual({ action: 'abort' });
  });

  it('coerces patch with malformed step shape to abort', async () => {
    const llm = vi.fn().mockResolvedValue({ action: 'patch', patchedStep: { id: 's1' /* missing tool/args/why */ } });
    const critic = new Critic({ apiKey: 'k', model: 'm', datasets: [], llmCall: llm });
    const decision = await critic.diagnose(makeCtx());
    expect(decision).toEqual({ action: 'abort' });
  });

  it('returns abort when the LLM call rejects', async () => {
    const llm = vi.fn().mockRejectedValue(new Error('rate limited'));
    const critic = new Critic({ apiKey: 'k', model: 'm', datasets: [], llmCall: llm });
    const decision = await critic.diagnose(makeCtx());
    expect(decision).toEqual({ action: 'abort' });
  });

  it('passes the failing step into the user message via the builder', async () => {
    const llm = vi.fn().mockResolvedValue({ action: 'retry' });
    const critic = new Critic({ apiKey: 'k', model: 'm', datasets: [], llmCall: llm });
    await critic.diagnose(makeCtx());
    const arg = llm.mock.calls[0]![0];
    expect(arg.userMessage).toMatch(/Failed step/);
    expect(arg.userMessage).toMatch(/"id": "s1"/);
  });

  it('respects an injected AbortSignal by passing it to the LLM caller', async () => {
    const ac = new AbortController();
    const llm = vi.fn().mockResolvedValue({ action: 'retry' });
    const critic = new Critic({ apiKey: 'k', model: 'm', datasets: [], llmCall: llm });
    await critic.diagnose(makeCtx(), ac.signal);
    expect(llm.mock.calls[0]![0].signal).toBe(ac.signal);
  });

  it('only validates id+shape — leaves per-tool args validation to the executor', async () => {
    // Args don't satisfy SqlArgs (missing query), but the Critic still
    // returns a patch decision. Executor Task 1 catches this.
    const llm = vi.fn().mockResolvedValue({
      action: 'patch',
      patchedStep: { id: 's1', tool: 'sql', args: { not_query: 'oops' }, why: 'p' },
    });
    const critic = new Critic({ apiKey: 'k', model: 'm', datasets: [], llmCall: llm });
    const decision = await critic.diagnose(makeCtx());
    expect(decision).toMatchObject({ action: 'patch' });
  });
});
