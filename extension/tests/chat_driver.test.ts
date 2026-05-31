import { describe, it, expect, vi } from 'vitest';
import { normalizeCloudResponse, driveChatOnce } from '../src/background/chat_driver';
import type { CloudChatResponse } from '../src/background/cloud_client';
import { CloudClient } from '../src/background/cloud_client';
import { resetAnonymizeCounters } from '../src/agent/anonymize';

describe('normalizeCloudResponse', () => {
  it('maps content + usage', () => {
    const resp = {
      id: 'c1',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    } as CloudChatResponse;
    const d = normalizeCloudResponse(resp);
    expect(d.message?.content).toBe('hello');
    expect(d.prompt_eval_count).toBe(10);
    expect(d.eval_count).toBe(4);
    expect(d.message?.tool_calls).toBeUndefined();
  });

  it('maps tool_calls and JSON.parses the arguments string', () => {
    const resp = {
      id: 'c1',
      choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [
        { id: 't1', type: 'function', function: { name: 'add', arguments: '{"a":2,"b":3}' } },
      ] } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    } as CloudChatResponse;
    const d = normalizeCloudResponse(resp);
    expect(d.message?.tool_calls?.[0].function.name).toBe('add');
    expect(d.message?.tool_calls?.[0].function.arguments).toEqual({ a: 2, b: 3 });
  });

  it('tolerates malformed argument JSON (-> empty object)', () => {
    const resp = {
      id: 'c1',
      choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [
        { id: 't1', type: 'function', function: { name: 'x', arguments: 'not json' } },
      ] } }],
    } as CloudChatResponse;
    const d = normalizeCloudResponse(resp);
    expect(d.message?.tool_calls?.[0].function.arguments).toEqual({});
  });
});

describe('driveChatOnce', () => {
  it('local provider: passes through chatOnce result as DriverResponse', async () => {
    const fake = {
      chatOnce: async (opts: { model: string }) => ({
        message: { content: `ok:${opts.model}` },
        prompt_eval_count: 11,
        eval_count: 3,
      }),
    };
    const r = await driveChatOnce(
      { client: fake as never, model: 'qwen3.5:4b' },
      { messages: [{ role: 'user', content: 'hi' }] },
    );
    expect(r.providerUsed).toBe('local');
    expect(r.fellBack).toBe(false);
    expect(r.message?.content).toBe('ok:qwen3.5:4b');
  });

  it('cloud provider: anonymizes outbound, deanonymizes response (sandwich)', async () => {
    resetAnonymizeCounters();
    const cloud = new CloudClient('https://api.example.com/v1', 'sk');
    vi.spyOn(cloud, 'chatOnce').mockImplementation(async (opts) => {
      const sent = opts.messages.map((m) => m.content).join(' | ');
      expect(sent).not.toContain('alice@example.com');
      expect(sent).toContain('<EMAIL_1>');
      return {
        id: 'c1',
        choices: [{ index: 0, message: { role: 'assistant', content: `noted <EMAIL_1>` } }],
        usage: { prompt_tokens: 7, completion_tokens: 2 },
      };
    });
    const r = await driveChatOnce(
      { client: cloud, model: 'deepseek-chat' },
      { messages: [{ role: 'user', content: 'email alice@example.com' }] },
    );
    expect(r.providerUsed).toBe('cloud');
    expect(r.message?.content).toBe('noted alice@example.com');
  });

  it('cloud error: falls back to the local provider', async () => {
    const cloud = new CloudClient();
    vi.spyOn(cloud, 'chatOnce').mockRejectedValue(new Error('Cloud API HTTP 503'));
    const localFake = {
      chatOnce: async () => ({ message: { content: 'local-answer' }, prompt_eval_count: 1, eval_count: 1 }),
    };
    const r = await driveChatOnce(
      { client: cloud, model: 'deepseek-chat' },
      { messages: [{ role: 'user', content: 'hi' }] },
      { client: localFake as never, model: 'qwen3.5:4b' },
    );
    expect(r.providerUsed).toBe('local');
    expect(r.fellBack).toBe(true);
    expect(r.message?.content).toBe('local-answer');
  });

  it('cloud user-abort: propagates, does NOT fall back', async () => {
    const cloud = new CloudClient();
    vi.spyOn(cloud, 'chatOnce').mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const localFake = { chatOnce: async () => ({ message: { content: 'should-not-run' } }) };
    await expect(
      driveChatOnce(
        { client: cloud, model: 'deepseek-chat' },
        { messages: [{ role: 'user', content: 'hi' }] },
        { client: localFake as never, model: 'qwen3.5:4b' },
      ),
    ).rejects.toThrow('aborted');
  });

  it('cloud TIMEOUT (not user abort) falls back to local', async () => {
    const cloud = new CloudClient();
    vi.spyOn(cloud, 'chatOnce').mockRejectedValue(Object.assign(new Error('Cloud chat timed out after 60000ms'), { name: 'TimeoutError' }));
    const localFake = { chatOnce: async () => ({ message: { content: 'local-after-timeout' }, prompt_eval_count: 1, eval_count: 1 }) };
    const r = await driveChatOnce(
      { client: cloud, model: 'deepseek-chat' },
      { messages: [{ role: 'user', content: 'hi' }] },
      { client: localFake as never, model: 'qwen3.5:4b' },
    );
    expect(r.fellBack).toBe(true);
    expect(r.message?.content).toBe('local-after-timeout');
  });

  it('cloud error with NO fallback rethrows', async () => {
    const cloud = new CloudClient();
    vi.spyOn(cloud, 'chatOnce').mockRejectedValue(new Error('Cloud API HTTP 500'));
    await expect(
      driveChatOnce({ client: cloud, model: 'deepseek-chat' }, { messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow('HTTP 500');
  });

  it('cloud tool-call arguments are deanonymized (string, before parse)', async () => {
    resetAnonymizeCounters();
    const cloud = new CloudClient();
    vi.spyOn(cloud, 'chatOnce').mockImplementation(async (opts) => {
      const sent = opts.messages.map((m) => m.content).join(' ');
      expect(sent).not.toContain('alice@example.com');
      // Echo a placeholder back inside the tool-call arguments JSON string.
      const ph = sent.match(/<EMAIL_\d+>/)?.[0] ?? '<EMAIL_1>';
      return {
        id: 'c1',
        choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [
          { id: 't1', type: 'function', function: { name: 'search', arguments: `{"q":"${ph}"}` } },
        ] } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      };
    });
    const r = await driveChatOnce(
      { client: cloud, model: 'deepseek-chat' },
      { messages: [{ role: 'user', content: 'find alice@example.com' }], tools: [] },
    );
    expect(r.message?.tool_calls?.[0].function.arguments).toEqual({ q: 'alice@example.com' });
  });
});
