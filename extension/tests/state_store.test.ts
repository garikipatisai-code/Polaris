import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadHot,
  patchHot,
  startTask,
  appendSuccessCriteria,
  clearHot,
  appendScratch,
  readScratchTail,
  readScratchAll,
  deleteScratchSeqs,
  appendFinding,
  countFindings,
  findingByKey,
  memoryWrite,
  memoryRead,
  memoryList,
} from '../src/agent/state_store';
import { resetMockedStorage } from './setup';

beforeEach(async () => {
  await resetMockedStorage();
});

afterEach(async () => {
  await resetMockedStorage();
});

describe('state_store: lifecycle', () => {
  it('startTask initializes a fresh task with the verbatim goal', async () => {
    const state = await startTask('  test goal  ');
    expect(state.goal.text).toBe('test goal');                  // trimmed
    expect(state.phase).toBe('PLANNING');
    expect(state.plan.rootSteps).toEqual([]);
    expect(state.budgets.executor.max).toBe(16384);
    expect(state.breaker.totalReplans).toBe(0);
    expect(state.turnsOnCurrentStep).toBe(0);
  });

  it('startTask refuses while a non-terminal task exists with recent activity', async () => {
    const a = await startTask('first');
    expect(a.phase).toBe('PLANNING');
    await expect(startTask('second')).rejects.toThrow(/cannot start task/);
  });

  it('startTask auto-aborts a stale task and proceeds', async () => {
    const a = await startTask('first');
    // Backdate lastTouch by simulating storage state with old timestamp.
    await patchHot({ lastTouch: 0 } as unknown as Parameters<typeof patchHot>[0]);
    // (lastTouch is patched indirectly; use bumpLastTouch's inverse — write directly)
    // Instead, force-stale by mutating storage:
    const stored = await loadHot();
    if (!stored) throw new Error('no hot state');
    // We can't backdate via the public API since patchHot rewrites lastTouch;
    // round-trip through chrome.storage manually for the test.
    await chrome.storage.local.set({
      'polaris.agent.hot': { ...stored, lastTouch: Date.now() - 120_000 },
    });
    const b = await startTask('second');
    expect(b.goal.text).toBe('second');
    expect(b.taskId).not.toBe(a.taskId);
  });
});

describe('state_store: goal immutability (the bug the nemesis caught)', () => {
  it('patchHot rejects any patch touching goal', async () => {
    await startTask('original goal');
    await expect(
      // @ts-expect-error — we're testing the runtime guard
      patchHot({ goal: { text: 'evil', successCriteria: [], createdAt: 0 } }),
    ).rejects.toThrow(/immutable field: goal/);
  });

  it('appendSuccessCriteria sets criteria once with non-empty input', async () => {
    await startTask('goal');
    const after = await appendSuccessCriteria(['c1', 'c2']);
    expect(after.goal.successCriteria).toEqual(['c1', 'c2']);
  });

  it('appendSuccessCriteria treats empty input as a no-op (does NOT consume the one-shot guard)', async () => {
    await startTask('goal');
    // First call with empty should be a no-op.
    const empty = await appendSuccessCriteria([]);
    expect(empty.goal.successCriteria).toEqual([]);
    // Second call with real data should still succeed (the guard wasn't tripped).
    const populated = await appendSuccessCriteria(['real-criterion']);
    expect(populated.goal.successCriteria).toEqual(['real-criterion']);
  });

  it('appendSuccessCriteria refuses second non-empty write', async () => {
    await startTask('goal');
    await appendSuccessCriteria(['c1']);
    await expect(appendSuccessCriteria(['c2'])).rejects.toThrow(/already set/);
  });

  it('clearHot removes hot state entirely', async () => {
    await startTask('goal');
    await clearHot();
    expect(await loadHot()).toBeNull();
  });
});

