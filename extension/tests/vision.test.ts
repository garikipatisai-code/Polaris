// Tests for createVisionGroundTool — the vision.ground tool.
//
// Unlike most browser tools, vision.ground does NOT make network calls or use
// chrome.* APIs. It takes a client reference and calls chatOnce on it. All
// tests mock the OllamaClient directly via vi.fn() so we never touch a real
// HTTP endpoint.

import { describe, it, expect, vi } from 'vitest';
import { createVisionGroundTool, visionGroundArgs, cacheScreenshot } from '../src/agent/tools/browser/vision';
import type { OllamaClient } from '../src/background/ollama';
import { BrowserToolError } from '../src/agent/tools/browser/lifecycle';

/** A 1x1 red PNG as a data URI — valid format but tiny. */
const SAMPLE_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** A non-PNG string that should fail the dataUri regex. */
const INVALID_DATA_URI = 'not-a-png-at-all';

/** A realistic-length assessment string the model might return. */
const SAMPLE_ASSESSMENT =
  'The page shows a product listing with 3 items. Each has a title, price, and "Add to Cart" button. The heading says "Search Results".';

/**
 * Create a mock OllamaClient whose chatOnce returns a fixed response.
 */
function mockClient(response: string): OllamaClient {
  return {
    baseUrl: 'http://localhost:11434',
    chatOnce: vi.fn().mockResolvedValue({
      message: { content: response, role: 'assistant' },
      done: true,
    }),
    chatStream: vi.fn(),
    embed: vi.fn(),
    ping: vi.fn(),
    url: vi.fn(),
  } as unknown as OllamaClient;
}

describe('createVisionGroundTool', () => {
  it('returns correct tool name', () => {
    const client = mockClient(SAMPLE_ASSESSMENT);
    const tool = createVisionGroundTool(client, 'qwen3.5:4b');
    expect(tool.name).toBe('vision.ground');
  });

  it('sends images to Ollama and returns assessment', async () => {
    const client = mockClient(SAMPLE_ASSESSMENT);
    const tool = createVisionGroundTool(client, 'qwen3.5:4b');

    const result = await tool.execute(
      { dataUri: SAMPLE_DATA_URI },
      { taskId: 't1', stepId: 's1' },
    );

    // Verify the client was called with the image and model
    expect(client.chatOnce).toHaveBeenCalledTimes(1);
    const callArgs = (client.chatOnce as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.model).toBe('qwen3.5:4b');
    expect(callArgs.messages[0].images).toEqual([SAMPLE_DATA_URI]);
    expect(callArgs.messages[0].content).toBe(
      'Describe the page contents briefly. What elements are visible and what are their states?',
    );

    // Verify the output shape
    expect(result.assessment).toBe(SAMPLE_ASSESSMENT);
    expect(result.confirmed).toBe(true);
  });

  it('rejects images below minimum width', async () => {
    const client = mockClient(SAMPLE_ASSESSMENT);
    const tool = createVisionGroundTool(client, 'qwen3.5:4b');

    await expect(
      tool.execute(
        { dataUri: SAMPLE_DATA_URI, widthPx: 800 },
        { taskId: 't1', stepId: 's1' },
      ),
    ).rejects.toThrow(/image width 800px < minimum 1200px/);

    // chatOnce should never have been called
    expect(client.chatOnce).not.toHaveBeenCalled();
  });

  it('rejects invalid data URIs via schema validation', () => {
    // Schema validation happens at registry dispatch time (not inside execute),
    // so we test the schema directly.
    const result = visionGroundArgs.safeParse({ dataUri: INVALID_DATA_URI });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join('; ');
      expect(msg).toMatch(/PNG data URI/i);
    }
  });

  it('handles degenerate Ollama response (message.content undefined)', async () => {
    const client = mockClient('');
    // Simulate undefined message content
    client.chatOnce = vi.fn().mockResolvedValue({
      message: { content: undefined, role: 'assistant' },
      done: true,
    });
    const tool = createVisionGroundTool(client, 'qwen3.5:4b');

    const result = await tool.execute(
      { dataUri: SAMPLE_DATA_URI, widthPx: 1400 },
      { taskId: 't1', stepId: 's1' },
    );

    expect(result.assessment).toBe('');
    expect(result.confirmed).toBe(false);
  });

  it('passes custom question to Ollama', async () => {
    const client = mockClient(SAMPLE_ASSESSMENT);
    const tool = createVisionGroundTool(client, 'qwen3.5:4b');

    const customQuestion = 'Is the checkout button visible and clickable?';
    const result = await tool.execute(
      { dataUri: SAMPLE_DATA_URI, question: customQuestion, widthPx: 1400 },
      { taskId: 't1', stepId: 's1' },
    );

    expect(client.chatOnce).toHaveBeenCalledTimes(1);
    const callArgs = (client.chatOnce as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.messages[0].content).toBe(customQuestion);
    expect(result.confirmed).toBe(true);
  });

  it('reports confirmed=false for short/tiny response', async () => {
    const client = mockClient('ok');
    const tool = createVisionGroundTool(client, 'qwen3.5:4b');

    const result = await tool.execute(
      { dataUri: SAMPLE_DATA_URI, widthPx: 1400 },
      { taskId: 't1', stepId: 's1' },
    );

    expect(result.assessment).toBe('ok');
    expect(result.confirmed).toBe(false);
  });

  it('resolves screenshot from tabId cache', async () => {
    const client = mockClient(SAMPLE_ASSESSMENT);
    const tool = createVisionGroundTool(client, 'qwen3.5:4b');

    // Pre-cache a screenshot
    cacheScreenshot(42, SAMPLE_DATA_URI);

    const result = await tool.execute(
      { tabId: 42 },
      { taskId: 't1', stepId: 's1' },
    );

    expect(client.chatOnce).toHaveBeenCalledTimes(1);
    const callArgs = (client.chatOnce as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.messages[0].images![0]).toBe(SAMPLE_DATA_URI);
    expect(result.confirmed).toBe(true);
  });

  it('throws when tabId has no cached screenshot', async () => {
    const client = mockClient(SAMPLE_ASSESSMENT);
    const tool = createVisionGroundTool(client, 'qwen3.5:4b');

    await expect(
      tool.execute({ tabId: 99 }, { taskId: 't1', stepId: 's1' }),
    ).rejects.toThrow(/call tab.screenshot first/);
  });
});
