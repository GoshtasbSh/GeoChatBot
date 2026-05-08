import { z } from 'zod';
import { registerTool } from './registry.js';

const ChartKind = z.enum(['bar', 'line', 'scatter', 'pie', 'grouped_bar']);

registerTool({
  id: 'render.map',
  description: 'Render a layer on a map. The user (or host) sees the result. Always the last step when the answer is geographic.',
  args: z.object({
    layer: z.string(),
    style: z.record(z.unknown()).optional(),
  }),
  output_kind: 'rendered',
  examples: [{ when: 'Show buffered hospitals on the map', args: { layer: 'buffered' } }],
});

registerTool({
  id: 'render.chart',
  description: 'Render a chart (bar, line, scatter, pie, grouped_bar) from a table. Use when the answer is comparative or temporal.',
  args: z.object({
    table: z.string(),
    kind: ChartKind,
    x: z.string(),
    y: z.string(),
    group: z.string().optional(),
  }),
  output_kind: 'rendered',
  examples: [{ when: 'Bar chart of sales by neighborhood', args: { table: 'totals', kind: 'bar', x: 'neighborhood_name', y: 'sum_price' } }],
});

registerTool({
  id: 'render.table',
  description: 'Render a virtualized data table from a table. Use when the answer is row-by-row.',
  args: z.object({ table: z.string() }),
  output_kind: 'rendered',
  examples: [{ when: 'Show the matched-pair rows', args: { table: 'pairs' } }],
});

registerTool({
  id: 'render.summary',
  description: 'Render a plain-English markdown summary. Always the last step when the answer is a sentence/paragraph.',
  // `text` must be a literal sentence the LLM authored — not a whole-
  // string `${var}` reference. Substituting `"${foo}"` resolves to the
  // OutputRef object (not a string), which the renderer would coerce to
  // `[object Object]`. Partial interpolation like `"Found ${count}"` is
  // intentionally NOT substituted (see substitute.ts WHOLE_STRING_VAR);
  // it stays literal, which is fine.
  args: z.object({
    text: z
      .string()
      .min(1)
      .refine(
        (s) => !/^\$\{\w+\}$/.test(s),
        'render.summary.text must be a literal sentence, not a whole-string ${var} reference',
      ),
  }),
  output_kind: 'rendered',
  examples: [{ when: 'Tell the user what was found', args: { text: 'Brooklyn led with $X in sales.' } }],
});
