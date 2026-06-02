// Tab manager tools for M3.
//
// Five ToolHandler exports: tab.open, tab.close, tab.list, tab.screenshot,
// tab.wait_loaded — plus a small per-task ownership module so the
// orchestrator can clean up on ABORT.
//
// Ownership rules:
//   * `tab.open` registers the new tabId under ctx.taskId.
//   * `tab.list` returns ONLY tabs owned by the current task — the agent
//     should never see system / unrelated user tabs.
//   * `tab.close` refuses to close a tab the current task does not own
//     (non-fatal: the model can retry with a different tabId).
//   * `closeOwnedTabs(taskId)` is the abort cleanup hook the orchestrator
//     calls when a task transitions to ABORTED. Tolerates races where the
//     tab has already been closed by the user or chrome.
//
// Screenshot dimension parsing:
//   In the MV3 service worker context we can't construct an Image element
//   to discover a captured PNG's dimensions. Instead we parse the raw PNG
//   header bytes — first 8 bytes are the signature, next 4 the IHDR chunk
//   length, next 4 are 'IHDR', then width (big-endian u32) and height
//   (big-endian u32). We only need the first ~24 bytes after base64 decode.

import { z } from 'zod';
import type { ToolHandler } from '../registry';
import { BrowserToolError, withBrowserTimeout } from './lifecycle';
import * as store from '../../state_store';
import { cacheScreenshot } from './vision';
import { clearElementCache } from './aria_types';

// ──────────────────────────────────────────────────────────────────────
// Ownership tracking — both in-memory (fast lookup) and persisted to hot
// state (so SW restart doesn't leak tabs).
//
// addOwned / removeOwned mirror the in-memory map into AgentStateHot.ownedTabs
// via store.patchHot. closeOwnedTabs reads from hot state if the in-memory
// map is empty (covers the "post-SW-restart, never opened during this
// instance" case). closeOwnedTabs(taskId) at terminal phase is the
// authoritative cleanup point — both stores are cleared.
// ──────────────────────────────────────────────────────────────────────

const ownedTabs = new Map<string /*taskId*/, Set<number /*tabId*/>>();

/**
 * Returns the set of tabIds opened by `tab.open` under the given taskId.
 * Synchronous: returns whatever's in the in-memory map. For a fresh SW
 * restart where the map is empty, callers should defer to the
 * `closeOwnedTabs` path which loads from hot state.
 */
export function getOwnedTabs(taskId: string): number[] {
  const set = ownedTabs.get(taskId);
  return set ? [...set] : [];
}

/**
 * Close every tab owned by `taskId`. Called by the orchestrator at terminal
 * phase. Reads from in-memory cache; if empty (post-SW-restart), falls back
 * to AgentStateHot.ownedTabs so we don't leak tabs across SW restarts.
 *
 * Tolerates "tab already closed" silently. The owned-set is cleared from
 * both stores at the end regardless.
 */
export async function closeOwnedTabs(taskId: string): Promise<void> {
  let ids = getOwnedTabs(taskId);
  if (ids.length === 0) {
    // Post-SW-restart fallback: pull persisted owned-tab ids from hot state.
    try {
      const hot = await store.loadHot();
      if (hot && hot.taskId === taskId) {
        ids = [...hot.ownedTabs];
      }
    } catch {
      // No hot state or unreadable; nothing to clean up.
    }
  }
  if (ids.length === 0) return;
  for (const id of ids) {
    try {
      await chromeTabsRemove(id);
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (!/No tab with id/i.test(msg)) {
        console.warn(`[polaris] closeOwnedTabs(${taskId}) tab ${id}:`, msg);
      }
    }
  }
  ownedTabs.delete(taskId);
  // Clear persisted record. Best-effort: if hot state is gone (concurrent
  // reset) the patch will throw; we swallow because the goal is "no leaks"
  // and there's nothing left to leak.
  try {
    const hot = await store.loadHot();
    if (hot && hot.taskId === taskId && hot.ownedTabs.length > 0) {
      await store.patchHot({ ownedTabs: [] });
    }
  } catch {
    /* see comment above */
  }
}

