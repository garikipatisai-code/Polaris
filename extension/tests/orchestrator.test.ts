import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Orchestrator } from '../src/agent/orchestrator';
import * as store from '../src/agent/state_store';
import type { OllamaClient, ChatChunk, ChatOptions } from '../src/background/ollama';
import { resetMockedStorage } from './setup';

beforeEach(async () => {
  await resetMockedStorage();
});

afterEach(async () => {
  await resetMockedStorage();
});

// ---------------------------------------------------------------------------
// FakeOllamaClient — per-role response queues. The orchestrator dispatches
// chatOnce calls for planner / executor / evaluator / compactor at unpredict-
// able points (compaction in particular can fire mid-flight). Per-role queues
// mean a test only scripts what it cares about; the fake auto-fills sensible
// defaults for compactor so test scripts don't have to predict its timing.
// ---------------------------------------------------------------------------

type Role = 'planner' | 'executor' | 'evaluator' | 'compactor' | 'unknown';

class FakeOllamaClient {
  public baseUrl = 'http://fake';
  public callLog: { role: Role; idx: number }[] = [];
  private queues: Record<Role, ChatChunk[]>;

  constructor(scripts: Partial<Record<Role, ChatChunk[]>>) {
    this.queues = {
      planner: [...(scripts.planner ?? [])],
      executor: [...(scripts.executor ?? [])],
      evaluator: [...(scripts.evaluator ?? [])],
      compactor: [...(scripts.compactor ?? [])],
      unknown: [],
    };
  }

  url(path: string): string {
    return this.baseUrl + path;
  }

  async chatOnce(opts: ChatOptions): Promise<ChatChunk> {
    const role = detectRole(opts);
    let queue = this.queues[role];
    if (queue.length === 0 && role === 'compactor') {
      // Default: emit an empty findings list. Compactor doesn't have to
      // produce real findings to exercise the "delete scratchpad after
      // archive" path; tests that care can supply their own queue.
      return compactR([]);
    }
    if (queue.length === 0) {
      throw new Error(`FakeOllamaClient: no scripted response for role=${role}`);
    }
    const resp = queue.shift()!;
    this.callLog.push({ role, idx: this.callLog.length });
    return resp;
  }

  async *chatStream(opts: ChatOptions): AsyncGenerator<ChatChunk> {
    yield await this.chatOnce(opts);
  }

  async embed(): Promise<number[][]> {
    return [[]];
  }

  async ping(): Promise<{ ok: boolean; models?: string[] }> {
    return { ok: true, models: ['fake-model'] };
  }
}

function detectRole(opts: ChatOptions): Role {
  const sys = opts.messages.find((m) => m.role === 'system')?.content ?? '';
  // The Evaluator's prompt mentions "EXECUTOR HAS PROPOSED..." in the
  // pendingFinishSummary block, so a naive `includes('EXECUTOR')` would
  // misclassify it. Match the unique "You are the X" header at the top
  // of each role's system prompt.
  if (sys.startsWith('You are the EVALUATOR')) return 'evaluator';
  if (sys.startsWith('You are the PLANNER')) return 'planner';
  if (sys.startsWith('You are the COMPACTOR')) return 'compactor';
  if (sys.startsWith('You are the EXECUTOR')) return 'executor';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

function plannerR(spec: {
  rootSteps: { id: string; title: string; rationale?: string }[];
  criteria?: string[];
  notes?: string;
}): ChatChunk {
  return {
    message: {
      role: 'assistant',
      content: JSON.stringify({
        ...(spec.criteria ? { successCriteria: spec.criteria } : {}),
        rootSteps: spec.rootSteps,
        notes: spec.notes ?? 'test plan',
      }),
    },
    done: true,
    prompt_eval_count: 100,
    eval_count: 50,
  };
}

function execR(call: { name: string; arguments: Record<string, unknown> }): ChatChunk {
  return {
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: call.name, arguments: call.arguments } }],
    },
    done: true,
    prompt_eval_count: 100,
    eval_count: 30,
  };
}