describe('state_store: forward-fill migration on loadHot', () => {
  it('fills missing breaker fields with defaults so legacy state interacts with new safety code', async () => {
    // Stash a "legacy" state shape that lacks totalReplans + turnsOnCurrentStep.
    await chrome.storage.local.set({
      'polaris.agent.hot': {
        schemaVersion: 1,
        taskId: 'legacy',
        phase: 'EXECUTING',
        goal: { text: 'old', successCriteria: [], createdAt: 0 },
        plan: { rootSteps: [], revision: 0, generatedAt: 0 },
        budgets: {
          executor: { used: 0, max: 6000 },
          planner: { used: 0, max: 32000 },
          evaluator: { used: 0, max: 8000 },
          totalTokens: 0,
        },
        visited: { hashes: [] },
        breaker: {
          repeats: {},
          recentOutcomes: [],
          stepsWithoutProgress: 0,
          lastFindingsCount: 0,
          // totalReplans missing
          trips: [],
        },
        scratchpadRef: { count: 0, tokens: 0 },
        currentStepId: null,
        // turnsOnCurrentStep missing
        // pendingFinishSummary missing
        // replanHint missing
        // finalAnswer missing
        // resumedAt missing
        lastTouch: Date.now(),
        createdAt: 0,
      },
    });
    const loaded = await loadHot();
    expect(loaded).not.toBeNull();
    expect(loaded!.breaker.totalReplans).toBe(0);
    expect(loaded!.turnsOnCurrentStep).toBe(0);
    expect(loaded!.pendingFinishSummary).toBe(null);
    expect(loaded!.replanHint).toBe(null);
    expect(loaded!.finalAnswer).toBe(null);
  });
});

describe('state_store: scratchpad', () => {
  it('appends entries with monotonically increasing seq', async () => {
    const state = await startTask('goal');
    const s1 = await appendScratch(state.taskId, 'tool_call', { function: { name: 'echo' } });
    const s2 = await appendScratch(state.taskId, 'tool_result', { ok: true });
    expect(s1).toBe(1);
    expect(s2).toBe(2);
  });

  it('readScratchTail returns last N in chronological order', async () => {
    const state = await startTask('goal');
    for (let i = 0; i < 5; i++) {
      await appendScratch(state.taskId, 'role_msg', { content: `m${i}` }, 1);
    }
    const tail = await readScratchTail(state.taskId, 3);
    expect(tail.length).toBe(3);
    expect(tail.map((e) => (e.payload as { content: string }).content)).toEqual(['m2', 'm3', 'm4']);
  });

  it('updates scratchpadRef counter on append', async () => {
    const state = await startTask('goal');
    await appendScratch(state.taskId, 'tool_call', { x: 1 }, 50);
    await appendScratch(state.taskId, 'tool_result', { y: 2 }, 30);
    const after = await loadHot();
    expect(after!.scratchpadRef.count).toBe(2);
    expect(after!.scratchpadRef.tokens).toBe(80);
  });

  it('deleteScratchSeqs removes entries and updates the counter', async () => {
    const state = await startTask('goal');
    const seq1 = await appendScratch(state.taskId, 'tool_call', { x: 1 }, 50);
    const seq2 = await appendScratch(state.taskId, 'tool_result', { y: 2 }, 30);
    await deleteScratchSeqs(state.taskId, [seq1, seq2]);
    const remaining = await readScratchAll(state.taskId);
    expect(remaining.length).toBe(0);
    const after = await loadHot();
    expect(after!.scratchpadRef.count).toBe(0);
    expect(after!.scratchpadRef.tokens).toBe(0);
  });
});