/** Test-only helper: wipe ownership state across all tasks. */
export function _resetOwnership(): void {
  ownedTabs.clear();
}

async function addOwned(taskId: string, tabId: number): Promise<void> {
  let set = ownedTabs.get(taskId);
  if (!set) {
    set = new Set<number>();
    ownedTabs.set(taskId, set);
  }
  set.add(tabId);
  // Mirror to hot state. Best-effort — if no hot state exists (e.g., the
  // task ended between tool dispatch and persist), the in-memory record
  // still gets cleaned up at terminal phase.
  try {
    const hot = await store.loadHot();
    if (hot && hot.taskId === taskId && !hot.ownedTabs.includes(tabId)) {
      await store.patchHot({ ownedTabs: [...hot.ownedTabs, tabId] });
    }
  } catch {
    /* see comment above */
  }
}

async function removeOwned(taskId: string, tabId: number): Promise<boolean> {
  const set = ownedTabs.get(taskId);
  const had = set?.delete(tabId) ?? false;
  if (set && set.size === 0) ownedTabs.delete(taskId);
  // Mirror removal to hot state.
  try {
    const hot = await store.loadHot();
    if (hot && hot.taskId === taskId && hot.ownedTabs.includes(tabId)) {
      await store.patchHot({
        ownedTabs: hot.ownedTabs.filter((id) => id !== tabId),
      });
    }
  } catch {
    /* see comment above */
  }
  return had;
}

function isOwned(taskId: string, tabId: number): boolean {
  return ownedTabs.get(taskId)?.has(tabId) ?? false;
}

/**
 * Lazy hydration of the in-memory ownership cache from persisted hot
 * state. No-op when the cache is already populated for this task.
 *
 * Solves the post-SW-restart case: after Chrome suspends and revives the
 * service worker, the module-level `ownedTabs` Map is empty, but
 * `AgentStateHot.ownedTabs` still has the previous lifetime's tab ids.
 * Without this hydration, `tab.close` and `tab.list` would behave as if
 * the agent never opened any tabs — failing closed-by-default ownership
 * checks for tabs the user (and the IDB-persisted state) believe ARE
 * owned.
 *
 * `closeOwnedTabs` already had its own fallback path; this generalises
 * the same idea so `tab.close` and `tab.list` work post-restart too.
 */
async function hydrateOwnership(taskId: string): Promise<void> {
  if (ownedTabs.has(taskId)) return;
  try {
    const hot = await store.loadHot();
    if (hot && hot.taskId === taskId && hot.ownedTabs.length > 0) {
      ownedTabs.set(taskId, new Set(hot.ownedTabs));
    }
  } catch {
    // No hot state or unreadable; nothing to hydrate. The action will
    // fail closed-by-default which is the correct outcome.
  }
}

// ──────────────────────────────────────────────────────────────────────
// Promise-wrapped chrome.tabs helpers.
//
// chrome.tabs.* in MV3 already returns a Promise when called without a
// callback. We wrap each one anyway so that:
//   * runtime.lastError-shaped failures surface as rejections we can match
//   * legacy callback-style mocks in tests work via the Promise overload
// ──────────────────────────────────────────────────────────────────────

