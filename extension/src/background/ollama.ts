// Typed Ollama HTTP client for the background service worker.
// Streams NDJSON chunks from /api/chat. Stdlib fetch only — no deps.

import { log } from '../agent/log';
import { recordCharsPerToken } from '../agent/budget';
import { composeSignal, wasTimeout, type ComposedSignal } from './signal';

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
  /**
   * Per-request timeout in ms. Composed with `signal` via AbortSignal.any.
   * Default DEFAULT_CHAT_TIMEOUT_MS. Pass 0 to disable.
   */
  timeoutMs?: number;
  /**
   * Ollama `keep_alive` — how long to keep the model loaded after the request.
   * Default '10m' so back-to-back agent calls don't pay cold-load cost.
   */
  keepAlive?: string;
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

/** Default chat timeout. Mac CPU first call is ~3 min; Linux GPU is seconds. 5 min covers both. */
export const DEFAULT_CHAT_TIMEOUT_MS = 5 * 60 * 1000;

/** Default keep-alive. Keeps the model resident long enough for the next agent turn. */
export const DEFAULT_KEEP_ALIVE = '10m';

/** Default ping timeout. Should be near-instant; long delay implies wrong URL. */
export const DEFAULT_PING_TIMEOUT_MS = 10_000;

// Re-export wasTimeout so existing importers of './ollama' continue to resolve.
export { wasTimeout };

export class OllamaClient {
  constructor(public baseUrl: string) {}

  /** Build a full URL for a given Ollama API path. */
  url(path: string): string {
    return this.baseUrl.replace(/\/$/, '') + path;
  }

