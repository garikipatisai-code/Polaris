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
});