async function chromeTabsCreate(opts: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab> {
  return chrome.tabs.create(opts);
}

async function chromeTabsGet(tabId: number): Promise<chrome.tabs.Tab> {
  return chrome.tabs.get(tabId);
}

async function chromeTabsRemove(tabId: number): Promise<void> {
  return chrome.tabs.remove(tabId);
}

// ──────────────────────────────────────────────────────────────────────
// URL validation
// ──────────────────────────────────────────────────────────────────────

const FORBIDDEN_SCHEMES = ['chrome-extension:', 'chrome:', 'file:'] as const;

function validateNavUrl(raw: string): URL {
  // Auto-prepend https:// when no scheme is present (models often drop it on replan).
  const normalized = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new BrowserToolError(`tab.open: invalid URL: ${truncate(raw, 100)}`, {
      fatal: false,
    });
  }
  // Only http(s) navigation is allowed for the agent. Extension internals,
  // file:// (local disk) and chrome:// (browser settings) are off-limits;
  // the agent should never be steered there.
  if (FORBIDDEN_SCHEMES.includes(parsed.protocol as (typeof FORBIDDEN_SCHEMES)[number])) {
    throw new BrowserToolError(`tab.open: forbidden URL scheme ${parsed.protocol}`, {
      fatal: true,
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BrowserToolError(
      `tab.open: unsupported URL scheme ${parsed.protocol} (use http or https)`,
      { fatal: false },
    );
  }
  return parsed;
}

// ──────────────────────────────────────────────────────────────────────
// PNG header parser — extract width/height from a data URI without
// constructing an Image (not available in MV3 SW contexts).
// ──────────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface PngDimensions {
  widthPx: number;
  heightPx: number;
}

/**
 * Parse a PNG data URI's header to extract width and height. Returns
 * `null` if the URI is not a recognizable PNG. Only inspects the first
 * ~30 bytes after base64 decode, so it's cheap on large screenshots.
 */
export function parsePngDimensions(dataUri: string): PngDimensions | null {
  if (typeof dataUri !== 'string') return null;
  // Accept either "data:image/png;base64,..." or "data:image/png,..." — we
  // only know how to decode base64. Anything else returns null.
  const m = /^data:image\/png(?:;charset=[^;,]+)?;base64,(.+)$/i.exec(dataUri);
  if (!m) return null;
  const b64 = m[1];
  // We only need 24 bytes (signature + IHDR + width + height). base64 packs
  // 3 bytes per 4 chars, so 32 chars are enough. Decoding the whole image
  // would be wasteful for screenshots that can be hundreds of KB.
  const slice = b64.slice(0, 64);
  let bytes: Uint8Array;
  try {
    bytes = base64Decode(slice);
  } catch {
    return null;
  }
  if (bytes.length < 24) return null;
  // Signature check.
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }
  // IHDR chunk type at offset 12: 'I','H','D','R' = 0x49,0x48,0x44,0x52.
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    return null;
  }
  // Width at offset 16, height at offset 20 — both big-endian u32.
  const widthPx = readU32BE(bytes, 16);
  const heightPx = readU32BE(bytes, 20);
  if (widthPx <= 0 || heightPx <= 0) return null;
  return { widthPx, heightPx };
}

function readU32BE(buf: Uint8Array, offset: number): number {
  // (a<<24) coerces to signed; use *0x1000000 to stay unsigned in JS numbers.
  return (
    buf[offset] * 0x1000000 +
    ((buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3])
  );
}

/**
 * Tiny base64 decoder. We can't rely on `atob` / `Buffer` being uniformly
 * available across SW + Node test contexts, so we do it ourselves. Only
 * decodes the leading characters we pass in — enough for the PNG header.
 */
function base64Decode(s: string): Uint8Array {
  // Prefer the standard `atob` if present (SW + browsers + Node 18+).
  // Fall back to a manual decode for older Node test envs.
  const cleaned = s.replace(/[\r\n\s]/g, '');
  if (typeof atob === 'function') {
    const bin = atob(cleaned.replace(/=+$/, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Manual fallback (matches atob behavior for the prefix we care about).
  const lookup = new Uint8Array(256);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < alphabet.length; i++) lookup[alphabet.charCodeAt(i)] = i;
  const padded = cleaned.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((padded.length * 3) / 4));
  let writeIdx = 0;
  for (let i = 0; i + 3 < padded.length; i += 4) {
    const a = lookup[padded.charCodeAt(i)];
    const b = lookup[padded.charCodeAt(i + 1)];
    const c = lookup[padded.charCodeAt(i + 2)];
    const d = lookup[padded.charCodeAt(i + 3)];
    out[writeIdx++] = (a << 2) | (b >> 4);
    out[writeIdx++] = ((b & 0x0f) << 4) | (c >> 2);
    out[writeIdx++] = ((c & 0x03) << 6) | d;
  }
  return out.subarray(0, writeIdx);
}

// ──────────────────────────────────────────────────────────────────────
// tab.open
// ──────────────────────────────────────────────────────────────────────

const tabOpenArgs = z.object({
  url: z.string().min(1).max(2000),
  waitForLoad: z.boolean().optional(),
});

const tabOpenOutput = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  tabId: z.number().int().optional(),
  url: z.string().optional(),
});

