/**
 * End-to-end test: Planner in agentic mode.
 *
 * Wires the synthetic embedder + a scripted agentic LLM + a spy engine
 * and asserts the Planner returns a validated Plan that incorporates
 * the inspection observation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { tableFromJSON } from 'apache-arrow';
import { Planner } from '../../../src/agent/planner.js';
import {
  __setTestEmbedder,
  EMBEDDING_DIM,
} from '../../../src/agent/retrieval/embedder.js';
import { __resetRetrieverForTests } from '../../../src/agent/retrieval/retriever.js';
import type { LoopLLMCall } from '../../../src/agent/agentic/loop.js';
import type { ExecutorEngine, DatasetEntry } from '../../../src/agent/executor/types.js';
// Side-effect import: registers all terminal tools so the planner schema
// references resolve during validation.
import '../../../src/agent/tools/index.js';

beforeEach(async () => {
  // Synthetic bag-of-words embedder so the planner's RAG path runs in
  // ~milliseconds instead of downloading 22 MB of weights.
  __setTestEmbedder(() => new Float32Array(EMBEDDING_DIM));
  await __resetRetrieverForTests();
});

describe('Planner.plan({ mode: "agentic" })', () => {
  it('runs an inspection call and returns a validated Plan', async () => {
    const survey: DatasetEntry = { name: 'survey', tableName: 'survey', hasGeometry: false };
    const engine: ExecutorEngine = {
      hasSpatial: true,
      async query(sql: string) {
        if (/pragma_table_info/.test(sql)) {
          return tableFromJSON([{ name: 'Address', type: 'VARCHAR', nullable: false }]);
        }
        return tableFromJSON([{ ok: 1 }]);
      },
    };

    const llmCall: LoopLLMCall = (() => {
      let i = 0;
      const turns: Array<{ tool_calls: { id: string; name: string; args: Record<string, unknown> }[] }> = [
        {
          tool_calls: [
            {
              id: 'c1',
              name: 'inspect.list_columns',
              args: { dataset: 'survey' },
            },
          ],
        },
        {
          tool_calls: [
            {
              id: 'c2',
              name: 'finalize_plan',
              args: {
                goal: 'show-on-map',
                assumptions: ['address column needs geocoding'],
                dataset_refs: ['survey'],
                steps: [
                  {
                    id: 's1',
                    tool: 'geocode.address',
                    args: {
                      layer: 'survey',
                      address_cols: ['Address'],
                      country_code: 'us',
                      region_hint: 'Cedar Key, FL, USA',
                    },
                    output_var: 'survey_geo',
                    why: 'attach a region hint so single-column street resolves correctly',
                  },
                  {
                    id: 's2',
                    tool: 'render.map',
                    args: { layer: '${survey_geo}' },
                    why: 'final render',
                  },
                ],
              },
            },
          ],
        },
      ];
      return async () => {
        const turn = turns[i++];
        if (!turn) throw new Error('LLM script exhausted');
        return { text: null, tool_calls: turn.tool_calls };
      };
    })();

    const planner = new Planner({
      provider: 'groq',
      apiKey: 'test',
      model: 'llama-3.3-70b-versatile',
      mode: 'agentic',
      agenticEndpoint: 'http://stub.example/chat/completions',
      agenticLlmCall: llmCall,
      agenticCtx: { engine, datasets: new Map([['survey', survey]]) },
      retrieval: 'off', // skip embedding to keep the test deterministic
      dangerouslyAllowBrowser: true,
    });

    const plan = await planner.plan({
      question: 'Show this Cedar Key, FL community survey on a map.',
      datasets: [
        {
          name: 'survey',
          kind: 'table',
          rows: 269,
          columns: [{ name: 'Address', type: 'Utf8' }],
          sample: [],
        },
      ],
    });

    expect(plan.goal).toBe('show-on-map');
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]!.tool).toBe('geocode.address');
    expect(plan.steps[1]!.tool).toBe('render.map');
    expect((plan.steps[0]!.args as { region_hint?: string }).region_hint).toBe(
      'Cedar Key, FL, USA',
    );
  });
});
