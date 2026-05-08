import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callCriticLLM, CriticLLMError } from '../../src/agent/critic-llm.js';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  // Pretend we're not in a browser so dangerouslyAllowBrowser checks fall through.
  vi.stubGlobal('window', undefined);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('callCriticLLM', () => {
  const baseInput = {
    apiKey: 'sk-test',
    model: 'claude-haiku-4-5-20251001',
    cachedSystemPrompt: 'static',
    systemPrompt: 'dynamic',
    userMessage: 'a step failed; diagnose',
    toolInputSchema: { type: 'object', properties: {} },
  };

  it('returns the input of the submit_diagnosis tool_use block', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      content: [
        { type: 'text', text: 'reasoning' },
        { type: 'tool_use', name: 'submit_diagnosis', input: { action: 'retry' } },
      ],
    }), { status: 200 }));
    const out = await callCriticLLM(baseInput);
    expect(out).toEqual({ action: 'retry' });
  });

  it('maps 401 to AUTH', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 401 }));
    await expect(callCriticLLM(baseInput)).rejects.toMatchObject({
      name: 'CriticLLMError', code: 'AUTH', status: 401,
    });
  });

  it('maps 429 to RATE_LIMIT', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 429 }));
    await expect(callCriticLLM(baseInput)).rejects.toMatchObject({
      name: 'CriticLLMError', code: 'RATE_LIMIT', status: 429,
    });
  });

  it('maps fetch failure to NETWORK', async () => {
    fetchMock.mockRejectedValue(new TypeError('NetworkError'));
    await expect(callCriticLLM(baseInput)).rejects.toMatchObject({
      name: 'CriticLLMError', code: 'NETWORK',
    });
  });

  it('throws NO_TOOL_USE when the response has no submit_diagnosis block', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'sorry' }],
    }), { status: 200 }));
    await expect(callCriticLLM(baseInput)).rejects.toMatchObject({
      name: 'CriticLLMError', code: 'NO_TOOL_USE',
    });
  });

  it('blocks browser direct calls without dangerouslyAllowBrowser', async () => {
    vi.stubGlobal('window', { document: {} });
    await expect(callCriticLLM(baseInput)).rejects.toMatchObject({
      name: 'CriticLLMError', code: 'NETWORK',
    });
  });

  it('passes anthropic-dangerous-direct-browser-access header when opted in', async () => {
    vi.stubGlobal('window', { document: {} });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'tool_use', name: 'submit_diagnosis', input: { action: 'abort' } }],
    }), { status: 200 }));
    await callCriticLLM({ ...baseInput, dangerouslyAllowBrowser: true });
    const headers = fetchMock.mock.calls[0]![1].headers;
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  });
});
