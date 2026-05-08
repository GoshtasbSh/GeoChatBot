import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callPlannerLLM } from '../../src/agent/llm.js';

const FETCH_OK = (body: any) => ({
  ok: true,
  json: async () => body,
});

beforeEach(() => { vi.spyOn(globalThis, 'fetch' as any); });
afterEach(() => { vi.restoreAllMocks(); });

const baseInput = {
  apiKey: 'sk-ant-test',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'sys',
  cachedSystemPrompt: 'cached-sys',
  userQuestion: 'what?',
  toolName: 'submit_plan',
  toolDescription: 'submit a plan',
  toolInputSchema: { type: 'object', properties: {}, additionalProperties: false } as const,
};

describe('callPlannerLLM', () => {
  it('posts to api.anthropic.com with proper headers and tool_choice', async () => {
    (globalThis.fetch as any).mockResolvedValue(FETCH_OK({
      content: [{ type: 'tool_use', id: 'x', name: 'submit_plan', input: { ok: 1 } }],
      stop_reason: 'tool_use',
    }));
    const out = await callPlannerLLM(baseInput);
    expect(out).toEqual({ ok: 1 });
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('sk-ant-test');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'submit_plan' });
    expect(body.tools[0].name).toBe('submit_plan');
    expect(body.system).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', cache_control: { type: 'ephemeral' } }),
      ]),
    );
  });

  it('throws if no tool_use block present', async () => {
    (globalThis.fetch as any).mockResolvedValue(FETCH_OK({ content: [{ type: 'text', text: 'hi' }] }));
    await expect(callPlannerLLM(baseInput)).rejects.toThrow(/tool_use/);
  });

  it('throws on AUTH (401)', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    await expect(callPlannerLLM(baseInput)).rejects.toThrow(/auth|401/i);
  });

  it('throws on rate limit (429)', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    await expect(callPlannerLLM(baseInput)).rejects.toThrow(/rate|429/i);
  });

  it('does not log the API key on network failure', async () => {
    (globalThis.fetch as any).mockRejectedValue(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(callPlannerLLM(baseInput)).rejects.toThrow();
    for (const call of errSpy.mock.calls) {
      const joined = call.map(String).join(' ');
      expect(joined).not.toContain('sk-ant-test');
    }
  });
});
