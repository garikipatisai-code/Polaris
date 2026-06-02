// Tests for the page-action tools (tab.click, tab.type, tab.select).
//
// Each test installs module-level mocks for chrome.tabs.get and the
// chrome.debugger API via beforeEach, with domain tier pre-configured
// so assertCanAct passes. Individual tests can override mockTabsGet or
// mockSendCommand to test failure modes.
//
// Non-fatal errors are now returned as structured { ok: false, error: "..." }
// instead of thrown — tests that previously expected rejects.toThrow now
// check result.ok and result.error.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tabClickTool, tabTypeTool, tabSelectTool } from '../src/agent/tools/browser/actions';
import { setDomainTier } from '../src/agent/domain_tiers';
import { resetMockedStorage } from './setup';
import { cacheElements, clearAllCaches } from '../src/agent/tools/browser/aria_types';

const mockSendCommand = vi.fn();
const mockAttach = vi.fn().mockResolvedValue(undefined);
const mockDetach = vi.fn().mockResolvedValue(undefined);
const mockTabsGet = vi.fn();

beforeEach(async () => {
  vi.clearAllMocks();
  await resetMockedStorage();

  // Configure domain tier so assertCanAct('https://example.com/...', 'click-only') passes.
  await setDomainTier('example.com', 'click-only');

  // Default mock responses for the happy path
  mockTabsGet.mockResolvedValue({ id: 42, url: 'https://example.com/page' });
  mockSendCommand.mockImplementation(async (_target: unknown, method: string) => {
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
    if (method === 'DOM.requestNode') return { nodeId: 101 };
    if (method === 'DOM.scrollIntoViewIfNeeded') return {};
    if (method === 'DOM.getContentQuads') return { quads: [[10, 20, 100, 20, 100, 60, 10, 60]] };
    if (method === 'Input.dispatchMouseEvent') return {};
    return {};
  });

  // Install chrome mocks, preserving storage from setup.ts
  (globalThis as unknown as { chrome: Record<string, unknown> }).chrome = {
    ...(globalThis as unknown as { chrome: Record<string, unknown> }).chrome,
    tabs: { get: mockTabsGet },
    debugger: { attach: mockAttach, detach: mockDetach, sendCommand: mockSendCommand },
  };
});

afterEach(async () => {
  await resetMockedStorage();
});

