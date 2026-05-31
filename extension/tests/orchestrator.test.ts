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
  public callLog: { role: Role; model: string; idx: number }[] = [];
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
    this.callLog.push({ role, model: opts.model, idx: this.callLog.length });
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

describe('orchestrator: step-advance clears recentActionHashes (#7)', () => {
  it('advancing past a single-tool step does not strand a full hash window for the next step', async () => {
    // Plan with two steps. Step s1 only legitimately needs `echo` (so its
    // hash window fills up with echo entries). When we advance to s2, the
    // distinct-action breaker must NOT immediately trip on s2's first turn —
    // the window from s1 should be cleared.
    const fake = new FakeOllamaClient({
      planner: [
        plannerR({
          rootSteps: [
            { id: 's1', title: 'echo a few times' },
            { id: 's2', title: 'finish' },
          ],
        }),
      ],
      executor: [
        // Fill s1's window with 9 echo calls (different args, so they're
        // distinct hashes — no per-action repeat trip).
        ...Array.from({ length: 9 }, (_, i) =>
          execR({ name: 'echo', arguments: { text: `t${i}` } }),
        ),
        // Then next_step → s2.
        execR({ name: 'next_step', arguments: { reason: 's1 done' } }),
        // First action of s2.
        execR({ name: 'finish', arguments: { summary: 'done' } }),
      ],
      evaluator: [evalR('done', { finalAnswer: 'done', reason: 'ok' })],
    });

    const orchestrator = new Orchestrator({
      client: fake as unknown as OllamaClient,
      model: 'test',
      plannerThinking: false,
      evaluatorThinking: false,
      maxSteps: 25,
    });

    await orchestrator.start('test');
    const final = await orchestrator.runUntilTerminal();

    // Reach DONE without a stuck-loop replan being incorrectly emitted on
    // s2 due to s1's history.
    expect(final.phase).toBe('DONE');
    // The breaker shouldn't have a 'replan' trip from a distinct-action
    // false positive caused by s1's history.
    const distinctTrips = final.breaker.trips.filter(
      (t) => t.level === 'replan' && /distinct actions/i.test(t.reason),
    );
    expect(distinctTrips.length).toBe(0);
  });
});

describe('orchestrator: Ollama failure mid-run transitions to ABORTED', () => {
  it('marks the task ABORTED when a role call throws unrecoverably', async () => {
    // Failing client: planner first call succeeds (so we reach EXECUTING),
    // then executor calls all throw — no scripted retries that would
    // recover. The orchestrator must (a) re-throw, (b) leave the task in
    // phase=ABORTED in storage so a subsequent resume() doesn't pick up a
    // dead task.
    const failingExecutorClient = {
      baseUrl: 'http://fake',
      url: (p: string) => 'http://fake' + p,
      callLog: [] as { role: string }[],
      chatOnce: async (opts: ChatOptions): Promise<ChatChunk> => {
        const sys = opts.messages.find((m) => m.role === 'system')?.content ?? '';
        if (sys.startsWith('You are the PLANNER')) {
          return {
            message: {
              role: 'assistant',
              content: JSON.stringify({
                rootSteps: [{ id: 's1', title: 'do thing' }],
                notes: 'p',
              }),
            },
            done: true,
            prompt_eval_count: 50,
            eval_count: 10,
          };
        }
        // Executor / evaluator / compactor — all throw HTTP 503.
        throw new Error('Ollama chat HTTP 503: upstream gone');
      },
      chatStream: async function* () {
        throw new Error('not used in this test');
      },
      embed: async () => [[]],
      ping: async () => ({ ok: true, models: ['fake'] }),
    };

    const orchestrator = new Orchestrator({
      client: failingExecutorClient as unknown as OllamaClient,
      model: 'test',
      plannerThinking: false,
      evaluatorThinking: false,
      maxSteps: 5,
    });

    await orchestrator.start('failure-mid-run test');
    // The error from the executor's chatOnce propagates — we expect it.
    await expect(orchestrator.runUntilTerminal()).rejects.toThrow(/HTTP 503/);

    // Critical: state in storage must be ABORTED. Without the orchestrator's
    // catch-and-transition, a subsequent resume() would re-pick the task.
    const final = await store.loadHot();
    expect(final?.phase).toBe('ABORTED');
  });
});

