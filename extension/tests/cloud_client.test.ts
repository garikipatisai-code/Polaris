import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudClient } from '../src/background/cloud_client';

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const sampleResponse = {
  id: 'chat-123',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

const sampleStreamChunks = [
  'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n',
  'data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
  'data: [DONE]\n',
].join('');

describe('CloudClient', () => {
  beforeEach(() => vi.clearAllMocks());

  it('chatOnce returns parsed response', async () => {
    mockFetch.mockResolvedValue({ ok: true, text: vi.fn(), json: vi.fn().mockResolvedValue(sampleResponse) });
    const client = new CloudClient('https://api.example.com/v1', 'sk-test');
    const result = await client.chatOnce({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], apiKey: 'sk-test' });
    expect(result.choices[0].message.content).toBe('Hello!');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('deepseek-chat');
    expect(body.stream).toBe(false);
  });

  it('chatOnce includes auth header', async () => {
    mockFetch.mockResolvedValue({ ok: true, text: vi.fn(), json: vi.fn().mockResolvedValue(sampleResponse) });
    const client = new CloudClient();
    await client.chatOnce({ model: 'test', messages: [], apiKey: 'sk-my-key' });
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Bearer sk-my-key');
  });

  it('chatStream yields content deltas', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sampleStreamChunks));
        controller.close();
      },
    });
    mockFetch.mockResolvedValue({ ok: true, body: stream });
    const client = new CloudClient();
    const chunks: string[] = [];
    for await (const chunk of client.chatStream({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], apiKey: 'sk-test' })) {
      chunks.push(chunk);
    }
    expect(chunks.join('')).toBe('Hello world');
  });

  it('chatOnce throws on HTTP error', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, text: vi.fn().mockResolvedValue('unauthorized') });
    const client = new CloudClient();
    await expect(client.chatOnce({ model: 'test', messages: [], apiKey: 'bad' })).rejects.toThrow('HTTP 401');
  });

  it('forwards tools and response_format in the request body', async () => {
    mockFetch.mockResolvedValue({ ok: true, text: vi.fn(), json: vi.fn().mockResolvedValue(sampleResponse) });
    const client = new CloudClient('https://api.example.com/v1', 'sk-test');
    const tools = [{ type: 'function' as const, function: { name: 'add', description: 'x', parameters: { type: 'object', properties: {} } } }];
    await client.chatOnce({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], apiKey: 'sk-test', tools, responseFormatJson: true });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.tools).toEqual(tools);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('parses tool_calls from the response', async () => {
    const toolResp = {
      id: 'c1',
      choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'add', arguments: '{"a":1}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    };
    mockFetch.mockResolvedValue({ ok: true, text: vi.fn(), json: vi.fn().mockResolvedValue(toolResp) });
    const client = new CloudClient();
    const result = await client.chatOnce({ model: 'm', messages: [], apiKey: 'k' });
    expect(result.choices[0].message.tool_calls?.[0].function.name).toBe('add');
    expect(result.choices[0].message.tool_calls?.[0].function.arguments).toBe('{"a":1}');
  });

  it('aborts after timeoutMs', async () => {
    mockFetch.mockImplementation((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    );
    const client = new CloudClient();
    await expect(
      client.chatOnce({ model: 'm', messages: [], apiKey: 'k', timeoutMs: 10 }),
    ).rejects.toThrow(/timed out/);
  });
});
