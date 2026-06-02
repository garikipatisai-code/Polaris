import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tabDomSettleTool } from '../src/agent/tools/browser/settle';

const attach = vi.fn(async () => undefined);
const detach = vi.fn(async () => undefined);
let sendCommand: ReturnType<typeof vi.fn>;
let savedChrome: unknown;

beforeEach(() => {
  savedChrome = (globalThis as { chrome?: unknown }).chrome;
  sendCommand = vi.fn(async (_t: unknown, method: string) => {
    if (method === 'Runtime.evaluate') return { result: { value: { settled: true, waitedMs: 120 } } };
    return {};
  });
  (globalThis as { chrome?: unknown }).chrome = {
    ...(globalThis as { chrome?: Record<string, unknown> }).chrome,
    debugger: { attach, detach, sendCommand },
    runtime: { lastError: null },
  };
});
afterEach(() => { (globalThis as { chrome?: unknown }).chrome = savedChrome; vi.clearAllMocks(); });

describe('tab.dom_settle', () => {
  it('has the right name and waits via a MutationObserver, returning the settle result', async () => {
    expect(tabDomSettleTool.name).toBe('tab.dom_settle');
    const out = await tabDomSettleTool.execute({ tabId: 42 }, { taskId: 't', stepId: null });
    expect(out.ok).toBe(true);
    expect(out.settled).toBe(true);
    expect(out.waitedMs).toBe(120);
    expect(attach).toHaveBeenCalledWith({ tabId: 42 }, '1.3');
    expect(detach).toHaveBeenCalled();
    const evalCall = sendCommand.mock.calls.find((c: unknown[]) => (c as [unknown, string])[1] === 'Runtime.evaluate');
    expect(evalCall).toBeDefined();
    const params = (evalCall as [unknown, string, Record<string, unknown>])[2];
    expect(String(params.expression)).toContain('MutationObserver');
    expect(params.awaitPromise).toBe(true);
    expect(params.returnByValue).toBe(true);
  });

  it('returns a structured non-fatal error when attach fails (bad tab)', async () => {
    attach.mockRejectedValueOnce(new Error('No tab with given id 1'));
    const out = await tabDomSettleTool.execute({ tabId: 1 }, { taskId: 't', stepId: null });
    expect(out.ok).toBe(false);
    expect(out.settled).toBe(false);
    expect(out.error).toMatch(/tab\.list\(\)|No tab/);
  });

  it('returns a non-fatal error (and still detaches) when Runtime.evaluate rejects', async () => {
    sendCommand.mockImplementation(async (_t: unknown, method: string) => {
      if (method === 'Runtime.evaluate') throw new Error('Debugger detached mid-flight');
      return {};
    });
    const out = await tabDomSettleTool.execute({ tabId: 42 }, { taskId: 't', stepId: null });
    expect(out.ok).toBe(false);
    expect(out.settled).toBe(false);
    expect(out.error).toContain('Debugger detached');
    expect(detach).toHaveBeenCalled();
  });
});
