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
