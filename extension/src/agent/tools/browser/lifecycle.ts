// Tool lifecycle utilities for M3 browser tools.
//
// Browser tools (chrome.debugger, chrome.tabs, network calls) have failure
// modes that pure mock tools don't: timeouts, navigation failures, permission
// denials, tab crashes, model-incompatible structured responses. This module
// gives those a typed contract the agent loop can react to:
//
//   throw new BrowserToolError(msg, { fatal: true })
//     → registry.dispatch returns { ok:false, fatal:true, error }
//     → orchestrator's circuit breaker aborts the task immediately
//
//   throw new BrowserToolError(msg, { fatal: false })
//     → registry.dispatch returns { ok:false, error } (no fatal flag)
//     → model retries with different args
//
// Plain Error throws (legacy tools) remain ok:false, error — same as before.
//
// withBrowserTimeout wraps any async fn with a manual setTimeout/clearTimeout
// pair (NOT AbortSignal.timeout — that timer can't be cancelled if the fn
// resolves early, leaving zombie timers in the SW event loop). On expiry
// throws a non-fatal BrowserToolError so the model can retry.

export class BrowserToolError extends Error {
  public readonly fatal: boolean;
  constructor(message: string, opts: { fatal: boolean }) {
    super(message);
    this.name = 'BrowserToolError';
    this.fatal = opts.fatal;
  }
}

/**
 * Wrap an async function with a timeout. On expiry, throws a non-fatal
 * BrowserToolError so the agent's model can retry with different args.
 *
 * Implementation note: uses manual setTimeout + clearTimeout rather than
 * `AbortSignal.timeout`. The latter creates a timer that can't be cleared
 * when the operation completes early, leaking a reference for the full
 * timeout window. For an agent loop with dozens of tool calls, that adds up.
 */
export async function withBrowserTimeout<T>(
  fn: () => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new BrowserToolError(`${label} timed out after ${ms}ms`, { fatal: false }));
    }, ms);
  });
  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
