// OpenAI-format HTTP client for cloud LLM providers. Raw fetch(), no SDK.
// Compatible with DeepSeek, OpenAI, and any OpenAI-compatible endpoint.

import { log } from '../agent/log';
import { composeSignal, wasTimeout } from './signal';
import type { ToolDef } from './ollama';

/** Cloud calls are fast (hosted API); 60s covers a slow tool-calling completion. */
export const DEFAULT_CLOUD_TIMEOUT_MS = 60_000;

export interface CloudMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: { id?: string; type?: string; function: { name: string; arguments: string } }[];
}

export interface CloudChatOptions {
  model: string;
  messages: CloudMessage[];
  apiKey: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Forwarded as OpenAI `tools`. Our ToolDef IS the OpenAI tools shape. */
  tools?: ToolDef[];
  /** When true, sets response_format:{type:'json_object'}. */
  responseFormatJson?: boolean;
}

export interface CloudChatResponse {
  id: string;
  choices: { index: number; message: CloudMessage; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export class CloudClient {
  constructor(
    public readonly baseUrl: string = 'https://api.deepseek.com/v1',
    public readonly defaultApiKey: string = '',
  ) {}

  /**
   * Non-streaming chat completion. Returns the full response in one shot.
   * Compatible with any OpenAI-format endpoint (DeepSeek, OpenAI, etc.).
   */
  async chatOnce(opts: CloudChatOptions): Promise<CloudChatResponse> {
    const url = `${opts.baseUrl ?? this.baseUrl}/chat/completions`;
    const apiKey = opts.apiKey || this.defaultApiKey;

    log('info', 'cloud', 'chatOnce ->', {
      model: opts.model,
      messages: opts.messages.length,
      promptChars: opts.messages.reduce((a, m) => a + (m.content?.length ?? 0), 0),
      maxTokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature ?? 0.7,
    });
    const start = performance.now();

    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 4096,
      stream: false,
    };
    if (opts.tools && opts.tools.length) body.tools = opts.tools;
    if (opts.responseFormatJson) body.response_format = { type: 'json_object' };

    const timeoutMs = opts.timeoutMs ?? DEFAULT_CLOUD_TIMEOUT_MS;
    const composed = composeSignal(opts.signal, timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: composed.signal,
      });
    } catch (e) {
      composed.cleanup();
      // Timeout classification: wasTimeout(e) catches the standard case where
      // fetch throws an AbortError whose .cause is the timeout DOMException.
      // The second clause catches environments (test mocks, some runtimes)
      // that throw a bare AbortError without .cause — composeSignal always
      // aborts with the timeout DOMException, so composed.signal.reason is
      // authoritative when the timer fired. Neither clause fires for a user
      // abort (reason is the user's) or a network error (signal not aborted).
      const isTimeout = wasTimeout(e) ||
        (composed.signal.aborted && wasTimeout(composed.signal.reason));
      if (isTimeout) {
        const tErr = new Error(`Cloud chat timed out after ${timeoutMs}ms`);
        tErr.name = 'TimeoutError';
        throw tErr;
      }
      throw e;
    }

    try {
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        log('error', 'cloud', `chatOnce HTTP ${res.status}`, {
          status: res.status,
          detail: detail.slice(0, 200),
          wallMs: Math.round(performance.now() - start),
        });
        throw new Error(`Cloud API HTTP ${res.status}: ${detail.slice(0, 200)}`);
      }

      const data = (await res.json()) as CloudChatResponse;
      log('info', 'cloud', 'chatOnce OK', {
        model: opts.model,
        id: data.id,
        finishReason: data.choices?.[0]?.finish_reason,
        usage: data.usage,
        wallMs: Math.round(performance.now() - start),
      });
      return data;
    } finally {
      composed.cleanup();
    }
  }

  /**
   * Streaming chat completion — yields content deltas via SSE parsing.
   * Each yielded string is a single content delta from a chunk.
   */
  async *chatStream(opts: CloudChatOptions): AsyncGenerator<string, void, unknown> {
    const url = `${opts.baseUrl ?? this.baseUrl}/chat/completions`;
    const apiKey = opts.apiKey || this.defaultApiKey;

    log('info', 'cloud', 'chatStream ->', {
      model: opts.model,
      messages: opts.messages.length,
      maxTokens: opts.maxTokens ?? 4096,
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens ?? 4096,
        stream: true,
      }),
      signal: opts.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Cloud stream HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('Cloud stream: no response body');
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;
        try {
          const parsed = JSON.parse(trimmed.slice(6));
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch {
          // Skip malformed lines
        }
      }
    }
  }
}