export const tabOpenTool: ToolHandler<
  z.infer<typeof tabOpenArgs>,
  z.infer<typeof tabOpenOutput>
> = {
  name: 'tab.open',
  description:
    'Open a URL in a new background tab and wait for it to finish loading. Returns the new tabId and the resolved URL. Tabs opened by this tool are tracked per-task and are auto-closed on abort.',
  argsSchema: tabOpenArgs,
  outputSchema: tabOpenOutput,
  parametersJSON: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
        description: 'Absolute http(s) URL to open. chrome://, file://, and chrome-extension:// are rejected.',
      },
      waitForLoad: {
        type: 'boolean',
        description: 'Wait until the tab finishes loading before returning. Default true.',
      },
    },
    required: ['url'],
  },
  execute: async (args, ctx) => {
    let parsed: URL;
    try {
      parsed = validateNavUrl(args.url);
    } catch (e) {
      if (e instanceof BrowserToolError && !e.fatal) {
        return { ok: false, error: e.message };
      }
      throw e;
    }
    const waitForLoad = args.waitForLoad !== false; // default true

    return withBrowserTimeout(
      async () => {
        // Open in a background (inactive) tab so the user's foreground
        // experience isn't disrupted while the agent works.
        const tab = await chromeTabsCreate({ url: parsed.toString(), active: false });
        const tabId = tab.id;
        if (typeof tabId !== 'number') {
          return { ok: false, error: 'tab.open: chrome.tabs.create returned no tab id' };
        }
        await addOwned(ctx.taskId, tabId);

        if (!waitForLoad) {
          return { ok: true as const, tabId, url: tab.url ?? parsed.toString() };
        }

        // Poll for completion. 30s budget; the outer withBrowserTimeout
        // wraps this in a 35s safety net so we always exit cleanly.
        const start = Date.now();
        const deadline = start + 30_000;
        let last: chrome.tabs.Tab = tab;
        while (Date.now() < deadline) {
          last = await chromeTabsGet(tabId);
          if (last.status === 'complete') {
            return { ok: true as const, tabId, url: last.url ?? parsed.toString() };
          }
          await sleep(100);
        }
        return { ok: false, error: 'tab.open: load timeout after 30s' };
      },
      35_000,
      'tab.open',
    );
  },
};

// ──────────────────────────────────────────────────────────────────────
// tab.close
// ──────────────────────────────────────────────────────────────────────

const tabCloseArgs = z.object({ tabId: z.number().int() });
const tabCloseOutput = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});

export const tabCloseTool: ToolHandler<
  z.infer<typeof tabCloseArgs>,
  z.infer<typeof tabCloseOutput>
> = {
  name: 'tab.close',
  description:
    'Close a tab owned by the current task. Returns {ok: false, error} on failure instead of throwing.',
  argsSchema: tabCloseArgs,
  outputSchema: tabCloseOutput,
  parametersJSON: {
    type: 'object',
    properties: {
      tabId: { type: 'integer', description: 'Tab id returned by tab.open.' },
    },
    required: ['tabId'],
  },
  execute: async (args, ctx) => {
    await hydrateOwnership(ctx.taskId);
    if (!isOwned(ctx.taskId, args.tabId)) {
      return { ok: false, error: 'tab.close: not owned by current task' };
    }
    try {
      await chromeTabsRemove(args.tabId);
    } catch (e) {
      const msg = (e as Error).message ?? '';
      // Tolerate already-closed: chrome reports this as "No tab with id N".
      if (!/No tab with id/i.test(msg)) {
        // Other failures we surface to the model as non-fatal.
        return { ok: false, error: `tab.close: ${truncate(msg, 100)}` };
      }
    }
    await removeOwned(ctx.taskId, args.tabId);
    clearElementCache(args.tabId);
    return { ok: true as const };
  },
};

