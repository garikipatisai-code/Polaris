import { describe, expect, it } from 'vitest';
import {
  actionHash,
  evaluate,
  recordAfter,
  resetForReplan,
  recordTrip,
  MAX_TOTAL_REPLANS,
} from '../src/agent/circuit_breaker';
import type { AgentStateHot, BreakerState } from '../src/shared/agent_types';

function freshBreaker(overrides: Partial<BreakerState> = {}): BreakerState {
  return {
    repeats: {},
    recentOutcomes: [],
    recentActionHashes: [],
    recentUnknownToolFlags: [],
    stepsWithoutProgress: 0,
    lastFindingsCount: 0,
    totalReplans: 0,
    trips: [],
    ...overrides,
  };
}

function fakeState(breaker: BreakerState): AgentStateHot {
  return {
    schemaVersion: 1,
    taskId: 'test-task',
    phase: 'EXECUTING',
    goal: { text: 'test goal', successCriteria: [], createdAt: 0 },
    plan: { rootSteps: [], revision: 0, generatedAt: 0 },
    budgets: {
      executor: { used: 0, max: 6000 },
      planner: { used: 0, max: 32000 },
      evaluator: { used: 0, max: 8000 },
      totalTokens: 0,
    },
    visited: { hashes: [] },
    breaker,
    scratchpadRef: { count: 0, tokens: 0 },
    currentStepId: null,
    turnsOnCurrentStep: 0,
    pendingFinishSummary: null,
    replanHint: null,
    finalAnswer: null,
    lastTouch: 0,
    resumedAt: null,
    createdAt: 0,
  };
}

describe('actionHash', () => {
  it('produces the same hash regardless of object key order', () => {
    expect(actionHash('tool', { a: 1, b: 2 })).toBe(actionHash('tool', { b: 2, a: 1 }));
  });
  it('distinguishes different tool names', () => {
    expect(actionHash('a', { x: 1 })).not.toBe(actionHash('b', { x: 1 }));
  });
  it('distinguishes different argument values', () => {
    expect(actionHash('tool', { x: 1 })).not.toBe(actionHash('tool', { x: 2 }));
  });
  it('handles primitives and nested objects', () => {
    expect(actionHash('t', 42)).toBe(actionHash('t', 42));
    expect(actionHash('t', { a: { b: [1, 2, 3] } })).toBe(actionHash('t', { a: { b: [1, 2, 3] } }));
    expect(actionHash('t', { a: [1, 2] })).not.toBe(actionHash('t', { a: [2, 1] }));
  });
  it('handles undefined and null', () => {
    expect(actionHash('t', null)).toBe(actionHash('t', null));
    expect(actionHash('t', undefined)).toBe(actionHash('t', undefined));
  });
});

describe('evaluate', () => {
  it('returns ok for fresh state', () => {
    const state = fakeState(freshBreaker());
    expect(evaluate(state).kind).toBe('ok');
  });
  it('returns ok with a fresh action', () => {
    const state = fakeState(freshBreaker());
    expect(evaluate(state, { name: 'echo', args: { text: 'hi' } }).kind).toBe('ok');
  });
  it('replans when an action has been repeated MAX_REPEATS times', () => {
    const action = { name: 'echo', args: { text: 'hi' } };
    const state = fakeState(freshBreaker({ repeats: { [actionHash(action.name, action.args)]: 3 } }));
    const result = evaluate(state, action);
    expect(result.kind).toBe('replan');
    if (result.kind === 'replan') expect(result.reason).toMatch(/repeating/);
  });
  it('does NOT replan at 2 repeats (just below threshold)', () => {
    const action = { name: 'echo', args: { text: 'hi' } };
    const state = fakeState(freshBreaker({ repeats: { [actionHash(action.name, action.args)]: 2 } }));
    expect(evaluate(state, action).kind).toBe('ok');
  });
  it('replans on no-progress threshold', () => {
    const state = fakeState(freshBreaker({ stepsWithoutProgress: 10 }));
    expect(evaluate(state).kind).toBe('replan');
  });
  it('aborts when totalReplans exceeds MAX_TOTAL_REPLANS', () => {
    const state = fakeState(freshBreaker({ totalReplans: MAX_TOTAL_REPLANS }));
    const result = evaluate(state);
    expect(result.kind).toBe('abort');
    if (result.kind === 'abort') expect(result.reason).toMatch(/replanned/);
  });
});

