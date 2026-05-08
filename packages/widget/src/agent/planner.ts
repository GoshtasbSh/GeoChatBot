import { zodToJsonSchema } from 'zod-to-json-schema';
import { callPlannerLLM, type PlannerLLMInput } from './llm.js';
import type { DatasetProfile } from './prompts/builders.js';
import { renderDatasetsBlock, renderToolsBlock, renderPrompt } from './prompts/builders.js';
import { renderExamplesBlock } from './prompts/examples.js';
import { PlanSchema, type Plan } from './types.js';
import { validatePlan, PlanValidationError } from './validate-plan.js';

export class PlannerError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'PlannerError';
    if (cause !== undefined) this.cause = cause;
  }
}

type LlmCallFn = (input: PlannerLLMInput) => Promise<Record<string, unknown>>;

export interface PlannerOptions {
  apiKey: string;
  model: string;
  llmCall?: LlmCallFn;
  dangerouslyAllowBrowser?: boolean;
}

export interface PlanRequest {
  question: string;
  datasets: DatasetProfile[];
  feedback?: string;
}

const TOOL_NAME = 'submit_plan';
const TOOL_DESC = "Submit a typed Plan that decomposes the user's question into 1-10 tool calls.";

export class Planner {
  private readonly opts: PlannerOptions;

  constructor(opts: PlannerOptions) {
    this.opts = opts;
  }

  async plan(req: PlanRequest): Promise<Plan> {
    const llmCall = this.opts.llmCall ?? callPlannerLLM;
    // Cached prefix: full template with tools+examples filled in and datasets
    // left as an explicit placeholder. This text is identical across every
    // call for the lifetime of the planner, so Anthropic prompt caching pays.
    const cachedPrefix = renderPrompt({
      datasets: '(see Dataset profile appended below)',
      tools: renderToolsBlock(),
      examples: renderExamplesBlock(),
    });

    const datasetsBlock = renderDatasetsBlock(req.datasets);
    // Dynamic suffix: the actual dataset profile, appended verbatim. Changes
    // per request so it lives outside the cache.
    const systemSuffix = `# Dataset profile\n${datasetsBlock}\n`;

    const toolInputSchema = zodToJsonSchema(PlanSchema, { target: 'openApi3' }) as Record<string, unknown>;

    const buildInput = (userQuestion: string): PlannerLLMInput => {
      const inputBase: PlannerLLMInput = {
        apiKey: this.opts.apiKey,
        model: this.opts.model,
        cachedSystemPrompt: cachedPrefix,
        systemPrompt: systemSuffix,
        userQuestion,
        toolName: TOOL_NAME,
        toolDescription: TOOL_DESC,
        toolInputSchema,
        temperature: 0,
        maxTokens: 2048,
      };
      if (this.opts.dangerouslyAllowBrowser !== undefined) {
        inputBase.dangerouslyAllowBrowser = this.opts.dangerouslyAllowBrowser;
      }
      return inputBase;
    };

    const datasetNames = req.datasets.map((d) => d.name);
    const baseQuestion = req.feedback
      ? `${req.question}\n\nFeedback from prior plan: ${req.feedback}`
      : req.question;

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const userQuestion = attempt === 0
        ? baseQuestion
        : `${baseQuestion}\n\nYour previous attempt failed validation: ${(lastError as Error)?.message ?? 'unknown'}. Produce a corrected plan.`;
      let raw: Record<string, unknown>;
      try {
        raw = await llmCall(buildInput(userQuestion));
      } catch (err) {
        lastError = err;
        continue;
      }
      try {
        return validatePlan(raw, datasetNames);
      } catch (err) {
        lastError = err;
        if (!(err instanceof PlanValidationError)) throw err;
      }
    }
    throw new PlannerError(`could not produce a valid plan after 2 attempts`, lastError);
  }
}