describe('tab.click', () => {
  it('clicks at coordinates resolved from backendDOMNodeId', async () => {
    const result = await tabClickTool.execute(
      { tabId: 42, backendDOMNodeId: 7 },
      { taskId: 't1', stepId: null },
    );
    expect(result.action).toBe('click');
    expect(result.x).toBe(55); // center of 10..100
    expect(result.y).toBe(40); // center of 20..60
    expect(result.ok).toBe(true);
  });

  it('returns structured error for invalid tabId', async () => {
    mockTabsGet.mockRejectedValue(new Error('tab not found'));
    const result = await tabClickTool.execute(
      { tabId: 999, backendDOMNodeId: 7 },
      { taskId: 't1', stepId: null },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('tab.click: tab 999 not found');
  });

  it('attaches and detaches debugger', async () => {
    await tabClickTool.execute(
      { tabId: 42, backendDOMNodeId: 7 },
      { taskId: 't1', stepId: null },
    );
    expect(mockAttach).toHaveBeenCalledWith({ tabId: 42 }, '1.3');
    expect(mockDetach).toHaveBeenCalledWith({ tabId: 42 });
  });

  it('applies offset from element origin', async () => {
    const result = await tabClickTool.execute(
      { tabId: 42, backendDOMNodeId: 7, offsetX: 5, offsetY: 5 },
      { taskId: 't1', stepId: null },
    );
    expect(result.x).toBe(15); // x0(10) + offset(5)
    expect(result.y).toBe(25); // y0(20) + offset(5)
  });

  it('has correct tool name', () => {
    expect(tabClickTool.name).toBe('tab.click');
  });

  it('supports right-click', async () => {
    const result = await tabClickTool.execute(
      { tabId: 42, backendDOMNodeId: 7, button: 'right' },
      { taskId: 't1', stepId: null },
    );
    expect(result.action).toBe('click');
    expect(result.ok).toBe(true);
    // Verify debugger was called with 'right' button
    const mousePressedCalls = mockSendCommand.mock.calls.filter(
      (c: unknown[]) => (c as [unknown, string])[1] === 'Input.dispatchMouseEvent',
    );
    expect(mousePressedCalls.length).toBeGreaterThanOrEqual(1);
    const lastMouseArgs = mousePressedCalls[mousePressedCalls.length - 1] as [unknown, string, Record<string, unknown>];
    expect(lastMouseArgs[2].button).toBe('right');
  });

  it('supports double-click via clickCount', async () => {
    await tabClickTool.execute(
      { tabId: 42, backendDOMNodeId: 7, clickCount: 2 },
      { taskId: 't1', stepId: null },
    );
    const mousePressedCalls = mockSendCommand.mock.calls.filter(
      (c: unknown[]) => (c as [unknown, string])[1] === 'Input.dispatchMouseEvent',
    );
    expect(mousePressedCalls.length).toBeGreaterThanOrEqual(1);
    const args = (mousePressedCalls[0] as [unknown, string, Record<string, unknown>])[2];
    expect(args.clickCount).toBe(2);
  });

  it('resolves via CSS selector when backendDOMNodeId is not provided', async () => {
    // Override mock to simulate DOM.querySelector returning a valid node
    mockSendCommand.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 202 };
      if (method === 'DOM.scrollIntoViewIfNeeded') return {};
      if (method === 'DOM.getContentQuads') return { quads: [[30, 40, 200, 40, 200, 100, 30, 100]] };
      if (method === 'Input.dispatchMouseEvent') return {};
      return {};
    });
    const result = await tabClickTool.execute(
      { tabId: 42, selector: '#submit-btn' },
      { taskId: 't1', stepId: null },
    );
    expect(result.x).toBe(115); // center of 30..200
    expect(result.y).toBe(70);  // center of 40..100
  });

  it('returns structured error when CSS selector matches nothing', async () => {
    mockSendCommand.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 0 };
      return {};
    });
    const result = await tabClickTool.execute(
      { tabId: 42, selector: '.nonexistent' },
      { taskId: 't1', stepId: null },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('matched no elements');
  });

  it('returns structured error when element has no visible bounding box', async () => {
    mockSendCommand.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
      if (method === 'DOM.requestNode') return { nodeId: 101 };
      if (method === 'DOM.scrollIntoViewIfNeeded') return {};
      if (method === 'DOM.getContentQuads') return { quads: [] };
      return {};
    });
    const result = await tabClickTool.execute(
      { tabId: 42, backendDOMNodeId: 7 },
      { taskId: 't1', stepId: null },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no visible bounding box');
  });

  it('rejects click on a read-only domain', async () => {
    // Point to a domain that is NOT configured as click-only
    mockTabsGet.mockResolvedValue({ id: 55, url: 'https://unknown-site.com/foo' });
    await expect(
      tabClickTool.execute(
        { tabId: 55, backendDOMNodeId: 7 },
        { taskId: 't1', stepId: null },
      ),
    ).rejects.toThrow('read-only');
  });

  it('rounds fractional coordinates to integers', async () => {
    // Use a quad with odd width/height so center calculation uses Math.floor
    mockSendCommand.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
      if (method === 'DOM.requestNode') return { nodeId: 101 };
      if (method === 'DOM.scrollIntoViewIfNeeded') return {};
      if (method === 'DOM.getContentQuads') return { quads: [[0, 0, 11, 0, 11, 7, 0, 7]] };
      if (method === 'Input.dispatchMouseEvent') return {};
      return {};
    });
    const result = await tabClickTool.execute(
      { tabId: 42, backendDOMNodeId: 7 },
      { taskId: 't1', stepId: null },
    );
    expect(result.x).toBe(5); // floor(11/2) = 5
    expect(result.y).toBe(3); // floor(7/2) = 3
  });

  it('calls DOM.getDocument before DOM.requestNode on the backendDOMNodeId path', async () => {
    await tabClickTool.execute(
      { tabId: 42, backendDOMNodeId: 7 },
      { taskId: 't1', stepId: null },
    );
    const order = mockSendCommand.mock.calls.map((c: unknown[]) => (c as [unknown, string])[1]);
    const docIdx = order.indexOf('DOM.getDocument');
    const reqIdx = order.indexOf('DOM.requestNode');
    expect(docIdx).toBeGreaterThanOrEqual(0);
    expect(reqIdx).toBeGreaterThanOrEqual(0);
    expect(docIdx).toBeLessThan(reqIdx);
    // Also assert getDocument precedes resolveNode so the assertion can't be
    // satisfied by getDocument landing between resolveNode and requestNode.
    const resolveIdx = order.indexOf('DOM.resolveNode');
    expect(docIdx).toBeLessThan(resolveIdx);
  });

  it('calls DOM.scrollIntoViewIfNeeded before DOM.getContentQuads', async () => {
    await tabClickTool.execute(
      { tabId: 42, backendDOMNodeId: 7 },
      { taskId: 't1', stepId: null },
    );
    const order = mockSendCommand.mock.calls.map((c: unknown[]) => (c as [unknown, string])[1]);
    const scrollIdx = order.indexOf('DOM.scrollIntoViewIfNeeded');
    const quadsIdx = order.indexOf('DOM.getContentQuads');
    expect(scrollIdx).toBeGreaterThanOrEqual(0);
    expect(quadsIdx).toBeGreaterThanOrEqual(0);
    expect(scrollIdx).toBeLessThan(quadsIdx);
  });

  it('orders DOM.getDocument before querySelector and scroll before quads on the selector path', async () => {
    mockSendCommand.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 202 };
      if (method === 'DOM.scrollIntoViewIfNeeded') return {};
      if (method === 'DOM.getContentQuads') return { quads: [[30, 40, 200, 40, 200, 100, 30, 100]] };
      if (method === 'Input.dispatchMouseEvent') return {};
      return {};
    });
    await tabClickTool.execute(
      { tabId: 42, selector: '#submit-btn' },
      { taskId: 't1', stepId: null },
    );
    const order = mockSendCommand.mock.calls.map((c: unknown[]) => (c as [unknown, string])[1]);
    expect(order.indexOf('DOM.getDocument')).toBeLessThan(order.indexOf('DOM.querySelector'));
    expect(order.indexOf('DOM.scrollIntoViewIfNeeded')).toBeLessThan(order.indexOf('DOM.getContentQuads'));
    expect(order.indexOf('DOM.getDocument')).toBeGreaterThanOrEqual(0);
  });
});

