import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

async function loadSql() {
  await import('../../../src/agent/tools/sql.js');
  return await import('../../../src/agent/tools/registry.js');
}

describe('sql tool', () => {
  it('registers as `sql` with output_kind=table', async () => {
    const { getTool } = await loadSql();
    const t = getTool('sql')!;
    expect(t.id).toBe('sql');
    expect(t.output_kind).toBe('table');
  });

  it('requires non-empty query string', async () => {
    const { getTool } = await loadSql();
    const t = getTool('sql')!;
    expect(t.args.safeParse({ query: '' }).success).toBe(false);
    expect(t.args.safeParse({ query: 'SELECT 1' }).success).toBe(true);
  });
});