describe('recordAfter', () => {
  it('increments repeat counter for the same action', () => {
    const state = fakeState(freshBreaker());
    const action = { name: 'echo', args: { x: 1 } };
    const r = recordAfter(state, action, { ok: true }, 0);
    const h = actionHash(action.name, action.args);
    expect(r.breaker.repeats[h]).toBe(1);
    const state2 = fakeState(r.breaker);
    const r2 = recordAfter(state2, action, { ok: true }, 0);
    expect(r2.breaker.repeats[h]).toBe(2);
  });
  it('clears other action counters when a new action is taken (consecutive-only)', () => {
    const a1 = { name: 'echo', args: { x: 1 } };
    const a2 = { name: 'add', args: { a: 1, b: 2 } };
    const state = fakeState(freshBreaker({ repeats: { [actionHash(a1.name, a1.args)]: 5 } }));
    const r = recordAfter(state, a2, { ok: true }, 0);
    expect(r.breaker.repeats[actionHash(a1.name, a1.args)]).toBeUndefined();
    expect(r.breaker.repeats[actionHash(a2.name, a2.args)]).toBe(1);
  });
  it('increments stepsWithoutProgress when findings count is unchanged', () => {
    const state = fakeState(freshBreaker({ lastFindingsCount: 3, stepsWithoutProgress: 4 }));
    const r = recordAfter(state, { name: 't', args: {} }, { ok: true }, 3);
    expect(r.breaker.stepsWithoutProgress).toBe(5);
    expect(r.breaker.lastFindingsCount).toBe(3);
  });
  it('resets stepsWithoutProgress when findings count grows', () => {
    const state = fakeState(freshBreaker({ lastFindingsCount: 3, stepsWithoutProgress: 4 }));
    const r = recordAfter(state, { name: 't', args: {} }, { ok: true }, 5);
    expect(r.breaker.stepsWithoutProgress).toBe(0);
    expect(r.breaker.lastFindingsCount).toBe(5);
  });
  it('flags fatal tool errors with abortReason', () => {
    const state = fakeState(freshBreaker());
    const r = recordAfter(state, { name: 't', args: {} }, { ok: false, fatal: true }, 0);
    expect(r.abortReason).toMatch(/non-recoverable/);
    expect(r.breaker.trips.at(-1)?.level).toBe('abort');
  });
  it('preserves totalReplans across recordAfter (does not zero it)', () => {
    const state = fakeState(freshBreaker({ totalReplans: 2 }));
    const r = recordAfter(state, { name: 't', args: {} }, { ok: true }, 0);
    expect(r.breaker.totalReplans).toBe(2);
  });
  it('caps recentOutcomes at 5 entries (sliding window)', () => {
    let state = fakeState(freshBreaker());
    for (let i = 0; i < 8; i++) {
      const r = recordAfter(state, { name: 't', args: { i } }, { ok: i % 2 === 0 }, 0);
      state = fakeState(r.breaker);
    }
    expect(state.breaker.recentOutcomes.length).toBe(5);
  });
});

describe('resetForReplan', () => {
  it('zeros short-window counters and increments totalReplans', () => {
    const before = freshBreaker({
      repeats: { foo: 3 },
      recentOutcomes: ['ok', 'error', 'ok'],
      stepsWithoutProgress: 7,
      lastFindingsCount: 5,
      totalReplans: 1,
      trips: [{ at: 1, reason: 'old', level: 'replan' }],
    });
    const after = resetForReplan(before);
    expect(after.repeats).toEqual({});
    expect(after.recentOutcomes).toEqual([]);
    expect(after.stepsWithoutProgress).toBe(0);
    expect(after.lastFindingsCount).toBe(0);
    expect(after.totalReplans).toBe(2);
    // Trips are NOT cleared — they're telemetry.
    expect(after.trips.length).toBe(1);
  });
});

describe('recordTrip', () => {
  it('appends a trip with timestamp and level', () => {
    const state = fakeState(freshBreaker());
    const out = recordTrip(state, 'test reason', 'replan');
    expect(out.trips.length).toBe(1);
    expect(out.trips[0]!.reason).toBe('test reason');
    expect(out.trips[0]!.level).toBe('replan');
    expect(out.trips[0]!.at).toBeGreaterThan(0);
  });
  it('caps trip log at 5 entries', () => {
    let state = fakeState(freshBreaker());
    for (let i = 0; i < 8; i++) {
      state = fakeState(recordTrip(state, `r${i}`, 'replan'));
    }
    expect(state.breaker.trips.length).toBe(5);
    // Newest preserved.
    expect(state.breaker.trips.at(-1)?.reason).toBe('r7');
  });
});