  /**
   * Stream chat completions as NDJSON chunks. Hardened the same way as
   * chatOnce: timeout via composeSignal, keep_alive default, and a single
   * retry on transient HTTP 5xx (network-error retry isn't safe here — the
   * stream may already be partially consumed by the caller, so we can't
   * cleanly resume).
   */
  async *chatStream(opts: ChatOptions): AsyncGenerator<ChatChunk, void, void> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      stream: true,
      keep_alive: opts.keepAlive ?? DEFAULT_KEEP_ALIVE,
    };
    if (opts.tools) body.tools = opts.tools;
    if (opts.format !== undefined) body.format = opts.format;
    if (opts.think !== undefined) body.think = opts.think;
    if (opts.options) body.options = opts.options;

    const timeoutMs = opts.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
    let attempt = 0;
    let composed: ComposedSignal | null = null;
    try {
      for (;;) {
        composed = composeSignal(opts.signal, timeoutMs);
        let res: Response;
        try {
          res = await fetch(this.url('/api/chat'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: composed.signal,
          });
        } catch (e) {
          composed.cleanup();
          composed = null;
          if (wasTimeout(e)) {
            const tErr = new Error(`Ollama chat timed out after ${timeoutMs}ms`);
            tErr.name = 'TimeoutError';
            throw tErr;
          }
          throw e;
        }
        if (res.status >= 500 && res.status < 600 && attempt === 0) {
          const detail = await res.text().catch(() => '');
          log('warn', 'ollama', `chatStream 5xx — retrying once`, {
            status: res.status,
            detail: detail.slice(0, 200),
          });
          composed.cleanup();
          composed = null;
          attempt++;
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        if (!res.ok || !res.body) {
          const detail = res.body ? await res.text().catch(() => '') : '';
          composed.cleanup();
          composed = null;
          throw new Error(`Ollama chat HTTP ${res.status}: ${detail.slice(0, 200)}`);
        }
        // Hand off to the streaming reader. Cleanup of `composed` happens in
        // the outer finally; while the stream is being consumed, we want the
        // signal alive so upstream aborts still propagate.
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
        return;
      }
    } finally {
      composed?.cleanup();
    }
  }

  /**
   * Non-streaming chat completion. Returns the full response in one shot.
   * Use this when you only care about the final message (e.g., tool-call
   * extraction or JSON-mode structured output); use chatStream for UX
   * streaming.
   *
   * Retries once on transient HTTP 5xx or non-timeout network errors with a
   * brief backoff. Does NOT retry on 4xx (caller error), timeouts, or user
   * aborts — those reflect deterministic conditions that won't change on retry.
   */
  async chatOnce(opts: ChatOptions): Promise<ChatChunk> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      stream: false,
      keep_alive: opts.keepAlive ?? DEFAULT_KEEP_ALIVE,
    };
    if (opts.tools) body.tools = opts.tools;
    if (opts.format !== undefined) body.format = opts.format;
    if (opts.think !== undefined) body.think = opts.think;
    if (opts.options) body.options = opts.options;

    const promptChars = opts.messages.reduce((a, m) => a + (m.content?.length ?? 0), 0);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
    log('info', 'ollama', 'chatOnce →', {
      model: opts.model,
      messages: opts.messages.length,
      promptChars,
      think: opts.think,
      format: typeof opts.format === 'string' ? opts.format : opts.format ? 'schema' : undefined,
      tools: opts.tools?.length ?? 0,
      timeoutMs,
    });
    const start = performance.now();

    const doFetch = async (): Promise<{ res: Response; cleanup: () => void }> => {
      const composed = composeSignal(opts.signal, timeoutMs);
      try {
        const res = await fetch(this.url('/api/chat'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: composed.signal,
        });
        return { res, cleanup: composed.cleanup };
      } catch (e) {
        composed.cleanup();
        if (wasTimeout(e)) {
          const wallMs = Math.round(performance.now() - start);
          log('error', 'ollama', `chatOnce ✗ timeout`, { timeoutMs, wallMs });
          const tErr = new Error(`Ollama chat timed out after ${timeoutMs}ms`);
          tErr.name = 'TimeoutError';
          throw tErr;
        }
        throw e;
      }
    };

    let res: Response;
    let activeCleanup: (() => void) | null = null;
    let attempt = 0;
    try {
      for (;;) {
        try {
          const fetched = await doFetch();
          res = fetched.res;
          activeCleanup = fetched.cleanup;
          if (res.status >= 500 && res.status < 600 && attempt === 0) {
            const detail = await res.text().catch(() => '');
            log('warn', 'ollama', `chatOnce 5xx — retrying once`, {
              status: res.status,
              detail: detail.slice(0, 200),
            });
            activeCleanup();
            activeCleanup = null;
            attempt++;
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
          break;
        } catch (e) {
          const err = e as Error;
          const isAbort = err.name === 'AbortError';
          const isTimeout = err.name === 'TimeoutError';
          if (!isAbort && !isTimeout && attempt === 0) {
            log('warn', 'ollama', `chatOnce network error — retrying once`, {
              error: err.message,
            });
            attempt++;
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
          throw e;
        }
      }
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
        retried: attempt > 0,
      });
      // Reconcile the chars/4 heuristic against the real token count Ollama
      // reports — improves pre-call budget estimation, especially for unicode.
      if (data.prompt_eval_count && promptChars > 0) {
        recordCharsPerToken(promptChars, data.prompt_eval_count);
      }
      return data;
    } finally {
      activeCleanup?.();
    }
  }

  async embed(
    model: string,
    input: string | string[],
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<number[][]> {
    const composed = composeSignal(opts.signal, opts.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS);
    try {
      const res = await fetch(this.url('/api/embed'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input }),
        signal: composed.signal,
      });
      if (!res.ok) throw new Error(`Ollama embed HTTP ${res.status}`);
      const data = (await res.json()) as { embeddings?: number[][] };
      return data.embeddings ?? [];
    } catch (e) {
      if (wasTimeout(e)) {
        const t = opts.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
        throw new Error(`Ollama embed timed out after ${t}ms`);
      }
      throw e;
    } finally {
      composed.cleanup();
    }
  }

  async ping(): Promise<PingResult> {
    const composed = composeSignal(undefined, DEFAULT_PING_TIMEOUT_MS);
    try {
      const res = await fetch(this.url('/api/tags'), { method: 'GET', signal: composed.signal });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const data = (await res.json()) as { models?: { name: string }[] };
      return { ok: true, models: (data.models ?? []).map((m) => m.name) };
    } catch (e) {
      if (wasTimeout(e)) {
        return { ok: false, error: `timeout after ${DEFAULT_PING_TIMEOUT_MS}ms` };
      }
      return { ok: false, error: (e as Error).message };
    } finally {
      composed.cleanup();
    }
  }
}

// ----------------------------------------------------------------------------
// Tokenizer-ratio reconciliation lives in agent/budget.ts. OllamaClient feeds
// every observed (promptChars, prompt_eval_count) pair into it via
// recordCharsPerToken() inside chatOnce.
// ----------------------------------------------------------------------------