describe('tab.type', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await setDomainTier('example.com', 'full-action');
    mockTabsGet.mockResolvedValue({ id: 42, url: 'https://example.com/page' });
    mockSendCommand.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 101 };
      if (method === 'Input.dispatchKeyEvent') return {};
      return {};
    });
  });

  it('types text into selected element', async () => {
    const result = await tabTypeTool.execute(
      { tabId: 42, selector: '#search', text: 'hello' },
      { taskId: 't1', stepId: null },
    );
    expect(result.action).toBe('type');
    expect(result.charsTyped).toBe(5);
    expect(result.submitted).toBe(false);
    expect(result.ok).toBe(true);
  });

  it('presses Enter when submit=true', async () => {
    const result = await tabTypeTool.execute(
      { tabId: 42, selector: '#search', text: 'query', submit: true },
      { taskId: 't1', stepId: null },
    );
    expect(result.ok).toBe(true);
    expect(result.submitted).toBe(true);
    const enterCalls = mockSendCommand.mock.calls.filter(
      (c: unknown[]) => (c[1] as string) === 'Input.dispatchKeyEvent' && (c[2] as Record<string, unknown>)?.key === 'Enter',
    );
    expect(enterCalls.length).toBe(2);
  });

  it('returns structured error for empty selector match', async () => {
    mockSendCommand.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'DOM.querySelector') return { nodeId: 0 };
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      return {};
    });
    const result = await tabTypeTool.execute(
      { tabId: 42, selector: '#nonexistent', text: 'x' },
      { taskId: 't1', stepId: null },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('matched no elements');
  });

  it('has correct name', () => {
    expect(tabTypeTool.name).toBe('tab.type');
  });
});

