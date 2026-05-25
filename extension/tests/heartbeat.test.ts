// Heartbeat edge-case tests (M3.5 follow-up).
//
// The Orchestrator's heartbeat (`startHeartbeat`) bumps `lastTouch` every
// 30 s while runUntilTerminal is in flight. This is what keeps the SW
// watchdog from killing a long Planner / Evaluator call. The previous test
// suite had no direct coverage for the timer mechanics — we asserted it
// indirectly by trusting state_store.bumpLastTouch's behavior.
//
// Implementation note: vitest's `vi.useFakeTimers()` mocks Date.now() and
// queueMicrotask by default, which collides with fake-indexeddb's internal
// scheduling. We selectively mock only `setInterval` / `clearInterval` /
// `setTimeout` so IDB operations still resolve naturally.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Orchestrator } from '../src/agent/orchestrator';
import * as store from '../src/agent/state_store';
import type { OllamaClient, ChatChunk, ChatOptions } from '../src/background/ollama';
import { resetMockedStorage } from './setup';

beforeEach(async () => {
  await resetMockedStorage();
});

afterEach(async () => {
  vi.useRealTimers();
  await resetMockedStorage();
});

// ---------------------------------------------------------------------------
// Minimal scripted client — drives orchestrator.start() to a parked state
// in EXECUTING phase by responding to the initial Planner call with a 1-step
// plan, but lets the test stop the orchestrator before the executor turn
// runs (so we can examine heartbeat behavior in isolation).
// ---------------------------------------------------------------------------

function plannerResponse(): ChatChunk {
  return {
    message: {
      role: 'assistant',
      content: JSON.stringify({
        rootSteps: [{ id: 's1', title: 'wait' }],
        notes: 'parked',
      }),
    },
    done: true,
    prompt_eval_count: 50,
    eval_count: 10,
  };
}

class StubClient {
  baseUrl = 'http://stub';
  url(p: string): string {
    return this.baseUrl + p;
  }
  async chatOnce(opts: ChatOptions): Promise<ChatChunk> {
    const sys = opts.messages.find((m) => m.role === 'system')?.content ?? '';
    if (sys.startsWith('You are the PLANNER')) {
      return plannerResponse();
    }
    // For non-planner calls in these tests we just hang — the test
    // intercepts the heartbeat before the executor turn lands.
    throw new Error('StubClient unused for non-planner');
  }
  async *chatStream(): AsyncGenerator<ChatChunk> {
    throw new Error('not used');
  }
  async embed(): Promise<number[][]> {
    return [[]];
  }
  async ping(): Promise<{ ok: boolean; models?: string[] }> {
    return { ok: true, models: ['stub'] };
  }
}

