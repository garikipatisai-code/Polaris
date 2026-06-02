// runExecutor must inject the task's owned tabs into the Executor system
// prompt's OPEN TABS section every turn (so the model never guesses tabId).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runExecutor } from '../src/agent/roles/executor';
import { createDefaultRegistry } from '../src/agent/tools';
import * as store from '../src/agent/state_store';
import { _resetOwnership } from '../src/agent/tools/browser/tab';
import type { ChatChunk, ChatOptions, OllamaClient } from '../src/background/ollama';
import { resetMockedStorage } from './setup';

class RecordingFake {
  public baseUrl = 'http://fake';
  public calls: ChatOptions[] = [];
  private queue: ChatChunk[];
  constructor(scripted: ChatChunk[]) { this.queue = [...scripted]; }
  url(p: string): string { return this.baseUrl + p; }
  async chatOnce(opts: ChatOptions): Promise<ChatChunk> {
    this.calls.push(opts);
    if (this.queue.length === 0) throw new Error('exhausted');
    return this.queue.shift()!;
  }
  async *chatStream(opts: ChatOptions): AsyncGenerator<ChatChunk> { yield await this.chatOnce(opts); }
  async embed(): Promise<number[][]> { return [[]]; }
  async ping(): Promise<{ ok: boolean }> { return { ok: true }; }
}

const validToolCall: ChatChunk = {
  message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'echo', arguments: { text: 'ok' } } }] },
  done: true, prompt_eval_count: 80, eval_count: 5,
};

let savedChrome: unknown;
beforeEach(async () => {
  _resetOwnership();
  await resetMockedStorage();
  savedChrome = (globalThis as { chrome?: unknown }).chrome;
});
afterEach(async () => {
  (globalThis as { chrome?: unknown }).chrome = savedChrome;
  _resetOwnership();
  await resetMockedStorage();
});

describe('runExecutor injects OPEN TABS', () => {
  it('includes owned tab id + url in the system prompt', async () => {
    const state = await store.startTask('list amazon products');
    await store.patchHot({ ownedTabs: [555] });
    (globalThis as { chrome?: Record<string, unknown> }).chrome = {
      ...(globalThis as { chrome?: Record<string, unknown> }).chrome,
      tabs: { get: vi.fn(async (id: number) => ({ id, url: 'https://www.amazon.com/s?k=wireless+mouse', title: 'Amazon' })) },
    };

    const fake = new RecordingFake([validToolCall]);
    await runExecutor({
      state: (await store.loadHot())!,
      registry: createDefaultRegistry(),
      client: fake as unknown as OllamaClient,
      model: 'm',
    });

    const sys = fake.calls[0]!.messages[0]!.content;
    expect(sys).toContain('OPEN TABS');
    expect(sys).toContain('555');
    expect(sys).toContain('https://www.amazon.com/s?k=wireless+mouse');
  });
});
