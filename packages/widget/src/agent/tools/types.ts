import type { z } from 'zod';
import type { ToolOutputKind } from '../types.js';

export interface ToolDef<A extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Unique stable id like `geometry.buffer`. */
  id: string;
  /** 1–3 sentence description. Shown to the LLM in the system prompt. */
  description: string;
  /** Zod schema for the args object. JSON-Schema is auto-derived for the prompt. */
  args: A;
  /** What kind of output this tool produces. */
  output_kind: ToolOutputKind;
  /** Few-shot args examples. Optional but recommended for the LLM. */
  examples?: Array<{ when: string; args: z.infer<A> }>;
}