describe('Orchestrator heartbeat: setInterval mechanics', () => {
  it('start() schedules a 30s interval; clearing it on stop() prevents further bumpLastTouch', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    // Spy on the actual bumpLastTouch so we can count interval-driven calls
    // without depending on Date.now resolution (which we kept real to avoid
    // breaking fake-indexeddb's microtask scheduling).
    const bumpSpy = vi.spyOn(store, 'bumpLastTouch');

    const orch = new Orchestrator({
      client: new StubClient() as unknown as OllamaClient,
      model: 'stub',
      plannerThinking: false,
      evaluatorThinking: false,
    });

    await orch.start('heartbeat test');
    expect((await store.loadHot())?.phase).toBe('EXECUTING');
    // bumpLastTouch may have been called as part of start() / patchHot —
    // record the baseline.
    const baselineCalls = bumpSpy.mock.calls.length;

    // Advance 30s — exactly one interval-driven bump.
    await vi.advanceTimersByTimeAsync(30_000);
    await new Promise((r) => setImmediate(r));
    expect(bumpSpy.mock.calls.length).toBe(baselineCalls + 1);

    // Advance another 30s — second interval-driven bump.
    await vi.advanceTimersByTimeAsync(30_000);
    await new Promise((r) => setImmediate(r));
    expect(bumpSpy.mock.calls.length).toBe(baselineCalls + 2);

    // stop() clears the heartbeat.
    await orch.stop();
    const callsAfterStop = bumpSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    await new Promise((r) => setImmediate(r));
    // No further interval-driven bumps after stop.
    expect(bumpSpy.mock.calls.length).toBe(callsAfterStop);
  });

  it('multiple start() calls do not leak intervals', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');

    const orch = new Orchestrator({
      client: new StubClient() as unknown as OllamaClient,
      model: 'stub',
      plannerThinking: false,
      evaluatorThinking: false,
    });

    await orch.start('first');
    const firstSetCount = setSpy.mock.calls.filter((c) => c[1] === 30_000).length;
    expect(firstSetCount).toBe(1);

    // start() again should clear the previous interval before creating a new one.
    // (In practice you'd never re-start without stopping; this is a
    // defensive test of the startHeartbeat -> stopHeartbeat -> setInterval pattern.)
    await store.clearHot(); // make startTask happy
    await orch.start('second');

    const secondSetCount = setSpy.mock.calls.filter((c) => c[1] === 30_000).length;
    const totalClears = clearSpy.mock.calls.length;
    expect(secondSetCount).toBe(2); // two intervals scheduled total
    expect(totalClears).toBeGreaterThanOrEqual(1); // at least one cleared

    await orch.stop();
  });

  it('bumpLastTouch errors are caught + logged; heartbeat keeps running', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Stub bumpLastTouch to throw on the first call and resolve on later
    // calls. Don't try to delegate to the "real" implementation — under
    // some Vitest module-binding orderings the captured reference resolves
    // back to the spy and we infinite-loop. The test only needs to assert
    // that the heartbeat keeps firing past an error, not that lastTouch
    // is actually written.
    let calls = 0;
    const stubbed = vi.spyOn(store, 'bumpLastTouch').mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error('synthetic IDB hiccup');
      return undefined;
    });

    const orch = new Orchestrator({
      client: new StubClient() as unknown as OllamaClient,
      model: 'stub',
      plannerThinking: false,
      evaluatorThinking: false,
    });
    await orch.start('error test');

    // First tick — bumpLastTouch throws.
    await vi.advanceTimersByTimeAsync(30_000);
    await new Promise((r) => setImmediate(r));
    expect(warnSpy).toHaveBeenCalled();
    // Second tick — should still fire (heartbeat didn't die).
    await vi.advanceTimersByTimeAsync(30_000);
    await new Promise((r) => setImmediate(r));
    expect(stubbed.mock.calls.length).toBeGreaterThanOrEqual(2);

    await orch.stop();
    warnSpy.mockRestore();
  });
});

describe('Orchestrator heartbeat: terminal-phase cleanup', () => {
  it('runUntilTerminal finally block clears the interval even if executor errors', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');

    // Throwing client: planner OK, then any subsequent call throws.
    let plannerCalls = 0;
    const throwAfterPlanner: StubClient = {
      baseUrl: 'http://stub',
      url(p: string) { return this.baseUrl + p; },
      async chatOnce(opts) {
        const sys = opts.messages.find((m) => m.role === 'system')?.content ?? '';
        if (sys.startsWith('You are the PLANNER')) {
          plannerCalls++;
          if (plannerCalls === 1) return plannerResponse();
        }
        throw new Error('synthetic role failure');
      },
      async *chatStream() { throw new Error('not used'); },
      async embed() { return [[]]; },
      async ping() { return { ok: true, models: ['stub'] }; },
    };

    const orch = new Orchestrator({
      client: throwAfterPlanner as unknown as OllamaClient,
      model: 'stub',
      plannerThinking: false,
      evaluatorThinking: false,
      maxSteps: 5,
    });

    await orch.start('error path');
    // The executor's chatOnce throws; runUntilTerminal catches, transitions
    // to ABORTED, re-raises. Our finally block must clear the heartbeat.
    await expect(orch.runUntilTerminal()).rejects.toThrow();

    // Heartbeat interval was created (in start()); now should be cleared.
    const ourSets = setSpy.mock.calls.filter((c) => c[1] === 30_000);
    expect(ourSets.length).toBe(1);
    const ourTimerId = setSpy.mock.results[setSpy.mock.calls.indexOf(ourSets[0]!)]!.value;
    const cleared = clearSpy.mock.calls.some((c) => c[0] === ourTimerId);
    expect(cleared).toBe(true);
  });
});
