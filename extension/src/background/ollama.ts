// Typed Ollama HTTP client for the background service worker.
// Streams NDJSON chunks from /api/chat. Stdlib fetch only — no deps.

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
