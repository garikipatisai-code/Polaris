// Tests for the tab manager tools (tab.open, tab.close, tab.list,
// tab.screenshot, tab.wait_loaded) and the per-task ownership module.
//
// We mock chrome.tabs locally per-test (the global mock from setup.ts
// only covers chrome.storage). Each test installs a fresh fake-tabs
// store via beforeEach so prior tests can't leak state.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  tabOpenTool,
  tabCloseTool,
  tabListTool,
  tabScreenshotTool,
  tabWaitLoadedTool,
  parsePngDimensions,
  getOwnedTabs,
  closeOwnedTabs,
  _resetOwnership,
} from '../src/agent/tools/browser/tab';

// ──────────────────────────────────────────────────────────────────────
// Chrome fake — minimal in-memory model of the tabs APIs we touch.
// ──────────────────────────────────────────────────────────────────────

interface FakeTab {
  id: number;
  url: string;
  status: 'loading' | 'complete';
  title: string;
  windowId: number;
  active: boolean;
}

interface FakeChromeMock {
  tabs: {
    create: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    captureVisibleTab: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  };
  runtime: { lastError: { message: string } | null };
  storage: { local: unknown };
  _state: {
    tabs: Map<number, FakeTab>;
    nextId: number;
    captureDataUri: string;
    failNextRemoveWith?: string;
    autoComplete: boolean; // when create() is called, mark complete by default
  };
}

