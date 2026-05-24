// Typed Ollama HTTP client for the background service worker.
// Streams NDJSON chunks from /api/chat. Stdlib fetch only — no deps.

import { log } from '../agent/log';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: Role;
  content: string;
  images?: string[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  /** 'json' for plain JSON mode, or a JSON Schema object (note: schema mode is currently flaky on qwen35). */
  format?: 'json' | Record<string, unknown>;
  /** Toggle Qwen3+ hybrid thinking mode. */
  think?: boolean;
  /** Ollama options bag — num_ctx, temperature, top_k, etc. */
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ChatChunk {
  message?: {
    role?: Role;
    content?: string;
    thinking?: string;
    tool_calls?: ToolCall[];
  };
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

export interface PingResult {
  ok: boolean;
  error?: string;
  models?: string[];
}

export class OllamaClient {
  constructor(public baseUrl: string) {}

  /** Build a full URL for a given Ollama API path. */
  url(path: string): string {
    return this.baseUrl.replace(/\/$/, '') + path;
  }

  /** Stream chat completions as NDJSON chunks. */
  async *chatStream(opts: ChatOptions): AsyncGenerator<ChatChunk, void, void> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      stream: true,
    };
    if (opts.tools) body.tools = opts.tools;
    if (opts.format !== undefined) body.format = opts.format;
    if (opts.think !== undefined) body.think = opts.think;
    if (opts.options) body.options = opts.options;

    const res = await fetch(this.url('/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      const detail = res.body ? await res.text().catch(() => '') : '';
      throw new Error(`Ollama chat HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line) as ChatChunk;
        } catch {
          // Malformed line — skip rather than abort the stream.
        }
      }
    }
    if (buf.trim()) {
      try { yield JSON.parse(buf) as ChatChunk; } catch { /* ignore tail */ }
    }
  }

  /**
   * Non-streaming chat completion. Returns the full response in one shot.
   * Use this when you only care about the final message (e.g., tool-call
   * extraction or JSON-mode structured output); use chatStream for UX
   * streaming.
   */
  async chatOnce(opts: ChatOptions): Promise<ChatChunk> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      stream: false,
    };
    if (opts.tools) body.tools = opts.tools;
    if (opts.format !== undefined) body.format = opts.format;
    if (opts.think !== undefined) body.think = opts.think;
    if (opts.options) body.options = opts.options;

    const promptChars = opts.messages.reduce((a, m) => a + (m.content?.length ?? 0), 0);
    log('info', 'ollama', 'chatOnce →', {
      model: opts.model,
      messages: opts.messages.length,
      promptChars,
      think: opts.think,
      format: typeof opts.format === 'string' ? opts.format : opts.format ? 'schema' : undefined,
      tools: opts.tools?.length ?? 0,
    });
    const start = performance.now();

    const res = await fetch(this.url('/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      log('error', 'ollama', `chatOnce ✗ HTTP ${res.status}`, {
        status: res.status,
        detail: detail.slice(0, 200),
        wallMs: Math.round(performance.now() - start),
      });
      throw new Error(`Ollama chat HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = (await res.json()) as ChatChunk;
    const wallMs = Math.round(performance.now() - start);
    log('info', 'ollama', 'chatOnce ✓', {
      model: opts.model,
      promptTokens: data.prompt_eval_count,
      genTokens: data.eval_count,
      thinkingChars: (data.message?.thinking ?? '').length,
      contentChars: (data.message?.content ?? '').length,
      toolCalls: data.message?.tool_calls?.length ?? 0,
      wallMs,
      tokPerSec: data.eval_count && wallMs > 0
        ? Math.round((data.eval_count / (wallMs / 1000)) * 10) / 10
        : undefined,
    });
    return data;
  }

  async embed(model: string, input: string | string[]): Promise<number[][]> {
    const res = await fetch(this.url('/api/embed'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input }),
    });
    if (!res.ok) throw new Error(`Ollama embed HTTP ${res.status}`);
    const data = await res.json() as { embeddings?: number[][] };
    return data.embeddings ?? [];
  }

  async ping(): Promise<PingResult> {
    try {
      const res = await fetch(this.url('/api/tags'), { method: 'GET' });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const data = await res.json() as { models?: { name: string }[] };
      return { ok: true, models: (data.models ?? []).map(m => m.name) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
