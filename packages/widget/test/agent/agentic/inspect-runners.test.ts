/**
 * Inspection runner unit tests — exercise each runner against a spy
 * engine that records the SQL and returns deterministic Arrow tables.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { tableFromJSON, type Table as ArrowTable } from 'apache-arrow';
import { runInspection, type InspectionRunCtx } from '../../../src/agent/agentic/inspect-runners.js';
import type { DatasetEntry, ExecutorEngine } from '../../../src/agent/executor/types.js';

class SpyEngine implements ExecutorEngine {
  hasSpatial = true;
  public sqls: string[] = [];
  public mockResponse: ArrowTable = tableFromJSON([{ ok: 1 }]);
  public mockResponses: ArrowTable[] | null = null; // fifo when set
  async query(sql: string): Promise<ArrowTable> {
    this.sqls.push(sql);
    if (this.mockResponses && this.mockResponses.length > 0) {
      return this.mockResponses.shift()!;
    }
    return this.mockResponse;
  }
}

const survey: DatasetEntry = {
  name: 'survey',
  tableName: 'survey',
  hasGeometry: false,
};

let engine: SpyEngine;
let ctx: InspectionRunCtx;
beforeEach(() => {
  engine = new SpyEngine();
  ctx = { engine, datasets: new Map([[survey.name, survey]]) };
});

describe('inspect.list_columns', () => {
  it('returns one line per column with type', async () => {
    engine.mockResponse = tableFromJSON([
      { name: 'Address', type: 'VARCHAR', nullable: false },
      { name: 'date', type: 'DOUBLE', nullable: true },
    ]);
    const out = await runInspection('inspect.list_columns', { dataset: 'survey' }, ctx);
    expect(out).toMatch(/Address: VARCHAR/);
    expect(out).toMatch(/date: DOUBLE \(nullable\)/);
    expect(engine.sqls[0]).toMatch(/pragma_table_info/);
  });

  it('errors when the dataset is unknown', async () => {
    const out = await runInspection('inspect.list_columns', { dataset: 'nope' }, ctx);
    expect(out).toMatch(/unknown dataset "nope"/);
  });
});

describe('inspect.sample_rows', () => {
  it('caps rows and truncates long string fields', async () => {
    const longNote = 'x'.repeat(200);
    engine.mockResponse = tableFromJSON([
      { Address: '6116 Harvard Avenue', note: longNote },
      { Address: '6169 Cascade', note: 'short' },
    ]);
    const out = await runInspection(
      'inspect.sample_rows',
      { dataset: 'survey', n: 2 },
      ctx,
    );
    expect(out).toMatch(/showing 2/);
    expect(out).toMatch(/Harvard Avenue/);
    expect(out).toMatch(/\.\.\./); // truncation marker
    expect(engine.sqls[0]).toMatch(/LIMIT 2/);
  });
});

describe('inspect.distinct_values', () => {
  it('returns top-K with counts', async () => {
    engine.mockResponse = tableFromJSON([
      { value: 'completed survey', cnt: 14 },
      { value: 'No answer', cnt: 8 },
    ]);
    const out = await runInspection(
      'inspect.distinct_values',
      { dataset: 'survey', column: 'First attempt', k: 5 },
      ctx,
    );
    expect(out).toMatch(/"completed survey": 14/);
    expect(out).toMatch(/"No answer": 8/);
    expect(engine.sqls[0]).toMatch(/GROUP BY 1/);
    expect(engine.sqls[0]).toMatch(/LIMIT 5/);
  });

  it('handles all-null column', async () => {
    engine.mockResponse = tableFromJSON([] as Record<string, unknown>[]);
    // tableFromJSON([]) yields an empty 0-column table; spoof a 0-row table
    // with the right schema by using a 1-row mock then filtering: simpler
    // to short-circuit by stubbing the engine call.
    const e2: ExecutorEngine = {
      hasSpatial: true,
      async query() {
        return tableFromJSON([{ value: null as unknown as string, cnt: 0 }]).slice(0, 0);
      },
    };
    const out = await runInspection(
      'inspect.distinct_values',
      { dataset: 'survey', column: 'foo', k: 5 },
      { engine: e2, datasets: ctx.datasets },
    );
    expect(out).toMatch(/has no non-null values/);
  });
});

describe('inspect.column_pattern', () => {
  it('classifies a street-address column', async () => {
    engine.mockResponse = tableFromJSON([
      { v: '6116 Harvard Avenue' },
      { v: '6169 Cascade Road' },
      { v: '6173 Harvard Avenue' },
    ]);
    const out = await runInspection(
      'inspect.column_pattern',
      { dataset: 'survey', column: 'Address' },
      ctx,
    );
    expect(out).toMatch(/dominant=address_like/);
  });

  it('classifies a zip column', async () => {
    engine.mockResponse = tableFromJSON([
      { v: '32625' },
      { v: '32626' },
      { v: '32625' },
    ]);
    const out = await runInspection(
      'inspect.column_pattern',
      { dataset: 'survey', column: 'zip' },
      ctx,
    );
    expect(out).toMatch(/dominant=us_zip/);
  });

  it('classifies a free-text column', async () => {
    engine.mockResponse = tableFromJSON([
      { v: 'just home from the doctor' },
      { v: 'left a flier' },
      { v: 'no one home' },
    ]);
    const out = await runInspection(
      'inspect.column_pattern',
      { dataset: 'survey', column: 'note' },
      ctx,
    );
    expect(out).toMatch(/dominant=free_text/);
  });
});

describe('inspect.probe_sql', () => {
  it('rejects forbidden SQL', async () => {
    const out = await runInspection(
      'inspect.probe_sql',
      { query: 'DROP TABLE survey' },
      ctx,
    );
    expect(out).toMatch(/error running inspect.probe_sql/);
  });

  it('returns a row sample with row count', async () => {
    engine.mockResponse = tableFromJSON([
      { Address: '6116 Harvard', cnt: 1 },
      { Address: '6169 Cascade', cnt: 1 },
    ]);
    const out = await runInspection(
      'inspect.probe_sql',
      { query: 'SELECT Address, count(*) AS cnt FROM survey GROUP BY 1' },
      ctx,
    );
    expect(out).toMatch(/probe_sql returned 2 rows/);
    expect(out).toMatch(/columns=\["Address", "cnt"\]/);
  });
});

describe('runInspection error handling', () => {
  it('returns an error string for unknown tool ids', async () => {
    const out = await runInspection('inspect.nope', {}, ctx);
    expect(out).toMatch(/unknown inspection tool/);
  });
});