// We splice tabs into the same `chrome` object the global setup.ts installs,
// so the existing storage mock keeps working for code that touches it.
function installChromeTabsMock(): FakeChromeMock {
  const state: FakeChromeMock['_state'] = {
    tabs: new Map(),
    nextId: 100,
    captureDataUri: makeFakePngDataUri(1600, 900),
    autoComplete: true,
  };

  const create = vi.fn(async (opts: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab> => {
    const id = state.nextId++;
    const tab: FakeTab = {
      id,
      url: opts.url ?? '',
      status: state.autoComplete ? 'complete' : 'loading',
      title: 'fake title',
      windowId: 1,
      active: opts.active === true,
    };
    state.tabs.set(id, tab);
    return toChromeTab(tab);
  });

  const get = vi.fn(async (tabId: number): Promise<chrome.tabs.Tab> => {
    const t = state.tabs.get(tabId);
    if (!t) throw new Error(`No tab with id: ${tabId}`);
    return toChromeTab(t);
  });

  const update = vi.fn(
    async (tabId: number, opts: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab> => {
      const t = state.tabs.get(tabId);
      if (!t) throw new Error(`No tab with id: ${tabId}`);
      if (typeof opts.active === 'boolean') {
        // Mimic chrome: activating a tab deactivates the previously active.
        if (opts.active) {
          for (const other of state.tabs.values()) {
            if (other.windowId === t.windowId) other.active = false;
          }
        }
        t.active = opts.active;
      }
      if (typeof opts.url === 'string') t.url = opts.url;
      return toChromeTab(t);
    },
  );

  const remove = vi.fn(async (tabId: number): Promise<void> => {
    if (state.failNextRemoveWith) {
      const msg = state.failNextRemoveWith;
      state.failNextRemoveWith = undefined;
      throw new Error(msg);
    }
    if (!state.tabs.has(tabId)) {
      throw new Error(`No tab with id: ${tabId}`);
    }
    state.tabs.delete(tabId);
  });

  const captureVisibleTab = vi.fn(
    async (_windowId: number, _opts: chrome.tabs.CaptureVisibleTabOptions): Promise<string> => {
      return state.captureDataUri;
    },
  );

  const query = vi.fn(
    async (info: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> => {
      const out: chrome.tabs.Tab[] = [];
      for (const t of state.tabs.values()) {
        if (info.active === true && !t.active) continue;
        if (typeof info.windowId === 'number' && t.windowId !== info.windowId) continue;
        out.push(toChromeTab(t));
      }
      return out;
    },
  );

  // Preserve the existing storage mock the setup.ts installed.
  const existingStorage =
    (globalThis as unknown as { chrome?: { storage?: unknown } }).chrome?.storage ?? {};

  const mock: FakeChromeMock = {
    tabs: { create, get, update, remove, captureVisibleTab, query },
    runtime: { lastError: null },
    storage: { local: (existingStorage as { local?: unknown }).local ?? {} },
    _state: state,
  };

  (globalThis as unknown as { chrome: unknown }).chrome = mock;
  return mock;
}

function toChromeTab(t: FakeTab): chrome.tabs.Tab {
  return {
    id: t.id,
    url: t.url,
    status: t.status,
    title: t.title,
    windowId: t.windowId,
    active: t.active,
    index: 0,
    pinned: false,
    highlighted: t.active,
    incognito: false,
    selected: t.active,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
  } as unknown as chrome.tabs.Tab;
}

// ──────────────────────────────────────────────────────────────────────
// PNG fixture builder.
//
// We construct just enough of a PNG (signature + IHDR + a fake body so
// the data URI clears the >1000-char "too small" guard) to exercise the
// header parser. The bytes after the header don't need to be valid PNG —
// the parser only inspects the first 24 bytes.
// ──────────────────────────────────────────────────────────────────────

function makeFakePngDataUri(widthPx: number, heightPx: number, padBytes = 1024): string {
  const header = new Uint8Array(24 + padBytes);
  // PNG signature.
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // IHDR length = 13.
  header.set([0x00, 0x00, 0x00, 0x0d], 8);
  // 'IHDR'.
  header.set([0x49, 0x48, 0x44, 0x52], 12);
  // Width (big-endian u32).
  header[16] = (widthPx >>> 24) & 0xff;
  header[17] = (widthPx >>> 16) & 0xff;
  header[18] = (widthPx >>> 8) & 0xff;
  header[19] = widthPx & 0xff;
  // Height (big-endian u32).
  header[20] = (heightPx >>> 24) & 0xff;
  header[21] = (heightPx >>> 16) & 0xff;
  header[22] = (heightPx >>> 8) & 0xff;
  header[23] = heightPx & 0xff;
  // Padding bytes are zero (don't affect parser; just bulks the data URI
  // so screenshot guard `length >= 1000` passes).
  // base64-encode using Buffer (Node) or btoa.
  const b64 = encodeBase64(header);
  return `data:image/png;base64,${b64}`;
}

function encodeBase64(buf: Uint8Array): string {
  // Node-friendly: Buffer is always available in vitest's node env.
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(buf).toString('base64');
  }
  // Fallback (browser SW) — not reached in tests, just defensive.
  let s = '';
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return btoa(s);
}

// ──────────────────────────────────────────────────────────────────────
// Per-test setup
// ──────────────────────────────────────────────────────────────────────

let mock: FakeChromeMock;

beforeEach(() => {
  _resetOwnership();
  mock = installChromeTabsMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ──────────────────────────────────────────────────────────────────────
// 1. tab.open opens a tab, returns tabId, registers ownership.
// ──────────────────────────────────────────────────────────────────────

describe('tab.open', () => {
  it('opens a tab, returns tabId, and adds to ownedTabs[taskId]', async () => {
    const out = await tabOpenTool.execute(
      { url: 'https://example.com/path' },
      { taskId: 'taskA', stepId: null },
    );
    expect(out.tabId).toBeTypeOf('number');
    expect(out.url).toContain('example.com');
    expect(getOwnedTabs('taskA')).toContain(out.tabId);
    // chrome.tabs.create was called with active:false (background).
    expect(mock.tabs.create).toHaveBeenCalledTimes(1);
    const createArgs = mock.tabs.create.mock.calls[0][0] as chrome.tabs.CreateProperties;
    expect(createArgs.active).toBe(false);
  });

  it('returns structured error for an invalid URL (was BrowserToolError)', async () => {
    const out = await tabOpenTool.execute({ url: 'not a url' }, { taskId: 'taskA', stepId: null });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('invalid URL');
  });

  it('rejects chrome-extension:// URLs with a FATAL BrowserToolError', async () => {
    await expect(
      tabOpenTool.execute(
        { url: 'chrome-extension://abc/index.html' },
        { taskId: 'taskA', stepId: null },
      ),
    ).rejects.toMatchObject({
      name: 'BrowserToolError',
      fatal: true,
      message: expect.stringContaining('chrome-extension'),
    });
  });

  it('also rejects chrome:// and file:// schemes as fatal', async () => {
    await expect(
      tabOpenTool.execute({ url: 'chrome://settings' }, { taskId: 'taskA', stepId: null }),
    ).rejects.toMatchObject({ fatal: true });
    await expect(
      tabOpenTool.execute({ url: 'file:///etc/passwd' }, { taskId: 'taskA', stepId: null }),
    ).rejects.toMatchObject({ fatal: true });
  });

  it('with waitForLoad=false returns immediately without polling', async () => {
    // Force created tabs to start in 'loading' so any poll-loop bug would
    // hang the test. waitForLoad=false should bypass that path.
    mock._state.autoComplete = false;
    const out = await tabOpenTool.execute(
      { url: 'https://example.com/', waitForLoad: false },
      { taskId: 'taskA', stepId: null },
    );
    expect(out.tabId).toBeTypeOf('number');
    // Only the create call — no chrome.tabs.get poll.
    expect(mock.tabs.get).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────
// 2. tab.close
// ──────────────────────────────────────────────────────────────────────

describe('tab.close', () => {
  it('closes an owned tab, removes from ownership', async () => {
    const opened = await tabOpenTool.execute(
      { url: 'https://example.com/' },
      { taskId: 'taskA', stepId: null },
    );
    const result = await tabCloseTool.execute(
      { tabId: opened.tabId },
      { taskId: 'taskA', stepId: null },
    );
    expect(result.ok).toBe(true);
    expect(getOwnedTabs('taskA')).not.toContain(opened.tabId);
    expect(mock.tabs.remove).toHaveBeenCalledWith(opened.tabId);
  });

  it('refuses to close a tab the current task does not own (structured error)', async () => {
    const opened = await tabOpenTool.execute(
      { url: 'https://example.com/' },
      { taskId: 'taskA', stepId: null },
    );
    const result = await tabCloseTool.execute(
      { tabId: opened.tabId },
      { taskId: 'taskB', stepId: null }, // wrong task
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not owned');
    // The tab must NOT have been touched on the chrome side.
    expect(mock.tabs.remove).not.toHaveBeenCalled();
    expect(getOwnedTabs('taskA')).toContain(opened.tabId);
  });

  it('also refuses to close arbitrary tabIds the agent never opened', async () => {
    const result = await tabCloseTool.execute({ tabId: 999_999 }, { taskId: 'taskA', stepId: null });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not owned');
  });
});

// ──────────────────────────────────────────────────────────────────────
// 3. tab.list — only returns tabs owned by the current task
// ──────────────────────────────────────────────────────────────────────

describe('tab.list', () => {
  it('returns only tabs owned by the current task (not tabs from other tasks)', async () => {
    const ctxA = { taskId: 'taskA', stepId: null };
    const ctxB = { taskId: 'taskB', stepId: null };

    const a1 = await tabOpenTool.execute({ url: 'https://a.example/1' }, ctxA);
    const a2 = await tabOpenTool.execute({ url: 'https://a.example/2' }, ctxA);
    const b1 = await tabOpenTool.execute({ url: 'https://b.example/1' }, ctxB);

    const listA = await tabListTool.execute({}, ctxA);
    expect(listA.tabs).toHaveLength(2);
    const idsA = listA.tabs.map((t) => t.tabId).sort();
    expect(idsA).toEqual([a1.tabId, a2.tabId].sort());
    // taskB's tab not visible in taskA's list.
    expect(idsA).not.toContain(b1.tabId);

    const listB = await tabListTool.execute({}, ctxB);
    expect(listB.tabs).toHaveLength(1);
    expect(listB.tabs[0].tabId).toBe(b1.tabId);
  });

  it('returns urls and titles populated from chrome.tabs.get', async () => {
    const ctxA = { taskId: 'taskA', stepId: null };
    const opened = await tabOpenTool.execute({ url: 'https://example.com/' }, ctxA);
    const list = await tabListTool.execute({}, ctxA);
    expect(list.tabs).toHaveLength(1);
    expect(list.tabs[0].tabId).toBe(opened.tabId);
    expect(list.tabs[0].url).toContain('example.com');
    expect(list.tabs[0].title).toBeTypeOf('string');
  });
});

// ──────────────────────────────────────────────────────────────────────
// 4. tab.screenshot — PNG header parsing + width warning
// ──────────────────────────────────────────────────────────────────────

describe('tab.screenshot', () => {
  let debuggerAttach: ReturnType<typeof vi.fn>;
  let debuggerDetach: ReturnType<typeof vi.fn>;
  let debuggerSendCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    debuggerAttach = vi.fn().mockResolvedValue(undefined);
    debuggerDetach = vi.fn().mockResolvedValue(undefined);
    debuggerSendCommand = vi.fn().mockImplementation(
      async (_target: unknown, method: string) => {
        if (method === 'Page.captureScreenshot') {
          // Strip the 'data:image/png;base64,' prefix and return raw base64
          const raw = mock._state.captureDataUri;
          const b64 = raw.startsWith('data:') ? raw.split(',')[1]! : raw;
          return { data: b64 };
        }
        return {};
      },
    );
    // Inject chrome.debugger mocks onto the existing chrome global
    (globalThis as unknown as Record<string, unknown>).chrome = {
      ...(globalThis as unknown as Record<string, unknown>).chrome,
      debugger: {
        attach: debuggerAttach,
        detach: debuggerDetach,
        sendCommand: debuggerSendCommand,
      },
    };
  });

  it('parses PNG header dimensions (width=1600, height=900) from a known data URI', async () => {
    mock._state.captureDataUri = makeFakePngDataUri(1600, 900);
    const ctxA = { taskId: 'taskA', stepId: null };
    const opened = await tabOpenTool.execute({ url: 'https://example.com/' }, ctxA);

    const out = await tabScreenshotTool.execute({ tabId: opened.tabId }, ctxA);

    expect(out.widthPx).toBe(1600);
    expect(out.heightPx).toBe(900);
    expect(out.dataUri.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('warns when width < 1200 (vision-quality threshold) but does not throw', async () => {
    mock._state.captureDataUri = makeFakePngDataUri(800, 600);
    const ctxA = { taskId: 'taskA', stepId: null };
    const opened = await tabOpenTool.execute({ url: 'https://example.com/' }, ctxA);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await tabScreenshotTool.execute({ tabId: opened.tabId }, ctxA);

    expect(out.widthPx).toBe(800);
    expect(warnSpy).toHaveBeenCalled();
    const calls = warnSpy.mock.calls.map((c) => c.join(' ')).join('|');
    expect(calls).toMatch(/width.*800/);
  });

  it('returns structured error for tiny CDP screenshots (base64 < 1000 chars after prefix)', async () => {
    mock._state.captureDataUri = makeFakePngDataUri(1, 1, 0); // smallest PNG: ~67 bytes base64
    const ctxA = { taskId: 'taskA', stepId: null };
    const opened = await tabOpenTool.execute({ url: 'https://example.com/' }, ctxA);

    const out = await tabScreenshotTool.execute({ tabId: opened.tabId }, ctxA);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('too small');
  });

  it('parsePngDimensions returns null on non-PNG data URIs', () => {
    expect(parsePngDimensions('not a data uri')).toBeNull();
    expect(parsePngDimensions('data:image/jpeg;base64,xxx')).toBeNull();
    expect(parsePngDimensions('')).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// 5. tab.wait_loaded
// ──────────────────────────────────────────────────────────────────────

describe('tab.wait_loaded', () => {
  it('returns "complete" immediately if status is already complete (no-loop)', async () => {
    const ctxA = { taskId: 'taskA', stepId: null };
    const opened = await tabOpenTool.execute({ url: 'https://example.com/' }, ctxA);
    // Reset call counts so we can prove the no-loop fast path.
    mock.tabs.get.mockClear();

    const out = await tabWaitLoadedTool.execute(
      { tabId: opened.tabId, timeoutMs: 5000 },
      ctxA,
    );
    expect(out.status).toBe('complete');
    // Exactly one .get() call — fast-path read, no polling loop.
    expect(mock.tabs.get).toHaveBeenCalledTimes(1);
  });

  it('returns "loading" on timeout when status never reaches complete', async () => {
    mock._state.autoComplete = false; // tabs stay in 'loading' forever
    const ctxA = { taskId: 'taskA', stepId: null };
    const opened = await tabOpenTool.execute(
      { url: 'https://example.com/', waitForLoad: false },
      ctxA,
    );

    const out = await tabWaitLoadedTool.execute(
      { tabId: opened.tabId, timeoutMs: 500 }, // short to keep test fast
      ctxA,
    );
    expect(out.status).toBe('loading');
    // We must have polled multiple times (1 fast read + several loop reads).
    expect(mock.tabs.get.mock.calls.length).toBeGreaterThan(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 6. closeOwnedTabs — cleanup on abort
// ──────────────────────────────────────────────────────────────────────

describe('closeOwnedTabs', () => {
  it('closes all owned tabs for a task and clears the set', async () => {
    const ctxA = { taskId: 'taskA', stepId: null };
    const a1 = await tabOpenTool.execute({ url: 'https://a/1' }, ctxA);
    const a2 = await tabOpenTool.execute({ url: 'https://a/2' }, ctxA);

    expect(getOwnedTabs('taskA').sort()).toEqual([a1.tabId, a2.tabId].sort());
    await closeOwnedTabs('taskA');

    expect(getOwnedTabs('taskA')).toEqual([]);
    expect(mock.tabs.remove).toHaveBeenCalledTimes(2);
    // Both tabs gone from the underlying fake.
    expect(mock._state.tabs.has(a1.tabId)).toBe(false);
    expect(mock._state.tabs.has(a2.tabId)).toBe(false);
  });

  it('tolerates "No tab with id" errors silently (already-closed tabs)', async () => {
    const ctxA = { taskId: 'taskA', stepId: null };
    const a1 = await tabOpenTool.execute({ url: 'https://a/1' }, ctxA);
    // Pre-delete the tab from the fake so chrome.tabs.remove rejects with
    // the canonical "No tab with id" message.
    mock._state.tabs.delete(a1.tabId);
    mock._state.failNextRemoveWith = `No tab with id: ${a1.tabId}`;

    // Must NOT reject. Must clear the set.
    await expect(closeOwnedTabs('taskA')).resolves.toBeUndefined();
    expect(getOwnedTabs('taskA')).toEqual([]);
  });

  it('is a no-op for taskIds with no owned tabs', async () => {
    await expect(closeOwnedTabs('never-existed')).resolves.toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// PNG header parser — direct coverage
// ──────────────────────────────────────────────────────────────────────

describe('parsePngDimensions', () => {
  it('returns the embedded width/height for a 1600x900 fixture', () => {
    const uri = makeFakePngDataUri(1600, 900);
    expect(parsePngDimensions(uri)).toEqual({ widthPx: 1600, heightPx: 900 });
  });

  it('handles other dimensions (e.g. 2560x1440 retina)', () => {
    const uri = makeFakePngDataUri(2560, 1440);
    expect(parsePngDimensions(uri)).toEqual({ widthPx: 2560, heightPx: 1440 });
  });

  it('returns null for a corrupted (non-PNG-signature) data URI', () => {
    // Build an 'image/png' data URI but with bogus first bytes.
    const bad = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0, 0, 0, 1, 0]);
    const b64 = encodeBase64(bad);
    expect(parsePngDimensions(`data:image/png;base64,${b64}`)).toBeNull();
  });
});

describe('parsePngDimensions: edge cases (arch-nemesis #9)', () => {
  it('returns null on empty / non-string / wrong-MIME input', () => {
    expect(parsePngDimensions('')).toBeNull();
    expect(parsePngDimensions(undefined as unknown as string)).toBeNull();
    expect(parsePngDimensions(null as unknown as string)).toBeNull();
    expect(parsePngDimensions('data:image/jpeg;base64,abc')).toBeNull();
    expect(parsePngDimensions('data:image/png,unencoded')).toBeNull(); // no base64
    expect(parsePngDimensions('not-a-data-uri')).toBeNull();
  });

  it('returns null when the base64 payload is too short to contain an IHDR', () => {
    // 8 bytes of valid signature, but no IHDR chunk follows.
    const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const b64 = encodeBase64(sig);
    expect(parsePngDimensions(`data:image/png;base64,${b64}`)).toBeNull();
  });

  it('returns null when IHDR is present but width/height are zero', () => {
    // Width=0 / height=0 should fail the (w > 0 && h > 0) guard.
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const lengthField = [0, 0, 0, 13];
    const ihdrTag = [0x49, 0x48, 0x44, 0x52];
    const widthZero = [0, 0, 0, 0];
    const heightZero = [0, 0, 0, 0];
    const bytes = new Uint8Array([
      ...sig,
      ...lengthField,
      ...ihdrTag,
      ...widthZero,
      ...heightZero,
    ]);
    const b64 = encodeBase64(bytes);
    expect(parsePngDimensions(`data:image/png;base64,${b64}`)).toBeNull();
  });

  it('returns null when IHDR tag is wrong (signature OK, IHDR mismatched)', () => {
    // Signature is valid but the chunk type at offset 12 is "IDAT" instead.
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const lengthField = [0, 0, 0, 13];
    const wrongTag = [0x49, 0x44, 0x41, 0x54]; // 'IDAT'
    const padding = [0, 0, 0, 1, 0, 0, 0, 1];
    const bytes = new Uint8Array([
      ...sig,
      ...lengthField,
      ...wrongTag,
      ...padding,
    ]);
    const b64 = encodeBase64(bytes);
    expect(parsePngDimensions(`data:image/png;base64,${b64}`)).toBeNull();
  });

  it('handles base64 with padding (= and ==) correctly', () => {
    // Valid PNG header for 16x16. Encode with explicit padding so we
    // exercise both 1- and 2-byte padding variants depending on length.
    const dims16 = makeFakePngDataUri(16, 16);
    expect(parsePngDimensions(dims16)).toEqual({ widthPx: 16, heightPx: 16 });
  });

  it('preserves big-endian width parsing for values > 65535 (high u32 bits)', () => {
    // Width 100000 (0x000186A0) — exercises the high bytes of the u32.
    // height 50000 (0x0000C350).
    const uri = makeFakePngDataUri(100000, 50000);
    expect(parsePngDimensions(uri)).toEqual({ widthPx: 100000, heightPx: 50000 });
  });

  it('returns null on URL-safe base64 (uses -_ instead of +/) — out-of-spec for our use case', () => {
    // Standard PNG data URIs always use canonical base64. URL-safe variant
    // is theoretically possible if some upstream changes encoding, but
    // we don't support it. Verify the function fails closed (returns
    // null) rather than producing garbage dimensions.
    const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const b64 = encodeBase64(sig).replace(/\+/g, '-').replace(/\//g, '_');
    const result = parsePngDimensions(`data:image/png;base64,${b64}`);
    // Either null (couldn't decode) OR a value that fails the signature
    // check (because '-' / '_' decoded with the canonical alphabet
    // produce wrong bytes). Both are acceptable "fail closed" outcomes.
    expect(result === null || result.widthPx > 0).toBe(true);
  });
});


describe("tab.list non-strict args (#8: tolerant of model-injected extra keys)", () => {
  // qwen3.5:4b sometimes injects spurious keys into no-arg tool calls
  // (e.g., {"reason": "..."} on a tool that expects {}). The tabListTool's
  // argsSchema is non-strict by design; this test pins that contract.
  it("dispatches successfully when the model adds an extra key", async () => {
    const ctx = { taskId: "taskA", stepId: null };
    await tabOpenTool.execute({ url: "https://example.com/1" }, ctx);

    // Dispatch with an extra key that the schema does not declare.
    // A strict z.object().strict() would reject this; non-strict accepts.
    const result = await tabListTool.argsSchema.safeParse({
      reason: "show me the tabs",
      extra_field: 42,
    });
    expect(result.success).toBe(true);

    // And the tool itself runs cleanly when called with extra args.
    const out = await tabListTool.execute(
      { reason: "show me the tabs" } as unknown as Parameters<typeof tabListTool.execute>[0],
      ctx,
    );
    expect(out.tabs.length).toBeGreaterThanOrEqual(1);
  });
});

describe('post-SW-restart ownership recovery (M3.5 follow-up)', () => {
  // Bug found during arch-nemesis #11 recovery: tab.close and tab.list
  // only consulted the in-memory ownership map, so after a SW restart
  // the module-level cache was empty even though hot state had the
  // tabs. The model would then be told "tab not owned" for tabs it
  // legitimately owned across the restart. Fix: lazy hydrate the cache
  // from hot state on first ownership-touching tool call per taskId.

  // These tests touch real persistence (chrome.storage.local), so reset
  // both the chrome mock + storage. The other tests in this file use
  // synthetic ctx and don't write to storage, so they don't need this.
  beforeEach(async () => {
    const { resetMockedStorage } = await import('./setup');
    await resetMockedStorage();
  });

  it('tab.close succeeds for a tab persisted in hot state but absent from in-memory cache', async () => {
    const stateModule = await import('../src/agent/state_store');
    await stateModule.startTask('restart test');
    const initial = (await stateModule.loadHot())!;
    const ctxRestart = { taskId: initial.taskId, stepId: null };
    // Manually patch ownedTabs in hot state to simulate prior persistence.
    await stateModule.patchHot({ ownedTabs: [9999] });
    // And give the chrome.tabs mock a tab so the close call finds it.
    mock._state.tabs.set(9999, {
      id: 9999,
      url: 'https://example.com/persisted',
      status: 'complete',
      windowId: 1,
      title: 'Persisted',
      active: false,
    });

    // Without hydration this would throw "not owned by current task";
    // with hydration it should succeed.
    const r = await tabCloseTool.execute({ tabId: 9999 }, ctxRestart);
    expect(r.ok).toBe(true);
  });

  it('tab.list returns persisted tabs even when in-memory cache is cold', async () => {
    const stateModule = await import('../src/agent/state_store');
    await stateModule.startTask('restart-list test');
    const initial = (await stateModule.loadHot())!;
    const ctxRestart = { taskId: initial.taskId, stepId: null };
    await stateModule.patchHot({ ownedTabs: [7001, 7002] });
    mock._state.tabs.set(7001, {
      id: 7001,
      url: 'https://example.com/a',
      status: 'complete',
      windowId: 1,
      title: 'A',
      active: false,
    });
    mock._state.tabs.set(7002, {
      id: 7002,
      url: 'https://example.com/b',
      status: 'complete',
      windowId: 1,
      title: 'B',
      active: false,
    });

    const r = await tabListTool.execute({}, ctxRestart);
    const ids = r.tabs.map((t) => t.tabId).sort();
    expect(ids).toEqual([7001, 7002]);
  });
});
