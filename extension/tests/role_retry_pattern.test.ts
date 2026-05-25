// Role retry-pattern snapshot tests.
//
// Verifies that when a role's first response is unparseable / empty, the
// retry call uses the [system, user-anchor, assistant-failed, user-nudge]
// message shape (NOT a second `system` message). Qwen3 chat templates only
// emit one <|im_start|>system block; extras get inlined or dropped, so the
// historical [system, system-nudge] pattern was unreliable.
//
// Mock-only — no real Ollama needed. We capture every chatOnce options
// payload via a recording fake and then assert on the second call's messages.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runExecutor } from '../src/agent/roles/executor';
import { runPlanner } from '../src/agent/roles/planner';
import { runEvaluator } from '../src/agent/roles/evaluator';
import { runCompactor } from '../src/agent/roles/compactor';
import { createDefaultRegistry } from '../src/agent/tools';
import * as store from '../src/agent/state_store';
import type { ChatChunk, ChatOptions, OllamaClient } from '../src/background/ollama';
import { resetMockedStorage } from './setup';

beforeEach(async () => await resetMockedStorage());
afterEach(async () => await resetMockedStorage());

class RecordingFake {
  public baseUrl = 'http://fake';
  public calls: ChatOptions[] = [];
  private queue: ChatChunk[];

  constructor(scripted: ChatChunk[]) {
    this.queue = [...scripted];
  }

  url(p: string): string {
    return this.baseUrl + p;
  }

  async chatOnce(opts: ChatOptions): Promise<ChatChunk> {
    this.calls.push(opts);
    if (this.queue.length === 0) throw new Error('RecordingFake exhausted');
    return this.queue.shift()!;
  }

  async *chatStream(opts: ChatOptions): AsyncGenerator<ChatChunk> {
    yield await this.chatOnce(opts);
  }

  async embed(): Promise<number[][]> {
    return [[]];
  }

  async ping(): Promise<{ ok: boolean; models?: string[] }> {
    return { ok: true, models: ['fake'] };
  }
}

function emptyToolCall(): ChatChunk {
  return {
    message: { role: 'assistant', content: 'I will think about this first...', tool_calls: [] },
    done: true,
    prompt_eval_count: 50,
    eval_count: 10,
  };
}

function validToolCall(): ChatChunk {
  return {
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'echo', arguments: { text: 'ok' } } }],
    },
    done: true,
    prompt_eval_count: 80,
    eval_count: 5,
  };
}

function brokenJSON(): ChatChunk {
  return {
    message: { role: 'assistant', content: 'Here is the plan:\n\n```\nnot-json' },
    done: true,
    prompt_eval_count: 50,
    eval_count: 10,
  };
}

function plannerJSON(): ChatChunk {
  return {
    message: {
      role: 'assistant',
      content: JSON.stringify({
        rootSteps: [{ id: 's1', title: 'do thing' }],
        notes: 'recovered',
      }),
    },
    done: true,
    prompt_eval_count: 80,
    eval_count: 20,
  };
}

function evaluatorJSON(): ChatChunk {
  return {
    message: {
      role: 'assistant',
      content: JSON.stringify({ verdict: 'continue', reason: 'recovered' }),
    },
    done: true,
    prompt_eval_count: 80,
    eval_count: 10,
  };
}

function compactorJSON(): ChatChunk {
  return {
    message: { role: 'assistant', content: JSON.stringify({ findings: [] }) },
    done: true,
    prompt_eval_count: 60,
    eval_count: 5,
  };
}

function assertRetryShape(messages: ChatOptions['messages']): void {
  expect(messages.length).toBeGreaterThanOrEqual(4);
  expect(messages[0]!.role).toBe('system');
  expect(messages[1]!.role).toBe('user');
  expect(messages[2]!.role).toBe('assistant');
  expect(messages[3]!.role).toBe('user');
  // No additional system messages downstream — the broken pattern.
  for (let i = 1; i < messages.length; i++) {
    expect(messages[i]!.role).not.toBe('system');
  }
}

