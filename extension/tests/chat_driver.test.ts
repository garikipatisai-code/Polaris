import { describe, it, expect } from 'vitest';
import { normalizeCloudResponse } from '../src/background/chat_driver';
import type { CloudChatResponse } from '../src/background/cloud_client';

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
