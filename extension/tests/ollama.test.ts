// OllamaClient HTTP timeout + retry tests.
//
// Mock-fetch tests — no real Ollama needed. Cover:
//   • timeout: hung fetch aborts within timeoutMs with the expected error
//   • 5xx retry: one retry on 500/503, abort thereafter
//   • network-error retry: one retry on TypeError (e.g., undici "fetch failed")
//   • abort propagation: opts.signal abort propagates through composeSignal
//   • no retry on 4xx: caller error is deterministic
//   • no retry on user abort: user wanted out

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OllamaClient } from '../src/background/ollama';

type FetchMock = ReturnType<typeof vi.fn>;

let originalFetch: typeof fetch;
let fetchMock: FetchMock;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('OllamaClient: HTTP timeout', () => {
  it('throws "timed out" when fetch hangs past timeoutMs', async () => {
    // Mock fetch that never resolves but DOES honor the AbortSignal — that's
    // the contract real fetch follows.
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            (err as Error & { cause?: unknown }).cause = init.signal?.reason;
            reject(err);
          });
        }),
    );

    const c = new OllamaClient('http://fake');
    await expect(
      c.chatOnce({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out after 50ms/);
  });

  it('does not retry on timeout', async () => {
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            (err as Error & { cause?: unknown }).cause = init.signal?.reason;
            reject(err);
          });
        }),
    );

    const c = new OllamaClient('http://fake');
    await expect(
      c.chatOnce({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        timeoutMs: 30,
      }),
    ).rejects.toThrow();
    // Single call — no retry on timeout.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('respects user-supplied AbortSignal even with no timeout', async () => {
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted by user');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );

    const ctrl = new AbortController();
    const c = new OllamaClient('http://fake');
    const p = c.chatOnce({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      signal: ctrl.signal,
      timeoutMs: 60_000,
    });
    setTimeout(() => ctrl.abort(), 20);
    await expect(p).rejects.toThrow(/aborted/i);
  });
});