describe('role retry pattern (assistant+user, not system+system)', () => {
  it('Executor: empty tool_calls → retry with [system, user, assistant, user]', async () => {
    const fake = new RecordingFake([emptyToolCall(), validToolCall()]);
    const state = await store.startTask('test goal');

    await runExecutor({
      state,
      registry: createDefaultRegistry(),
      client: fake as unknown as OllamaClient,
      model: 'm',
    });

    expect(fake.calls.length).toBe(2);
    const first = fake.calls[0]!.messages;
    const retry = fake.calls[1]!.messages;

    // First call has [system, user-anchor].
    expect(first.length).toBe(2);
    expect(first[0]!.role).toBe('system');
    expect(first[1]!.role).toBe('user');

    // Retry has [system, user-anchor, assistant-failed, user-nudge].
    assertRetryShape(retry);
    // The assistant turn must echo the failed content so the model can
    // see what it produced wrong.
    expect(retry[2]!.content).toContain('think about this first');
  });

  it('Planner: bad JSON → retry with assistant+user pattern', async () => {
    const fake = new RecordingFake([brokenJSON(), plannerJSON()]);
    const state = await store.startTask('plan something');

    const r = await runPlanner({
      state,
      registry: createDefaultRegistry(),
      client: fake as unknown as OllamaClient,
      model: 'm',
      isInitial: true,
      thinkingMode: false,
    });
    expect(r.ok).toBe(true);
    assertRetryShape(fake.calls[1]!.messages);
    // Failed assistant content is included.
    expect(fake.calls[1]!.messages[2]!.content).toContain('not-json');
  });

  it('Evaluator: bad JSON → retry with assistant+user pattern', async () => {
    const fake = new RecordingFake([brokenJSON(), evaluatorJSON()]);
    const state = await store.startTask('eval');
    // Need a non-empty plan for evaluator's prompt to render.
    await store.patchHot({
      plan: {
        rootSteps: [{ id: 's1', title: 't', status: 'active' }],
        revision: 1,
        generatedAt: Date.now(),
      },
    });

    const r = await runEvaluator({
      state: (await store.loadHot())!,
      client: fake as unknown as OllamaClient,
      model: 'm',
      thinkingMode: false,
      triggeredByFinish: false,
    });
    expect(r.ok).toBe(true);
    assertRetryShape(fake.calls[1]!.messages);
  });

  it('Compactor: bad JSON → retry with assistant+user pattern', async () => {
    const fake = new RecordingFake([brokenJSON(), compactorJSON()]);

    const r = await runCompactor({
      goal: 'goal',
      scratchEntries: [
        {
          taskId: 't',
          seq: 1,
          ts: 0,
          kind: 'tool_call',
          payload: { function: { name: 'echo', arguments: { text: 'a' } } },
          tokens: 10,
        },
      ],
      existingKeys: [],
      client: fake as unknown as OllamaClient,
      model: 'm',
    });
    expect(r.ok).toBe(true);
    assertRetryShape(fake.calls[1]!.messages);
  });
});

describe('role first-call shape (user anchor)', () => {
  it('Executor first call has [system, user-anchor] — not system-only', async () => {
    const fake = new RecordingFake([validToolCall()]);
    const state = await store.startTask('test');

    await runExecutor({
      state,
      registry: createDefaultRegistry(),
      client: fake as unknown as OllamaClient,
      model: 'm',
    });

    const msgs = fake.calls[0]!.messages;
    expect(msgs.length).toBe(2);
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[1]!.role).toBe('user');
    expect(msgs[1]!.content.toLowerCase()).toContain('tool');
  });

  it('Planner first call has [system, user-anchor]', async () => {
    const fake = new RecordingFake([plannerJSON()]);
    const state = await store.startTask('plan');

    await runPlanner({
      state,
      registry: createDefaultRegistry(),
      client: fake as unknown as OllamaClient,
      model: 'm',
      isInitial: true,
      thinkingMode: false,
    });

    const msgs = fake.calls[0]!.messages;
    expect(msgs.length).toBe(2);
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[1]!.role).toBe('user');
  });
});

// ---------------------------------------------------------------------------
// Replay-truncation fix (arch-nemesis #2 + #10): when the failed assistant
// content is long, the retry must replay it truncated rather than verbatim,
// so the retry prompt doesn't blow past the role's budget.
// ---------------------------------------------------------------------------

function bigBrokenJSON(): ChatChunk {
  // 2000 chars of unparseable garbage — well over REPLAY_TRUNCATE_CHARS=500.
  const blob = '{"rootSteps": ['.repeat(150);
  return {
    message: { role: 'assistant', content: blob },
    done: true,
    prompt_eval_count: 80,
    eval_count: 600,
  };
}

describe('retry replay truncation (#2 + #10)', () => {
  it('Executor: failed assistant content is truncated to ~500 chars on retry', async () => {
    const longBroken: ChatChunk = {
      message: {
        role: 'assistant',
        content: 'a'.repeat(2000), // way over REPLAY_TRUNCATE_CHARS
        tool_calls: [],
      },
      done: true,
      prompt_eval_count: 50,
      eval_count: 500,
    };
    const fake = new RecordingFake([longBroken, validToolCall()]);
    const state = await store.startTask('truncation test');

    await runExecutor({
      state,
      registry: createDefaultRegistry(),
      client: fake as unknown as OllamaClient,
      model: 'm',
    });

    const retry = fake.calls[1]!.messages;
    const replay = retry[2]!.content;
    // Original was 2000 chars; replay must be truncated.
    expect(replay.length).toBeLessThan(700); // 500 + marker overhead
    expect(replay).toContain('[truncated]');
  });

  it('Planner: long broken JSON truncated on retry', async () => {
    const fake = new RecordingFake([bigBrokenJSON(), plannerJSON()]);
    const state = await store.startTask('plan something');

    await runPlanner({
      state,
      registry: createDefaultRegistry(),
      client: fake as unknown as OllamaClient,
      model: 'm',
      isInitial: true,
      thinkingMode: false,
    });

    const retry = fake.calls[1]!.messages;
    const replay = retry[2]!.content;
    expect(replay.length).toBeLessThan(700);
    expect(replay).toContain('[truncated]');
  });
});