describe('distinct-action breaker signal (M2.7.2)', () => {
  it('does NOT trip until the window is full (no early-task false positives)', () => {
    // Fill 9 slots with the same action — under DISTINCT_WINDOW=10, no trip.
    const hashes = Array.from({ length: 9 }, () => actionHash('echo', { text: 'a' }));
    const result = evaluate(fakeState(freshBreaker({ recentActionHashes: hashes })));
    expect(result.kind).toBe('ok');
  });

  it('trips replan when only 1 distinct action in last 10 turns', () => {
    const hashes = Array.from({ length: 10 }, () => actionHash('echo', { text: 'a' }));
    const result = evaluate(fakeState(freshBreaker({ recentActionHashes: hashes })));
    expect(result.kind).toBe('replan');
    expect(result.kind === 'replan' && result.reason).toMatch(/distinct actions/);
  });

  it('trips replan when only 2 distinct actions in last 10 turns', () => {
    // 5×echo, 5×add — 2 distinct, under DISTINCT_MIN=3
    const hashes = [
      ...Array.from({ length: 5 }, () => actionHash('echo', { text: 'a' })),
      ...Array.from({ length: 5 }, () => actionHash('add', { a: 1, b: 1 })),
    ];
    const result = evaluate(fakeState(freshBreaker({ recentActionHashes: hashes })));
    expect(result.kind).toBe('replan');
  });

  it('does not trip with 3+ distinct actions (healthy task)', () => {
    const hashes = [
      actionHash('memory.write', { ns: 'x', key: 'a', value: '1' }),
      actionHash('memory.write', { ns: 'x', key: 'b', value: '2' }),
      actionHash('memory.write', { ns: 'x', key: 'c', value: '3' }),
      actionHash('memory.read', { ns: 'x', key: 'a' }),
      actionHash('memory.read', { ns: 'x', key: 'b' }),
      actionHash('memory.read', { ns: 'x', key: 'c' }),
      actionHash('sum', { numbers: [1, 2, 3] }),
      actionHash('next_step', {}),
      actionHash('echo', { text: 'done' }),
      actionHash('finish', { summary: 'sum is 6' }),
    ];
    const result = evaluate(fakeState(freshBreaker({ recentActionHashes: hashes })));
    expect(result.kind).toBe('ok');
  });

  it('recordAfter pushes to recentActionHashes and slides window at capacity', () => {
    let state = fakeState(freshBreaker());
    for (let i = 0; i < 12; i++) {
      const update = recordAfter(state, { name: 'echo', args: { text: `t${i}` } }, { ok: true }, 0);
      state = fakeState(update.breaker);
    }
    // Window capped at 10.
    expect(state.breaker.recentActionHashes.length).toBe(10);
    // Oldest entries dropped.
    expect(state.breaker.recentActionHashes[0]).toContain('t2');
    expect(state.breaker.recentActionHashes.at(-1)).toContain('t11');
  });

  it('resetForReplan wipes recentActionHashes', () => {
    const before = freshBreaker({
      recentActionHashes: [actionHash('echo', {}), actionHash('add', {})],
    });
    const after = resetForReplan(before);
    expect(after.recentActionHashes).toEqual([]);
  });
});

describe('hallucinated-tool window (#65)', () => {
  it('does NOT trip until window is full (≥8 turns)', () => {
    // Even with all 7 turns being unknown tools, the window isn't full
    // yet → no trip (early-task false-positive guard).
    const flags: (0 | 1)[] = [1, 1, 1, 1, 1, 1, 1];
    const result = evaluate(fakeState(freshBreaker({ recentUnknownToolFlags: flags })));
    expect(result.kind).toBe('ok');
  });

  it('trips replan when ≥3 of last 8 turns invoked unknown tools', () => {
    const flags: (0 | 1)[] = [1, 0, 1, 0, 0, 1, 0, 0];
    const result = evaluate(fakeState(freshBreaker({ recentUnknownToolFlags: flags })));
    expect(result.kind).toBe('replan');
    expect(result.kind === 'replan' && result.reason).toMatch(/unknown-tool/);
  });

  it('does not trip with 2 unknowns + 6 known (under threshold)', () => {
    const flags: (0 | 1)[] = [1, 0, 1, 0, 0, 0, 0, 0];
    const result = evaluate(fakeState(freshBreaker({ recentUnknownToolFlags: flags })));
    expect(result.kind).toBe('ok');
  });

  it('recordAfter pushes the unknownTool flag and slides at capacity', () => {
    let state = fakeState(freshBreaker());
    // 4 known calls + 3 unknown — ends with 7 entries; window cap is 8.
    for (let i = 0; i < 4; i++) {
      const update = recordAfter(
        state,
        { name: 'echo', args: { i } },
        { ok: true, unknownTool: false },
        0,
      );
      state = fakeState(update.breaker);
    }
    for (let i = 0; i < 3; i++) {
      const update = recordAfter(
        state,
        { name: `made_up_tool_${i}`, args: {} },
        { ok: false, unknownTool: true },
        0,
      );
      state = fakeState(update.breaker);
    }
    expect(state.breaker.recentUnknownToolFlags).toEqual([0, 0, 0, 0, 1, 1, 1]);

    // One more known call → window has 8 entries, 3 of which are unknowns.
    const update = recordAfter(
      state,
      { name: 'echo', args: {} },
      { ok: true, unknownTool: false },
      0,
    );
    state = fakeState(update.breaker);
    expect(state.breaker.recentUnknownToolFlags).toHaveLength(8);
    expect(state.breaker.recentUnknownToolFlags.filter((f) => f === 1)).toHaveLength(3);

    // evaluate should now trip.
    const decision = evaluate(state);
    expect(decision.kind).toBe('replan');
  });

  it('resetForReplan clears recentUnknownToolFlags', () => {
    const before = freshBreaker({ recentUnknownToolFlags: [1, 1, 1, 0, 0, 0, 0, 0] });
    const after = resetForReplan(before);
    expect(after.recentUnknownToolFlags).toEqual([]);
  });
});
