import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderError,
  clearProvider,
  createAnthropic,
  createEcho,
  createGemini,
  createGroq,
  createOpenAICompat,
  getProvider,
  setProvider,
  type ChatMessage,
} from '../src/providers/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
  clearProvider();
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('registry', () => {
  it('round-trips set/get/clear', () => {
    expect(getProvider()).toBeUndefined();
    const echo = createEcho();
    setProvider(echo);
    expect(getProvider()).toBe(echo);
    clearProvider();
    expect(getProvider()).toBeUndefined();
  });
});

describe('createEcho', () => {
  it('returns the last user message', async () => {
    const p = createEcho();
    expect(p.id).toBe('echo');
    expect(p.free).toBe(true);
    const out = await p.generate({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
    });
    expect(out.text).toBe('echo: second');
  });
});

describe('createOpenAICompat', () => {
  it('sends correct URL, headers, and body, parses content', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'hi there' } }],
        usage: { prompt_tokens: 5, completion_tokens: 7 },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const p = createOpenAICompat({
      baseUrl: 'https://example.test/v1',
      apiKey: 'sk-abc',
      model: 'm-1',
    });
    const out = await p.generate({
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.5,
      maxTokens: 100,
    });
    expect(out.text).toBe('hi there');
    expect(out.model).toBe('m-1');
    expect(out.usage).toEqual({ inputTokens: 5, outputTokens: 7 });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://example.test/v1/chat/completions');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-abc');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(call.init.body as string);
    expect(body.model).toBe('m-1');
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(100);
    expect(body.stream).toBe(false);
  });

  it('maps 401 to AUTH', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 401 })),
    );
    const p = createOpenAICompat({
      baseUrl: 'https://x/v1',
      apiKey: 'k',
      model: 'm',
    });
    await expect(p.generate({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toMatchObject({ code: 'AUTH', providerId: 'openai-compat', status: 401 });
  });

  it('maps 429 to RATE_LIMIT', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('slow down', { status: 429 })),
    );
    const p = createOpenAICompat({
      baseUrl: 'https://x/v1',
      apiKey: 'k',
      model: 'm',
    });
    await expect(p.generate({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toMatchObject({ code: 'RATE_LIMIT', status: 429 });
  });

  it('maps malformed body to BAD_RESPONSE', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ unexpected: true })),
    );
    const p = createOpenAICompat({
      baseUrl: 'https://x/v1',
      apiKey: 'k',
      model: 'm',
    });
    await expect(p.generate({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('propagates AbortSignal to fetch', async () => {
    let captured: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = init.signal ?? undefined;
        return jsonResponse({
          choices: [{ message: { content: 'ok' } }],
        });
      }),
    );
    const p = createOpenAICompat({
      baseUrl: 'https://x/v1',
      apiKey: 'k',
      model: 'm',
    });
    const ac = new AbortController();
    await p.generate({
      messages: [{ role: 'user', content: 'hi' }],
      signal: ac.signal,
    });
    expect(captured).toBe(ac.signal);
  });
});

describe('createGroq', () => {
  it('defaults to Groq URL and a llama-3.x model and is free', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse({
          choices: [{ message: { content: 'g' } }],
        });
      }),
    );
    const p = createGroq({ apiKey: 'gsk_x' });
    expect(p.id).toBe('groq');
    expect(p.free).toBe(true);
    const out = await p.generate({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.text).toBe('g');
    expect(calls[0]!.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toMatch(/^llama-3/);
  });
});

describe('createAnthropic', () => {
  it('builds Anthropic schema with extracted system + correct headers', async () => {
    vi.stubGlobal('window', { document: {} });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse({
          content: [{ type: 'text', text: 'claude says hi' }],
          usage: { input_tokens: 3, output_tokens: 4 },
        });
      }),
    );
    const p = createAnthropic({
      apiKey: 'ant-key',
      dangerouslyAllowBrowser: true,
    });
    const messages: ChatMessage[] = [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'again' },
    ];
    const out = await p.generate({ messages });
    expect(out.text).toBe('claude says hi');
    expect(out.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('ant-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.system).toBe('be terse');
    expect(body.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'again' },
    ]);
  });

  it('throws UNSUPPORTED in browser env without dangerouslyAllowBrowser', async () => {
    vi.stubGlobal('window', { document: {} });
    const p = createAnthropic({ apiKey: 'k' });
    await expect(p.generate({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toBeInstanceOf(ProviderError);
    await expect(p.generate({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});

describe('createGemini', () => {
  it('hits the correct URL, maps roles, and parses response', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse({
          candidates: [
            { content: { parts: [{ text: 'gemini hi' }] } },
          ],
        });
      }),
    );
    const p = createGemini({ apiKey: 'gkey', model: 'gemini-2.5-flash' });
    expect(p.free).toBe(true);
    const out = await p.generate({
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'again' },
      ],
    });
    expect(out.text).toBe('gemini hi');
    const url = calls[0]!.url;
    expect(url).toContain('models/gemini-2.5-flash:generateContent');
    expect(url).toContain('key=gkey');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.systemInstruction.parts[0].text).toBe('be brief');
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'hi' }] },
      { role: 'user', parts: [{ text: 'again' }] },
    ]);
  });
});