// ──────────────────────────────────────────────────────────────────────
// tab.list
// ──────────────────────────────────────────────────────────────────────

// Note: not using `.strict()` — qwen3.5:4b sometimes hallucinates extra
// keys ("reason", "_thought") into a no-arg call. Be permissive here so a
// single stray field doesn't tank an otherwise-valid list.
const tabListArgs = z.object({});
const tabListOutput = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  tabs: z.array(
    z.object({ tabId: z.number().int(), url: z.string(), title: z.string() }),
  ),
});

/**
 * Owned tabs with live url + title (hydrates from hot state post-SW-restart,
 * drops tabs that have vanished). Single source of truth shared by tab.list
 * and the Executor prompt's OPEN TABS section. Returns [] when chrome.tabs is
 * unavailable (e.g. unit tests with no tabs mock).
 */
export async function getOwnedTabsDetailed(
  taskId: string,
): Promise<{ tabId: number; url: string; title: string }[]> {
  await hydrateOwnership(taskId);
  const ids = getOwnedTabs(taskId);
  if (ids.length === 0) return [];
  // Guard for test / SW environments where chrome.tabs is absent — never
  // throw (this runs every Executor turn). Falls back to no tabs listed.
  if (typeof (globalThis as unknown as { chrome?: { tabs?: unknown } }).chrome?.tabs === 'undefined') {
    return [];
  }
  const out: { tabId: number; url: string; title: string }[] = [];
  for (const id of ids) {
    try {
      const tab = await chromeTabsGet(id);
      out.push({ tabId: id, url: tab.url ?? '', title: tab.title ?? '' });
    } catch {
      // Tab vanished — drop it so the model stops seeing it.
      await removeOwned(taskId, id);
    }
  }
  return out;
}

export const tabListTool: ToolHandler<
  z.infer<typeof tabListArgs>,
  z.infer<typeof tabListOutput>
> = {
  name: 'tab.list',
  description:
    'List the tabs currently owned by this task (i.e., previously opened with `tab.open`). Returns tabId, url, and title for each.',
  argsSchema: tabListArgs,
  outputSchema: tabListOutput,
  parametersJSON: {
    type: 'object',
    properties: {},
  },
  execute: async (_args, ctx) => {
    return { ok: true as const, tabs: await getOwnedTabsDetailed(ctx.taskId) };
  },
};

// ──────────────────────────────────────────────────────────────────────
// tab.screenshot
// ──────────────────────────────────────────────────────────────────────

const tabScreenshotArgs = z.object({ tabId: z.number().int() });
const tabScreenshotOutput = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  dataUri: z.string().optional(),
  widthPx: z.number().int().optional(),
  heightPx: z.number().int().optional(),
});

const MIN_VISION_WIDTH_PX = 1200; // see Polaris CLAUDE.md vision notes

export const tabScreenshotTool: ToolHandler<
  z.infer<typeof tabScreenshotArgs>,
  z.infer<typeof tabScreenshotOutput>