describe('orchestrator: clearHot drains the mutex (#agent.reset race)', () => {
  it('a queued patchHot does not restore state after clearHot returns', async () => {
    // Build a state, then race a patchHot against a clearHot. The clearHot
    // must drain the mutex so the patch either runs BEFORE clear (harmless,
    // we then clear) or runs after clear and fails (no hot state to patch).
    // Either way, the FINAL state must be cleared, not patched.
    const state = await store.startTask('drain test');
    expect((await store.loadHot())?.taskId).toBe(state.taskId);

    // Fire a patch and a clear concurrently.
    const patchPromise = store.patchHot({ phase: 'EXECUTING' }).catch(() => null);
    const clearPromise = store.clearHot();
    await Promise.all([patchPromise, clearPromise]);

    // After both resolve, state must be cleared. The patch either ran first
    // (then clear wiped it) or ran after clear (failed because no hot state).
    // Either ordering ends with cleared state.
    expect(await store.loadHot()).toBeNull();
  });
});

describe('orchestrator: hallucinated-tool breaker integration (#65)', () => {
  it('routes to PLANNING after the unknown-tool window fills', async () => {
    // The unknown-tool window is 8 turns wide; threshold 3. We script
    // 8 unique unknown-tool calls (different names/args so the
    // action-repeat trip doesn't fire first), then a finish after the
    // breaker forces replan. A periodic evaluator fires at turn 5 —
    // script it to "continue" so we keep marching.
    const unknownExec = (i: number) =>
      execR({ name: `made_up_tool_${i}`, arguments: { i } });

    const fake = new FakeOllamaClient({
      planner: [
        plannerR({
          rootSteps: [{ id: 's1', title: 'try a tool' }],
        }),
        plannerR({
          rootSteps: [{ id: 's1', title: 'after replan, finish' }],
        }),
      ],
      executor: [
        unknownExec(1),
        unknownExec(2),
        unknownExec(3),
        unknownExec(4),
        unknownExec(5),
        unknownExec(6),
        unknownExec(7),
        unknownExec(8), // 8th unknown — window full → breaker replan
        // After replan, finish.
        execR({ name: 'finish', arguments: { summary: 'recovered' } }),
      ],
      evaluator: [
        // Periodic eval at turn 5 — continue so the loop reaches turn 8.
        evalR('continue', { reason: 'still working' }),
        // Finish-triggered eval — done.
        evalR('done', { finalAnswer: 'recovered', reason: 'ok' }),
      ],
    });

    const orchestrator = new Orchestrator({
      client: fake as unknown as OllamaClient,
      model: 'test',
      plannerThinking: false,
      evaluatorThinking: false,
      maxSteps: 25,
    });

    await orchestrator.start('hallucinate then recover');
    const final = await orchestrator.runUntilTerminal();

    expect(final.phase).toBe('DONE');
    // The breaker should have a hallucinated-tool replan trip on file.
    const hallucTrips = final.breaker.trips.filter(
      (t) => /unknown-tool/i.test(t.reason),
    );
    expect(hallucTrips.length).toBeGreaterThanOrEqual(1);
    // Plan was actually revised once.
    expect(final.plan.revision).toBe(2);
  });
});

describe('orchestrator: telemetry metrics fire during a scripted run (#64)', () => {
  it('records role-level metrics for planner / executor / evaluator', async () => {
    const fake = new FakeOllamaClient({
      planner: [
        plannerR({
          criteria: ['done'],
          rootSteps: [{ id: 's1', title: 'echo then finish' }],
        }),
      ],
      executor: [
        execR({ name: 'echo', arguments: { text: 'hi' } }),
        execR({ name: 'finish', arguments: { summary: 'ok' } }),
      ],
      evaluator: [
        evalR('done', { finalAnswer: 'ok', reason: 'verified' }),
      ],
    });

    const orchestrator = new Orchestrator({
      client: fake as unknown as OllamaClient,
      model: 'test',
      plannerThinking: false,
      evaluatorThinking: false,
    });

    await orchestrator.start('telemetry test');
    const final = await orchestrator.runUntilTerminal();
    expect(final.phase).toBe('DONE');

    const { summary } = await import('../src/agent/metrics');
    const ops = await summary(final.taskId);

    // We expect at minimum: one planner_initial, one or more executor_turn,
    // one evaluator_finish (the on-finish path; a periodic might also fire
    // depending on EVAL_EVERY_N_STEPS).
    const opNames = ops.map((o) => o.op);
    expect(opNames).toContain('planner_initial');
    expect(opNames).toContain('executor_turn');
    expect(opNames.some((n) => n.startsWith('evaluator_'))).toBe(true);

    // Each recorded op has a non-negative latency (synthetic clients
    // resolve fast, so latency may be 0 or small — but never negative).
    for (const op of ops) {
      expect(op.meanLatencyMs).toBeGreaterThanOrEqual(0);
      expect(op.count).toBeGreaterThan(0);
      expect(op.successRate).toBeGreaterThanOrEqual(0);
      expect(op.successRate).toBeLessThanOrEqual(1);
    }
  });
});