function evalR(
  verdict: 'done' | 'continue' | 'replan' | 'abort',
  extras: { reason?: string; finalAnswer?: string; replanHint?: string } = {},
): ChatChunk {
  const body: Record<string, unknown> = {
    verdict,
    reason: extras.reason ?? 'test',
  };
  if (extras.finalAnswer !== undefined) body.finalAnswer = extras.finalAnswer;
  if (extras.replanHint !== undefined) body.replanHint = extras.replanHint;
  return {
    message: { role: 'assistant', content: JSON.stringify(body) },
    done: true,
    prompt_eval_count: 80,
    eval_count: 20,
  };
}

function compactR(findings: { kind: string; key: string; value: string; evidence?: string }[]): ChatChunk {
  return {
    message: { role: 'assistant', content: JSON.stringify({ findings }) },
    done: true,
    prompt_eval_count: 60,
    eval_count: 30,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('orchestrator: happy path (single step)', () => {
  it('plans, executes one tool, calls finish, evaluator confirms done', async () => {
    const fake = new FakeOllamaClient({
      planner: [
        plannerR({
          criteria: ['Sum is computed correctly', 'Task ends with a final answer'],
          rootSteps: [{ id: 's1', title: 'Add 2 and 3 then finish' }],
        }),
      ],
      executor: [
        execR({ name: 'add', arguments: { a: 2, b: 3 } }),
        execR({ name: 'finish', arguments: { summary: 'The sum of 2 and 3 is 5' } }),
      ],
      evaluator: [
        evalR('done', { finalAnswer: 'The sum of 2 and 3 is 5', reason: 'verified' }),
      ],
    });

    const events: string[] = [];
    const orchestrator = new Orchestrator({
      client: fake as unknown as OllamaClient,
      model: 'test',
      plannerThinking: false,
      evaluatorThinking: false,
      onEvent: (e) => events.push(e.type),
    });

    await orchestrator.start('compute the sum of 2 and 3');
    const final = await orchestrator.runUntilTerminal();

    expect(final.phase).toBe('DONE');
    expect(final.finalAnswer).toBe('The sum of 2 and 3 is 5');
    expect(final.goal.text).toBe('compute the sum of 2 and 3');
    expect(final.goal.successCriteria).toEqual([
      'Sum is computed correctly',
      'Task ends with a final answer',
    ]);
    expect(events).toContain('phase');
    expect(events).toContain('verdict');
    expect(events.filter((t) => t === 'tool_call').length).toBe(2);
  });
});

describe('orchestrator: step advancement (multi-step plan with next_step)', () => {
  it('walks plan via next_step; status transitions active → done', async () => {
    const fake = new FakeOllamaClient({
      planner: [
        plannerR({
          criteria: ['Both steps complete'],
          rootSteps: [
            { id: 's1', title: 'Echo polaris' },
            { id: 's2', title: 'Finish with summary' },
          ],
        }),
      ],
      executor: [
        execR({ name: 'echo', arguments: { text: 'polaris' } }),
        execR({ name: 'next_step', arguments: { reason: 's1 done' } }),
        execR({ name: 'finish', arguments: { summary: 'echoed polaris' } }),
      ],
      evaluator: [
        evalR('done', { finalAnswer: 'echoed polaris', reason: 'ok' }),
      ],
    });

    const orchestrator = new Orchestrator({
      client: fake as unknown as OllamaClient,
      model: 'test',
      plannerThinking: false,
      evaluatorThinking: false,
    });

    await orchestrator.start('demonstrate step advancement');
    const final = await orchestrator.runUntilTerminal();

    expect(final.phase).toBe('DONE');
    expect(final.plan.rootSteps[0]!.status).toBe('done');
    expect(final.currentStepId).toBe('s2');
  });
});

describe('orchestrator: goal byte-survival across replan', () => {
  it('preserves verbatim goal text byte-equal through replan + retry cycle', async () => {
    const ORIGINAL_GOAL = 'find the best deal — €299 for Sony WH-1000XM5 (with ümlaut)';

    const fake = new FakeOllamaClient({
      planner: [
        plannerR({
          criteria: ['Best deal identified'],
          rootSteps: [{ id: 's1', title: 'Search retailers' }],
        }),
        plannerR({
          rootSteps: [{ id: 's1', title: 'Use echo to confirm pricing data' }],
        }),
      ],
      executor: [
        execR({ name: 'echo', arguments: { text: 'searching' } }),
        execR({ name: 'finish', arguments: { summary: 'no deal found' } }),
        execR({ name: 'echo', arguments: { text: '€299 confirmed' } }),
        execR({ name: 'finish', arguments: { summary: 'best deal: €299 at Sony' } }),
      ],
      evaluator: [
        evalR('replan', {
          reason: 'no actual search performed',
          replanHint: 'use a different approach to find prices',
        }),
        evalR('done', { finalAnswer: 'best deal: €299 at Sony', reason: 'verified' }),
      ],
    });

    const orchestrator = new Orchestrator({
      client: fake as unknown as OllamaClient,
      model: 'test',
      plannerThinking: false,
      evaluatorThinking: false,
    });

    await orchestrator.start(ORIGINAL_GOAL);
    const final = await orchestrator.runUntilTerminal();

    // The verbatim goal text MUST be byte-equal — this is the project's
    // central architectural claim, now empirically asserted.
    expect(final.goal.text).toBe(ORIGINAL_GOAL);
    expect(final.phase).toBe('DONE');
    expect(final.finalAnswer).toBe('best deal: €299 at Sony');
    expect(final.plan.revision).toBe(2);
    expect(final.breaker.totalReplans).toBe(1);
  });
});

describe('orchestrator: max-replan abort', () => {
  it('aborts after MAX_TOTAL_REPLANS replans', async () => {
    // 5 planner responses (initial + 4 replans, but only 3 will be consumed
    // before the abort guard trips), 2 executor responses per cycle, 1 eval
    // per cycle. Compactor responses default to empty findings via the fake.
    const fake = new FakeOllamaClient({
      planner: Array.from({ length: 5 }, () =>
        plannerR({ rootSteps: [{ id: 's1', title: 'try again' }] }),
      ),
      executor: Array.from({ length: 10 }, (_, i) =>
        i % 2 === 0
          ? execR({ name: 'echo', arguments: { text: 'attempt' } })
          : execR({ name: 'finish', arguments: { summary: 'tried' } }),
      ),
      evaluator: Array.from({ length: 5 }, () =>
        evalR('replan', { reason: 'still bad', replanHint: 'try again differently' }),
      ),
    });

    const orchestrator = new Orchestrator({
      client: fake as unknown as OllamaClient,
      model: 'test',
      plannerThinking: false,
      evaluatorThinking: false,
    });

    await orchestrator.start('impossible goal');
    const final = await orchestrator.runUntilTerminal();

    expect(final.phase).toBe('ABORTED');
    expect(final.breaker.totalReplans).toBeGreaterThanOrEqual(3);
    const abortTrip = final.breaker.trips.find((t) => t.level === 'abort');
    expect(abortTrip?.reason).toMatch(/replanned|exceeded|MAX_TOTAL/i);
  });
});

describe('orchestrator: empty-finalAnswer override (M2.5.1 contract)', () => {
  it('overrides done-with-empty-finalAnswer to continue, then completes properly', async () => {
    const fake = new FakeOllamaClient({
      planner: [plannerR({ rootSteps: [{ id: 's1', title: 'Use echo' }] })],
      executor: [
        execR({ name: 'echo', arguments: { text: 'hi' } }),
        execR({ name: 'echo', arguments: { text: 'still working' } }),
        execR({ name: 'echo', arguments: { text: 'done now' } }),
        execR({ name: 'echo', arguments: { text: 'really' } }),
        execR({ name: 'echo', arguments: { text: 'still' } }),
        execR({ name: 'finish', arguments: { summary: 'real answer' } }),
      ],
      evaluator: [
        // Periodic eval after 5 turns: model returns done with empty answer.
        evalR('done', { finalAnswer: '', reason: 'pretending we are done' }),
        // Real finish-triggered eval.
        evalR('done', { finalAnswer: 'real answer', reason: 'ok' }),
      ],
    });

    const orchestrator = new Orchestrator({
      client: fake as unknown as OllamaClient,
      model: 'test',
      plannerThinking: false,
      evaluatorThinking: false,
    });

    await orchestrator.start('drive Evaluator into the empty-done case');
    const final = await orchestrator.runUntilTerminal();

    expect(final.phase).toBe('DONE');
    expect(final.finalAnswer).toBe('real answer');
  });
});