describe('tab.select', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTabsGet.mockResolvedValue({ id: 42, url: 'https://example.com/page' });
    mockSendCommand.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'Runtime.evaluate') return { result: { value: { ok: true } } };
      return {};
    });
  });

  it('selects a value in a dropdown', async () => {
    const result = await tabSelectTool.execute(
      { tabId: 42, selector: '#sort', value: 'price-asc' },
      { taskId: 't1', stepId: null },
    );
    expect(result.action).toBe('select');
    expect(result.value).toBe('price-asc');
    expect(result.ok).toBe(true);
  });

  it('returns structured error when element not found', async () => {
    mockSendCommand.mockResolvedValue({ result: { value: { ok: false, error: 'element not found' } } });
    const result = await tabSelectTool.execute(
      { tabId: 42, selector: '#missing', value: 'x' },
      { taskId: 't1', stepId: null },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('element not found');
  });

  it('has correct name', () => {
    expect(tabSelectTool.name).toBe('tab.select');
  });
});

describe('tab.click tab-not-found hint', () => {
  it('suggests tab.list() when chrome.tabs.get rejects', async () => {
    mockTabsGet.mockRejectedValue(new Error('No tab with given id 1'));
    const result = await tabClickTool.execute({ tabId: 1, backendDOMNodeId: 7 }, { taskId: 't1', stepId: null });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/tab\.list\(\)/);
  });
});

describe('index actions respect cache staleness after navigation', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await resetMockedStorage();
    clearAllCaches();
    await setDomainTier('example.com', 'full-action');
    // aria.extract ran on page-1 and cached an element bbox stamped with that URL.
    cacheElements(42, {
      role: 'main',
      children: [{ role: 'button', name: 'Add', i: 1, bbox: { x: 10, y: 20, width: 100, height: 40 } }],
    }, 'https://example.com/page-1');
    mockSendCommand.mockResolvedValue({});
    (globalThis as unknown as { chrome: Record<string, unknown> }).chrome = {
      ...(globalThis as unknown as { chrome: Record<string, unknown> }).chrome,
      tabs: { get: mockTabsGet },
      debugger: { attach: mockAttach, detach: mockDetach, sendCommand: mockSendCommand },
    };
  });

  it('tab.click by index returns a stale error once the tab has navigated', async () => {
    // Tab is now on page-2 — the cached page-1 bbox must NOT be used.
    mockTabsGet.mockResolvedValue({ id: 42, url: 'https://example.com/page-2' });
    const result = await tabClickTool.execute({ tabId: 42, index: 1 }, { taskId: 't1', stepId: null });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/stale|aria\.extract/i);
    // No mouse event dispatched against the wrong coordinates.
    const mouse = mockSendCommand.mock.calls.filter((c: unknown[]) => (c as [unknown, string])[1] === 'Input.dispatchMouseEvent');
    expect(mouse.length).toBe(0);
  });

  it('tab.click by index still works when the URL is unchanged', async () => {
    mockTabsGet.mockResolvedValue({ id: 42, url: 'https://example.com/page-1' });
    const result = await tabClickTool.execute({ tabId: 42, index: 1 }, { taskId: 't1', stepId: null });
    expect(result.ok).toBe(true);
    expect(result.x).toBe(60); // center of 10..110
    expect(result.y).toBe(40); // center of 20..60
  });

  it('tab.type by index returns a stale error after navigation', async () => {
    mockTabsGet.mockResolvedValue({ id: 42, url: 'https://example.com/page-2' });
    const result = await tabTypeTool.execute({ tabId: 42, index: 1, text: 'hi' }, { taskId: 't1', stepId: null });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/stale|aria\.extract/i);
  });
});