describe('orchestrator: closeOwnedTabs cleanup hook fires at terminal', () => {
  it('clears persisted ownedTabs in hot state on DONE', async () => {
    // Construct a task that ends in DONE with ownedTabs persisted in
    // hot state (simulating the real scenario where tab.open had run
    // earlier in the task). The orchestrator's runUntilTerminal finally
    // block calls closeOwnedTabs(taskId). With no chrome.tabs mock
    // registered, the actual tab-close calls would throw — but
    // closeOwnedTabs swallows those errors and clears the persisted
    // ownedTabs anyway. Test: ownedTabs is empty after terminal.
    const fake = new FakeOllamaClient({
      planner: [
        plannerR({ rootSteps: [{ id: 's1', title: 'finish' }] }),
      ],
      executor: [
        execR({ name: 'finish', arguments: { summary: 'done' } }),
      ],
      evaluator: [
        evalR('done', { finalAnswer: 'done', reason: 'ok' }),
      ],
    });

    const orchestrator = new Orchestrator({
      client: fake as unknown as OllamaClient,
      model: 'test',
      plannerThinking: false,
      evaluatorThinking: false,
    });

    await orchestrator.start('cleanup test');
    // Pre-seed ownedTabs in hot state (as if tab.open had been called).
    await store.patchHot({ ownedTabs: [42, 43] });
    expect((await store.loadHot())?.ownedTabs).toEqual([42, 43]);

    const final = await orchestrator.runUntilTerminal();
    expect(final.phase).toBe('DONE');

    // After terminal cleanup, ownedTabs should be cleared in hot state.
    const post = await store.loadHot();
    expect(post?.ownedTabs).toEqual([]);
  });
});

describe('orchestrator: vision.ground tool registration', () => {
  it('registers vision.ground in the orchestrator registry', () => {
    const fake = new FakeOllamaClient({
      planner: [],
      executor: [],
      evaluator: [],
    });
    const orchestrator = new Orchestrator({
      client: fake as unknown as OllamaClient,
      model: 'test',
    });
    const names = orchestrator['registry'].names();
    expect(names).toContain('vision.ground');
  });
});

describe('orchestrator: per-role model routing', () => {
  it('routes each role to its provider model (planner override, executor default)', async () => {
    const fake = new FakeOllamaClient({
      planner: [plannerR({ rootSteps: [{ id: 's1', title: 'echo then finish' }] })],
      executor: [
        execR({ name: 'echo', arguments: { text: 'hi' } }),
        execR({ name: 'finish', arguments: { summary: 'ok' } }),
      ],
      evaluator: [evalR('done', { finalAnswer: 'ok', reason: 'v' })],
    });

    const orchestrator = new Orchestrator({
      defaultProvider: { client: fake as unknown as OllamaClient, model: 'qwen3.5:4b' },
      plannerProvider: { client: fake as unknown as OllamaClient, model: 'qwen3.6:35b-a3b', timeoutMs: 1500000, numPredict: 2048 },
      evaluatorProvider: { client: fake as unknown as OllamaClient, model: 'qwen3.6:35b-a3b', timeoutMs: 720000, numPredict: 2048 },
      plannerThinking: false,
      evaluatorThinking: false,
    });

    await orchestrator.start('routing test');
    const final = await orchestrator.runUntilTerminal();
    expect(final.phase).toBe('DONE');

    const byRole = (r: Role) => fake.callLog.filter((c) => c.role === r).map((c) => c.model);
    expect(byRole('planner').every((m) => m === 'qwen3.6:35b-a3b')).toBe(true);
    expect(byRole('evaluator').every((m) => m === 'qwen3.6:35b-a3b')).toBe(true);
    expect(byRole('executor').every((m) => m === 'qwen3.5:4b')).toBe(true);
  });
});
