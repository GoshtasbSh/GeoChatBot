/**
 * Critic — wraps callCriticLLM and the user-message builder to diagnose a
 * failed executor step and return a CriticDecision.
 *
 * Any LLM error or schema mismatch is silently converted to `{action: 'abort'}`
 * so the executor always makes forward progress even if Anthropic is offline.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { callCriticLLM, type CriticLLMInput } from './critic-llm.js';
import { buildCriticUserMessage } from './prompts/critic-builders.js';
import type { ProviderId } from './forced-tool/index.js';
import type { DatasetProfile } from './prompts/builders.js';
import { renderToolsBlock } from './prompts/builders.js';
import { StepSchema, type Step } from './types.js';
import type { CriticDecision, StepErrorContext } from './executor/types.js';
import criticSystemTemplate from './prompts/critic.system.md?raw';

export class CriticError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'CriticError';
    if (cause !== undefined) this.cause = cause;
  }
}

type LlmCallFn = (input: CriticLLMInput) => Promise<Record<string, unknown>>;

export interface CriticOptions {
  /** LLM provider id. Defaults to 'anthropic' for backwards compat. */
  provider?: ProviderId;
  apiKey: string;
  model: string;
  /** Planner-side dataset profiles, used to ground the prompt. */
  datasets: DatasetProfile[];
  llmCall?: LlmCallFn;
  dangerouslyAllowBrowser?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Decision schema                                                             */
/* -------------------------------------------------------------------------- */

const CriticDecisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('patch'), patchedStep: StepSchema }),
  z.object({ action: z.literal('retry') }),
  z.object({ action: z.literal('abort'), reason: z.string().optional() }),
]);

/* -------------------------------------------------------------------------- */
/* Critic class                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Critic — receives an executor `StepErrorContext` and returns a
 * `CriticDecision`. Designed to be called from `Executor`'s `onStepError`
 * callback; one diagnose() per failed attempt.
 *
 * Errors during the LLM call are intentionally swallowed and converted
 * to `{ action: 'abort' }` — the executor must always make progress
 * even if Anthropic is offline.
 */
export class Critic {
  private readonly opts: CriticOptions;
  /** Cached system prefix — built once in the constructor; identical across calls. */
  private readonly cachedSystemPrompt: string;
  /** JSON-Schema for the submit_diagnosis tool input. */
  private readonly toolInputSchema: Record<string, unknown>;

  constructor(opts: CriticOptions) {
    this.opts = opts;
    this.cachedSystemPrompt = criticSystemTemplate.replace(
      '{{tools_block}}',
      renderToolsBlock(),
    );
    this.toolInputSchema = zodToJsonSchema(CriticDecisionSchema, {
      target: 'openApi3',
    }) as Record<string, unknown>;
  }

  async diagnose(
    ctx: StepErrorContext,
    signal?: AbortSignal,
  ): Promise<CriticDecision> {
    const llm = this.opts.llmCall ?? callCriticLLM;

    const userMessage = buildCriticUserMessage({
      step: ctx.step,
      resolvedArgs: ctx.resolvedArgs,
      errorMessage: ctx.error.message,
      priorOutputs: ctx.priorOutputs,
      retryCount: ctx.retryCount,
      maxRetries: ctx.maxRetries,
      datasets: this.opts.datasets,
    });

    const input: CriticLLMInput = {
      apiKey: this.opts.apiKey,
      model: this.opts.model,
      cachedSystemPrompt: this.cachedSystemPrompt,
      systemPrompt: '',
      userMessage,
      toolInputSchema: this.toolInputSchema,
      temperature: 0,
      maxTokens: 1024,
    };
    if (this.opts.provider !== undefined) input.provider = this.opts.provider;
    if (signal !== undefined) input.signal = signal;
    if (this.opts.dangerouslyAllowBrowser !== undefined) {
      input.dangerouslyAllowBrowser = this.opts.dangerouslyAllowBrowser;
    }

    let raw: Record<string, unknown>;
    try {
      raw = await llm(input);
    } catch (err) {
      // Cancellations must propagate so the host element's clear() / new
      // ask() flow can tear down the in-flight executor cleanly. Swallowing
      // an AbortError here would convert "user navigated away" into a
      // silent abort decision, then onError would fire with the original
      // step error — confusing and hard to debug.
      if (isAbortError(err)) throw err;
      return { action: 'abort' };
    }

    return parseDecision(raw, ctx.step.id);
  }
}

/* -------------------------------------------------------------------------- */
/* Decision parser                                                             */
/* -------------------------------------------------------------------------- */

/**
 * True for both browser AbortError DOMExceptions and Node-style AbortError
 * subclasses. Used so cancellations escape `diagnose`'s catch instead of
 * being mapped to `{action: 'abort'}`.
 */
function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError';
}

function parseDecision(raw: unknown, expectedStepId: string): CriticDecision {
  const parsed = CriticDecisionSchema.safeParse(raw);
  if (!parsed.success) return { action: 'abort' };

  const data = parsed.data;

  if (data.action === 'patch') {
    if (data.patchedStep.id !== expectedStepId) {
      // Mismatched id — fail safe.
      return { action: 'abort' };
    }
    return { action: 'patch', patchedStep: data.patchedStep as Step };
  }

  if (data.action === 'retry') return { action: 'retry' };

  // action === 'abort' — drop the optional reason to match CriticDecision type
  return { action: 'abort' };
}
