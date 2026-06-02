// Tests for page.extract — must ALWAYS re-extract a fresh ARIA tree and never
// serve the (possibly post-navigation stale) element cache.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the aria module so freshAriaTree is a spy returning a known fresh tree.
vi.mock('../src/agent/tools/browser/aria', () => ({
  freshAriaTree: vi.fn(async () => ({
    role: 'main',
    name: 'FRESH results page',
    children: [{ role: 'link', name: 'Wireless Mouse $9.99' }],
  })),
}));

import { freshAriaTree } from '../src/agent/tools/browser/aria';
import { createExtractTool } from '../src/agent/tools/browser/extract';
import { cacheElements, clearAllCaches } from '../src/agent/tools/browser/aria_types';

beforeEach(() => {
  clearAllCaches();
  vi.clearAllMocks();
});
afterEach(() => clearAllCaches());

describe('page.extract: always fresh, never cached', () => {
  it('re-extracts via freshAriaTree even when the element cache is warm', async () => {
    // Warm the cache with STALE homepage-shaped data (what RC#1 served).
    cacheElements(42, {
      role: 'main',
      children: [{ role: 'button', name: 'STALE homepage button', i: 1, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    });

    let captured: { messages: { role: string; content: string }[] } | null = null;
    const fakeClient = {
      chatOnce: vi.fn(async (o: { messages: { role: string; content: string }[] }) => {
        captured = o;
        return { message: { content: '1. Wireless Mouse — $9.99' } };
      }),
    };

    const tool = createExtractTool({ client: fakeClient as never, model: 'm' });
    const out = await tool.execute(
      { tabId: 42, question: 'List products with prices' },
      { taskId: 't', stepId: null },
    );

    // Fresh extraction must have been used.
    expect(freshAriaTree).toHaveBeenCalledWith(42, 16000);
    // The page content sent to the model is the FRESH tree, not the stale cache.
    const userMsg = captured!.messages[1]!.content;
    expect(userMsg).toContain('FRESH results page');
    expect(userMsg).not.toContain('STALE homepage button');
    expect(out.answer).toContain('Wireless Mouse');
  });

  it('returns a graceful answer (no crash) when extraction yields a null tree', async () => {
    vi.mocked(freshAriaTree).mockResolvedValueOnce(null);
    const fakeClient = {
      chatOnce: vi.fn(async () => ({ message: { content: 'I could not find that information on the page.' } })),
    };
    const tool = createExtractTool({ client: fakeClient as never, model: 'm' });
    const out = await tool.execute(
      { tabId: 99, question: 'List products' },
      { taskId: 't', stepId: null },
    );
    expect(freshAriaTree).toHaveBeenCalledWith(99, 16000);
    expect(typeof out.answer).toBe('string');
    expect(out.answer.length).toBeGreaterThan(0);
  });
});

describe('page.extract requests a larger extraction cap', () => {
  it('calls freshAriaTree with maxChars=16000', async () => {
    const fakeClient = { chatOnce: vi.fn(async () => ({ message: { content: 'ok' } })) };
    const tool = createExtractTool({ client: fakeClient as never, model: 'm' });
    await tool.execute({ tabId: 7, question: 'list products' }, { taskId: 't', stepId: null });
    expect(freshAriaTree).toHaveBeenCalledWith(7, 16000);
  });
});