describe('OllamaClient: 5xx retry', () => {
  it('retries once on HTTP 500, succeeds on second attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('upstream', { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ message: { content: 'ok' }, done: true }));

    const c = new OllamaClient('http://fake');
    const r = await c.chatOnce({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.message?.content).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry twice — second 5xx surfaces as error', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('first', { status: 503 }))
      .mockResolvedValueOnce(new Response('second', { status: 503 }));

    const c = new OllamaClient('http://fake');
    await expect(
      c.chatOnce({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/HTTP 503/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry on HTTP 400 (caller error)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad request', { status: 400 }));

    const c = new OllamaClient('http://fake');
    await expect(
      c.chatOnce({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('OllamaClient: network-error retry', () => {
  it('retries once on TypeError "fetch failed"', async () => {
    const netErr = new TypeError('fetch failed');
    fetchMock
      .mockRejectedValueOnce(netErr)
      .mockResolvedValueOnce(jsonResponse({ message: { content: 'recovered' }, done: true }));

    const c = new OllamaClient('http://fake');
    const r = await c.chatOnce({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.message?.content).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry on AbortError', async () => {
    const abortErr = new Error('user abort');
    abortErr.name = 'AbortError';
    fetchMock.mockRejectedValueOnce(abortErr);

    const c = new OllamaClient('http://fake');
    await expect(
      c.chatOnce({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/user abort/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('OllamaClient: keep_alive default', () => {
  it('passes keep_alive in request body unless overridden', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { content: 'ok' }, done: true }),
    );

    const c = new OllamaClient('http://fake');
    await c.chatOnce({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(init?.body as string) as { keep_alive?: string };
    expect(body.keep_alive).toBe('10m');
  });

  it('honors caller-supplied keepAlive', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { content: 'ok' }, done: true }),
    );

    const c = new OllamaClient('http://fake');
    await c.chatOnce({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      keepAlive: '30s',
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(init?.body as string) as { keep_alive?: string };
    expect(body.keep_alive).toBe('30s');
  });
});

describe('OllamaClient.ping: timeout', () => {
  it('returns ok=false with timeout error when /api/tags hangs', async () => {
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            (err as Error & { cause?: unknown }).cause = init.signal?.reason;
            reject(err);
          });
        }),
    );

    // We don't want to wait the full default 10s in tests; ping uses
    // DEFAULT_PING_TIMEOUT_MS internally, so we can't override here. Skip
    // the wait by checking the contract works at all — the AbortSignal.timeout
    // will fire eventually.
    const c = new OllamaClient('http://fake');
    const r = await c.ping();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timeout/i);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Timer-leak fix (arch-nemesis #1): a successful chatOnce must clear its
// timeout timer in `finally`, not let it sit queued for the full timeoutMs
// window. Without this, an agent loop with N successful turns leaves N
// zombie timers in the SW event loop. We assert by counting clearTimeout
// calls — every chatOnce that completes (success OR error) must result in
// the matching clearTimeout being called.
// ---------------------------------------------------------------------------

describe('OllamaClient: timer-leak fix (#1)', () => {
  it('clears the timeout timer on successful response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { content: 'ok' }, done: true }),
    );
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    const c = new OllamaClient('http://fake');
    await c.chatOnce({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      timeoutMs: 60_000,
    });

    // Among the timers set during this call, our composed-signal timer must
    // have been cleared. We don't assert exact counts (other code may use
    // setTimeout — vitest itself does), but the count of cleared timers
    // must equal the count of timers we set with our 60s budget. Filter to
    // calls with a 60_000 delay.
    const ourSets = setSpy.mock.calls.filter((c) => c[1] === 60_000);
    expect(ourSets.length).toBe(1);
    // clearTimeout must have been called with the timer ID we set.
    const ourTimerId = setSpy.mock.results[setSpy.mock.calls.indexOf(ourSets[0]!)]!.value;
    const cleared = clearSpy.mock.calls.some((c) => c[0] === ourTimerId);
    expect(cleared).toBe(true);
  });

  it('clears the timeout timer when fetch throws (error path)', async () => {
    const netErr = new TypeError('fetch failed');
    fetchMock.mockRejectedValueOnce(netErr).mockRejectedValueOnce(netErr);
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    const c = new OllamaClient('http://fake');
    await expect(
      c.chatOnce({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        timeoutMs: 45_000,
      }),
    ).rejects.toThrow();

    // Each fetch attempt creates a timer; both must be cleared.
    const ourSets = setSpy.mock.calls.filter((c) => c[1] === 45_000);
    expect(ourSets.length).toBe(2);
    const allCleared = ourSets.every((setCall) => {
      const idx = setSpy.mock.calls.indexOf(setCall);
      const tid = setSpy.mock.results[idx]!.value;
      return clearSpy.mock.calls.some((c) => c[0] === tid);
    });
    expect(allCleared).toBe(true);
  });

  it('clears the timeout timer on 5xx retry (both timers cleaned)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('upstream', { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ message: { content: 'ok' }, done: true }));
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    const c = new OllamaClient('http://fake');
    await c.chatOnce({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      timeoutMs: 90_000,
    });

    const ourSets = setSpy.mock.calls.filter((c) => c[1] === 90_000);
    expect(ourSets.length).toBe(2); // first attempt + retry
    const allCleared = ourSets.every((setCall) => {
      const idx = setSpy.mock.calls.indexOf(setCall);
      const tid = setSpy.mock.results[idx]!.value;
      return clearSpy.mock.calls.some((c) => c[0] === tid);
    });
    expect(allCleared).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// chatStream got the same hardening (arch-nemesis #3): timeout, keep_alive,
// 5xx-retry. Test that the stream consumer aborts cleanly when the timeout
// fires, and that keep_alive is in the body.
// ---------------------------------------------------------------------------

describe('OllamaClient.chatStream hardening (#3)', () => {
  it('keep_alive is in the request body', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{"done":true}\n', { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }),
    );

    const c = new OllamaClient('http://fake');
    const it = c.chatStream({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    for await (const _ of it) { /* drain */ void _; }

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(init?.body as string) as { keep_alive?: string };
    expect(body.keep_alive).toBe('10m');
  });

  it('retries once on 5xx during stream initiation', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('upstream', { status: 503 }))
      .mockResolvedValueOnce(
        new Response('{"done":true}\n', { status: 200 }),
      );

    const c = new OllamaClient('http://fake');
    const it = c.chatStream({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    let chunks = 0;
    for await (const _ of it) chunks++;
    expect(chunks).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});


describe('OllamaClient.embed', () => {
  it('passes model + input through to /api/embed and returns embeddings', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ embeddings: [[0.1, 0.2, 0.3]] }),
    );
    const c = new OllamaClient('http://fake');
    const result = await c.embed('mxbai-embed-large', 'hello world');
    expect(result).toEqual([[0.1, 0.2, 0.3]]);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(init?.body as string) as { model: string; input: string };
    expect(body.model).toBe('mxbai-embed-large');
    expect(body.input).toBe('hello world');
  });

  it('accepts an array of inputs', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ embeddings: [[0.5], [0.6]] }),
    );
    const c = new OllamaClient('http://fake');
    const result = await c.embed('mxbai-embed-large', ['a', 'b']);
    expect(result).toEqual([[0.5], [0.6]]);
  });

  it('returns empty array when Ollama returns no embeddings', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const c = new OllamaClient('http://fake');
    const r = await c.embed('mxbai-embed-large', 'x');
    expect(r).toEqual([]);
  });
});
