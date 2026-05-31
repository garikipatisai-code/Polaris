// Leak-free AbortSignal composition shared by OllamaClient and CloudClient.
//
// Composes a user-supplied AbortSignal with a manual timeout and returns the
// combined signal PLUS a cleanup() the caller MUST invoke in a finally block.
// Implemented as a manual setTimeout/clearTimeout pair (not AbortSignal.timeout,
// whose timer can't be cancelled when the request completes early) so a fast
// call doesn't leave a zombie timer queued for the full timeout window.

export interface ComposedSignal {
  signal: AbortSignal;
  cleanup: () => void;
}

export function composeSignal(
  userSignal: AbortSignal | undefined,
  timeoutMs: number,
): ComposedSignal {
  const ctrl = new AbortController();
  const cleanups: Array<() => void> = [];

  // Forward user aborts.
  if (userSignal) {
    if (userSignal.aborted) {
      ctrl.abort(userSignal.reason);
    } else {
      const onAbort = (): void => {
        if (!ctrl.signal.aborted) ctrl.abort(userSignal.reason);
      };
      userSignal.addEventListener('abort', onAbort, { once: true });
      cleanups.push(() => userSignal.removeEventListener('abort', onAbort));
    }
  }

  // Schedule the timeout, but only if not already aborted.
  if (timeoutMs > 0 && !ctrl.signal.aborted) {
    const timer = setTimeout(() => {
      if (!ctrl.signal.aborted) {
        // Use DOMException to match the shape native AbortSignal.timeout
        // produces, so wasTimeout() detection stays consistent.
        const err =
          typeof DOMException !== 'undefined'
            ? new DOMException(`timed out after ${timeoutMs}ms`, 'TimeoutError')
            : Object.assign(new Error(`timed out after ${timeoutMs}ms`), { name: 'TimeoutError' });
        ctrl.abort(err);
      }
    }, timeoutMs);
    cleanups.push(() => clearTimeout(timer));
  }

  return {
    signal: ctrl.signal,
    cleanup: () => {
      for (const fn of cleanups) {
        try { fn(); } catch { /* defensive */ }
      }
    },
  };
}

/** True if an AbortError came from a timeout signal rather than a user abort. */
export function wasTimeout(e: unknown): boolean {
  const err = e as { name?: string; cause?: { name?: string } } | null;
  if (!err) return false;
  if (err.name === 'TimeoutError') return true;
  return err.cause?.name === 'TimeoutError';
}
