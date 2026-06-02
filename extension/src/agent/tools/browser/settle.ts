// tab.dom_settle — wait for a tab's DOM to stop mutating before extraction.
//
// Many pages (Amazon search results, infinite lists) render a skeleton first,
// then fetch + inject content via JS. tab.wait_loaded only sees readyState
// 'complete', which fires before that injection. This tool installs a
// MutationObserver in the page and resolves once mutations have been idle for
// `quietMs`, or after `timeoutMs` (whichever comes first).
//
// Non-fatal on every failure path: the model can extract anyway.

import { z } from 'zod';
import type { ToolHandler } from '../registry';
import { withBrowserTimeout } from './lifecycle';

const argsSchema = z.object({
  tabId: z.number().int(),
  quietMs: z.number().int().min(50).max(5_000).optional(),
  timeoutMs: z.number().int().min(200).max(30_000).optional(),
});

const outputSchema = z.object({
  ok: z.boolean(),
  settled: z.boolean(),
  waitedMs: z.number().int(),
  error: z.string().optional(),
});

/** Build the in-page settle expression. Resolves {settled, waitedMs}. */
function settleExpression(quietMs: number, timeoutMs: number): string {
  // ES5-safe (var / function) on purpose — this string is evaluated in an
  // arbitrary page context that may disable or predate modern syntax.
  return `(() => new Promise((resolve) => {
    var start = Date.now();
    var done = false;
    var quiet;
    var obs;
    function finish(settled) {
      if (done) return; done = true;
      try { if (obs) obs.disconnect(); } catch (e) {}
      clearTimeout(quiet);
      resolve({ settled: settled, waitedMs: Date.now() - start });
    }
    try {
      obs = new MutationObserver(function () {
        clearTimeout(quiet);
        quiet = setTimeout(function () { finish(true); }, ${quietMs});
      });
      obs.observe(document.documentElement || document, { childList: true, subtree: true, characterData: true });
    } catch (e) { /* MutationObserver unavailable — fall through; the quiet timer below still resolves the promise */ }
    quiet = setTimeout(function () { finish(true); }, ${quietMs});
    setTimeout(function () { finish(false); }, ${timeoutMs});
  }))()`;
}

export const tabDomSettleTool: ToolHandler<z.infer<typeof argsSchema>, z.infer<typeof outputSchema>> = {
  name: 'tab.dom_settle',
  description:
    'Wait until a tab\'s DOM stops changing (lazy-loaded content has rendered). ' +
    'Call after a navigation or search submit, BEFORE aria.extract / page.extract. ' +
    'Returns {settled, waitedMs}.',
  argsSchema,
  outputSchema,
  parametersJSON: {
    type: 'object',
    properties: {
      tabId: { type: 'integer', description: 'Tab id from tab.open / tab.list.' },
      quietMs: { type: 'integer', minimum: 50, maximum: 5000, description: 'Idle window before declaring settled (default 500).' },
      timeoutMs: { type: 'integer', minimum: 200, maximum: 30000, description: 'Max wait (default 5000).' },
    },
    required: ['tabId'],
  },
  execute: async (args) => {
    const quietMs = args.quietMs ?? 500;
    const timeoutMs = args.timeoutMs ?? 5_000;
    const target = { tabId: args.tabId };
    return withBrowserTimeout(async () => {
      try {
        await chrome.debugger.attach(target, '1.3');
      } catch (e) {
        const msg = (e as Error).message ?? '';
        const hint = /no tab with given id/i.test(msg) ? ' — call tab.list() to discover active tabs' : '';
        return { ok: false as const, settled: false, waitedMs: 0, error: `tab.dom_settle: ${msg}${hint}` };
      }
      try {
        const res = (await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
          expression: settleExpression(quietMs, timeoutMs),
          awaitPromise: true,
          returnByValue: true,
        })) as { result?: { value?: { settled?: boolean; waitedMs?: number } }; exceptionDetails?: unknown } | undefined;
        if (res?.exceptionDetails) {
          // The page expression threw but CDP returned normally — surface it
          // rather than silently reporting settled:false.
          console.warn('[polaris] tab.dom_settle: page expression threw', res.exceptionDetails);
        }
        const value = res?.result?.value;
        return {
          ok: true as const,
          settled: value?.settled ?? false,
          waitedMs: value?.waitedMs ?? 0,
        };
      } catch (e) {
        // Runtime.evaluate / CDP failure (e.g. debugger session dropped
        // mid-flight). Non-fatal: the model can still attempt extraction.
        return { ok: false as const, settled: false, waitedMs: 0, error: `tab.dom_settle: ${(e as Error).message}` };
      } finally {
        try { await chrome.debugger.detach(target); } catch { /* best-effort */ }
      }
    }, timeoutMs + 2_000, 'tab.dom_settle');
  },
};
