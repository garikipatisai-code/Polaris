// Circuit breaker — wraps the Executor's tool dispatch with stuck-loop and
// failure-rate guards. Trip signatures:
//
//   1. Action repetition: same (toolName, canonical args) called ≥3
//      consecutive times → replan
//   2. Soft no-progress: ≥10 consecutive Executor turns without findings
//      growth → replan. Note this is a coarse signal because findings only
//      grow during compaction; we keep it as a long-window safety net rather
//      than a tight loop guard.
//   3. Total replans ≥ MAX_TOTAL_REPLANS → abort (prevents the planner ↔
//      executor ping-pong that bit M2.6.1 testing).
//   4. Fatal tool error: any ToolResult with fatal=true → abort
//
// Counters are reset by the orchestrator on PLANNING entry so that a
// successful replan starts the no-progress window from scratch.

import type { AgentStateHot, BreakerState } from '../shared/agent_types';
import { log } from './log';

export interface PlannedAction {
  name: string;
  args: unknown;
}

export type BreakerResult =
  | { kind: 'ok' }
  | { kind: 'replan'; reason: string }
  | { kind: 'abort'; reason: string };

const MAX_REPEATS = 3;
const NO_PROGRESS_THRESHOLD = 10;
export const MAX_TOTAL_REPLANS = 3;
const RECENT_OUTCOMES_WINDOW = 5;

/** Stable canonical hash of (toolName, args). Sorts object keys for repeatability. */
export function actionHash(name: string, args: unknown): string {
  return `${name}::${stableStringify(args)}`;
}

function stableStringify(v: unknown): string {
  if (v === null || v === undefined) return JSON.stringify(v ?? null);
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) {
    return '[' + v.map(stableStringify).join(',') + ']';
  }
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/**
 * Evaluate the current breaker state to decide whether to continue, replan,
 * or abort. Pure function — does not mutate state.
 */
export function evaluate(state: AgentStateHot, lastAction?: PlannedAction): BreakerResult {
  // 0. Hard cap on total replans for a task.
  if (state.breaker.totalReplans >= MAX_TOTAL_REPLANS) {
    return {
      kind: 'abort',
      reason: `replanned ${state.breaker.totalReplans} times — task appears unsolvable with current tools`,
    };
  }
  // 1. Action repetition.
  if (lastAction) {
    const h = actionHash(lastAction.name, lastAction.args);
    const reps = state.breaker.repeats[h] ?? 0;
    if (reps >= MAX_REPEATS) {
      return {
        kind: 'replan',
        reason: `stuck repeating ${lastAction.name}(${truncate(stableStringify(lastAction.args), 80)}) ${reps} times — try a different approach`,
      };
    }
  }
  // 2. Long-window no-progress safety. The signal is coarse (findings only
  // grow on compaction) so threshold is generous.
  if (state.breaker.stepsWithoutProgress >= NO_PROGRESS_THRESHOLD) {
    return {
      kind: 'replan',
      reason: `no findings growth in last ${state.breaker.stepsWithoutProgress} turns — plan may be wrong`,
    };
  }
  return { kind: 'ok' };
}

/** Reset short-window counters that should not survive a replan boundary. */
export function resetForReplan(state: BreakerState): BreakerState {
  log('info', 'breaker', 'resetForReplan', {
    fromStepsWithoutProgress: state.stepsWithoutProgress,
    totalReplansBefore: state.totalReplans,
  });
  return {
    ...state,
    repeats: {},
    stepsWithoutProgress: 0,
    lastFindingsCount: 0,
    recentOutcomes: [],
    totalReplans: state.totalReplans + 1,
  };
}

/**
 * Compute the new breaker state after a tool call completes. Pure function:
 * the orchestrator persists the returned BreakerState via state_store.
 *
 * Also flags fatal tool errors as an immediate abort signal.
 */
export function recordAfter(
  state: AgentStateHot,
  action: PlannedAction,
  result: { ok: boolean; fatal?: boolean },
  currentFindingsCount: number,
): { breaker: BreakerState; abortReason?: string } {
  const h = actionHash(action.name, action.args);
  // Track *consecutive* repeats only — reset other action counts.
  const repeats: Record<string, number> = {
    [h]: (state.breaker.repeats[h] ?? 0) + 1,
  };

  // Sliding window of last N outcomes (for future error-rate signature).
  const recentOutcomes = [
    ...state.breaker.recentOutcomes,
    result.ok ? ('ok' as const) : ('error' as const),
  ].slice(-RECENT_OUTCOMES_WINDOW);

  // Progress: did findings grow this turn?
  const stepsWithoutProgress =
    currentFindingsCount > state.breaker.lastFindingsCount
      ? 0
      : state.breaker.stepsWithoutProgress + 1;

  const trips = [...state.breaker.trips];
  let abortReason: string | undefined;
  if (result.fatal) {
    abortReason = `tool ${action.name} returned a non-recoverable error`;
    trips.push({ at: Date.now(), reason: abortReason, level: 'abort' });
  }

  return {
    breaker: {
      repeats,
      recentOutcomes,
      stepsWithoutProgress,
      lastFindingsCount: currentFindingsCount,
      totalReplans: state.breaker.totalReplans,
      trips: trips.slice(-5),
    },
    abortReason,
  };
}

/**
 * Append a trip record to the breaker state. Caller persists the new state.
 * Used by the orchestrator when evaluate() returned non-ok.
 */
export function recordTrip(
  state: AgentStateHot,
  reason: string,
  level: 'replan' | 'abort',
): BreakerState {
  return {
    ...state.breaker,
    trips: [...state.breaker.trips, { at: Date.now(), reason, level }].slice(-5),
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