> = {
  name: 'tab.screenshot',
  description:
    'Capture a PNG screenshot of the visible area of a tab and return it as a data URI plus the image dimensions in pixels. The active tab is restored after capture.',
  argsSchema: tabScreenshotArgs,
  outputSchema: tabScreenshotOutput,
  parametersJSON: {
    type: 'object',
    properties: {
      tabId: { type: 'integer', description: 'Tab id returned by tab.open.' },
    },
    required: ['tabId'],
  },
  execute: async (args) => {
    return withBrowserTimeout(
      async () => {
        // Use CDP Page.captureScreenshot via chrome.debugger rather than
        // chrome.tabs.captureVisibleTab, because the latter requires either
        // <all_urls> host_permission or activeTab consent on the specific
        // tab — and programmatically-opened tabs don't carry activeTab
        // consent. We already have the 'debugger' permission.
        const target: { tabId: number } = { tabId: args.tabId };
        try {
          await chrome.debugger.attach(target, '1.3');
        } catch (e) {
          return {
            ok: false as const,
            error: `tab.screenshot: could not attach debugger to tab ${args.tabId}: ${(e as Error).message}`,
          };
        }

        let dataUri: string;
        try {
          const result = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
            format: 'png',
            fromSurface: true,
          }) as { data?: string } | undefined;
          const b64 = result?.data;
          if (!b64) {
            return {
              ok: false as const,
              error: 'tab.screenshot: Page.captureScreenshot returned no data',
            };
          }
          dataUri = `data:image/png;base64,${b64}`;
        } finally {
          try { await chrome.debugger.detach(target); } catch { /* best-effort */ }
        }

        if (dataUri.length < 1000) {
          return {
            ok: false as const,
            error: 'tab.screenshot: too small — image may have failed',
          };
        }

        // Cache for vision.ground lookups by tabId
        cacheScreenshot(args.tabId, dataUri);

        const dims = parsePngDimensions(dataUri);
        const widthPx = dims?.widthPx ?? 0;
        const heightPx = dims?.heightPx ?? 0;

        if (widthPx > 0 && widthPx < MIN_VISION_WIDTH_PX) {
          console.warn(
            `[polaris] tab.screenshot: width ${widthPx}px < ${MIN_VISION_WIDTH_PX}px — vision quality will degrade`,
          );
        }

        return { ok: true as const, dataUri, widthPx, heightPx };
      },
      10_000,
      'tab.screenshot',
    );
  },
};

// ──────────────────────────────────────────────────────────────────────
// tab.wait_loaded
// ──────────────────────────────────────────────────────────────────────

const tabWaitArgs = z.object({
  tabId: z.number().int(),
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
});

const tabWaitOutput = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  status: z.union([z.literal('complete'), z.literal('loading')]).optional(),
});

export const tabWaitLoadedTool: ToolHandler<
  z.infer<typeof tabWaitArgs>,
  z.infer<typeof tabWaitOutput>
> = {
  name: 'tab.wait_loaded',
  description:
    'Poll a tab until status is "complete" or the timeout (default 15000ms) elapses. Returns the final status. Useful after a navigation triggered by a click.',
  argsSchema: tabWaitArgs,
  outputSchema: tabWaitOutput,
  parametersJSON: {
    type: 'object',
    properties: {
      tabId: { type: 'integer', description: 'Tab id to poll.' },
      timeoutMs: {
        type: 'integer',
        minimum: 100,
        maximum: 60_000,
        description: 'Max time to wait, ms (default 15000).',
      },
    },
    required: ['tabId'],
  },
  execute: async (args) => {
    const timeoutMs = args.timeoutMs ?? 15_000;
    const deadline = Date.now() + timeoutMs;
    // First read immediately — if the tab is already complete, return
    // without ever sleeping. (Common case after a navigation has settled.)
    let last: chrome.tabs.Tab;
    try {
      last = await chromeTabsGet(args.tabId);
    } catch (e) {
      return { ok: false as const, error: `tab.wait_loaded: ${truncate((e as Error).message, 100)}` };
    }
    if (last.status === 'complete') return { ok: true as const, status: 'complete' as const };

    while (Date.now() < deadline) {
      await sleep(200);
      try {
        last = await chromeTabsGet(args.tabId);
      } catch (e) {
        return { ok: false as const, error: `tab.wait_loaded: ${truncate((e as Error).message, 100)}` };
      }
      if (last.status === 'complete') return { ok: true as const, status: 'complete' as const };
    }
    // Timed out — return the final observed status (typically 'loading')
    // rather than throwing. The model can decide whether to retry or move on.
    return { ok: true as const, status: 'loading' as const };
  },
};

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