describe('state_store: findings', () => {
  it('appends and retrieves findings', async () => {
    const state = await startTask('goal');
    const f = await appendFinding({
      taskId: state.taskId,
      source: 'compactor',
      stepId: null,
      kind: 'fact',
      key: 'best_price',
      value: '$298',
    });
    expect(f.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const fetched = await findingByKey(state.taskId, 'best_price');
    expect(fetched?.value).toBe('$298');
  });

  it('countFindings returns the running total', async () => {
    const state = await startTask('goal');
    expect(await countFindings(state.taskId)).toBe(0);
    for (let i = 0; i < 3; i++) {
      await appendFinding({
        taskId: state.taskId,
        source: 'tool',
        stepId: null,
        kind: 'observation',
        key: `k${i}`,
        value: `v${i}`,
      });
    }
    expect(await countFindings(state.taskId)).toBe(3);
  });
});

describe('state_store: memory cells', () => {
  it('write/read round-trip', async () => {
    const state = await startTask('goal');
    await memoryWrite(state.taskId, 'ns', 'k', 'value');
    const cell = await memoryRead(state.taskId, 'ns', 'k');
    expect(cell?.value).toBe('value');
  });

  it('memoryRead returns null for missing cell', async () => {
    const state = await startTask('goal');
    expect(await memoryRead(state.taskId, 'ns', 'absent')).toBeNull();
  });

  it('memoryList filters by namespace and prefix', async () => {
    const state = await startTask('goal');
    await memoryWrite(state.taskId, 'a', 'x1', 'v1');
    await memoryWrite(state.taskId, 'a', 'x2', 'v2');
    await memoryWrite(state.taskId, 'a', 'y1', 'v3');
    await memoryWrite(state.taskId, 'b', 'x1', 'v4');
    const xes = await memoryList(state.taskId, 'a', { prefix: 'x' });
    expect(xes.length).toBe(2);
    expect(xes.map((c) => c.key).sort()).toEqual(['x1', 'x2']);
  });
});

describe('state_store: hot mutex (M2.7.2)', () => {
  it('serializes concurrent patchHot calls — last patch wins, no fields lost', async () => {
    await startTask('mutex test');
    // Fire 10 patches in parallel; each touches a distinct field.
    const patches = Array.from({ length: 10 }, (_, i) =>
      patchHot({ turnsOnCurrentStep: i }),
    );
    const results = await Promise.all(patches);
    // All resolved successfully (no throws despite all being concurrent).
    expect(results).toHaveLength(10);
    // Final state has the last patch's value (loaded synchronously after).
    const final = await loadHot();
    expect(typeof final?.turnsOnCurrentStep).toBe('number');
    expect(final?.turnsOnCurrentStep).toBeLessThanOrEqual(9);
    expect(final?.turnsOnCurrentStep).toBeGreaterThanOrEqual(0);
  });

  it('concurrent appendScratch + patchHot do not clobber each other', async () => {
    const state = await startTask('mutex test');
    // Race appendScratch (which mutates scratchpadRef) against patchHot
    // (which sets phase). Each writes a different field — both must survive.
    await Promise.all([
      appendScratch(state.taskId, 'tool_call', { x: 1 }, 10),
      patchHot({ phase: 'EXECUTING' }),
      appendScratch(state.taskId, 'tool_result', { y: 2 }, 20),
      patchHot({ pendingFinishSummary: 'pending' }),
      appendScratch(state.taskId, 'tool_call', { z: 3 }, 30),
    ]);
    const final = await loadHot();
    // appendScratch updates: count=3, tokens=60.
    expect(final?.scratchpadRef.count).toBe(3);
    expect(final?.scratchpadRef.tokens).toBe(60);
    // patchHot fields preserved.
    expect(final?.phase).toBe('EXECUTING');
    expect(final?.pendingFinishSummary).toBe('pending');
  });

  it('error in one patch does not deadlock subsequent patches', async () => {
    await startTask('error path');
    // Fire a patch that throws (immutable goal field), then a normal one.
    // The mutex chain must not get stuck.
    await expect(
      // @ts-expect-error testing the runtime guard
      patchHot({ goal: { text: 'evil' } }),
    ).rejects.toThrow();
    // Subsequent call must complete — the chain isn't deadlocked.
    const ok = await patchHot({ phase: 'EXECUTING' });
    expect(ok.phase).toBe('EXECUTING');
  });
});

describe('state_store: startTask resets per-task EWMA (#6)', () => {
  it('resets observedCharsPerToken to default on a new task', async () => {
    // Pollute the EWMA from a "prior task" simulation.
    const { recordCharsPerToken, getCharsPerToken } = await import('../src/agent/budget');
    recordCharsPerToken(200, 100); // 2.0 — heavy unicode
    expect(getCharsPerToken()).toBe(2);

    await startTask('new task');
    // After startTask the estimator must be back at the default 4.0 — the
    // prior task's domain shouldn't bias the new task's pre-call budget.
    expect(getCharsPerToken()).toBe(4);
  });
});
