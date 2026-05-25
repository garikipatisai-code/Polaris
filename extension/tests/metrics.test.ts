// Tests for the telemetry foundation (#64 — M3.5).
//
// Covers:
//   * recordMetric round-trips through IDB
//   * metricsByTask returns chronological tail
//   * summary aggregates p50 / p95 / mean / success rate per op
//   * cross-task isolation (taskA's metrics don't leak into taskB's summary)
//   * empty-task summary returns []
//   * _resetMetrics(taskId) wipes only that task

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  recordMetric,
  metricsByTask,
  summary,
  _resetMetrics,
} from '../src/agent/metrics';
import { resetMockedStorage } from './setup';

beforeEach(async () => {
  await resetMockedStorage();
});
afterEach(async () => {
  await resetMockedStorage();
});

describe('recordMetric: round-trip', () => {
  it('writes a single metric and reads it back', async () => {
    await recordMetric({
      taskId: 't1',
      layer: 'role',
      op: 'executor_turn',
      latencyMs: 250,
      ok: true,
      meta: { promptTokens: 200 },
    });
    const all = await metricsByTask('t1');
    expect(all).toHaveLength(1);
    expect(all[0]!.op).toBe('executor_turn');
    expect(all[0]!.latencyMs).toBe(250);
    expect(all[0]!.ok).toBe(true);
    expect(all[0]!.meta).toEqual({ promptTokens: 200 });
  });

  it('records multiple metrics in chronological order', async () => {
    for (let i = 0; i < 5; i++) {
      await recordMetric({
        taskId: 't1',
        layer: 'role',
        op: 'executor_turn',
        latencyMs: 100 + i * 10,
        ok: true,
      });
    }
    const all = await metricsByTask('t1');
    expect(all).toHaveLength(5);
    // Latencies in insertion order.
    expect(all.map((m) => m.latencyMs)).toEqual([100, 110, 120, 130, 140]);
  });

  it('isolates metrics by taskId', async () => {
    await recordMetric({ taskId: 'a', layer: 'role', op: 'planner', latencyMs: 50, ok: true });
    await recordMetric({ taskId: 'b', layer: 'role', op: 'planner', latencyMs: 60, ok: true });
    await recordMetric({ taskId: 'a', layer: 'role', op: 'planner', latencyMs: 70, ok: true });
    expect((await metricsByTask('a')).map((m) => m.latencyMs)).toEqual([50, 70]);
    expect((await metricsByTask('b')).map((m) => m.latencyMs)).toEqual([60]);
  });

  it('failures in recordMetric do not throw (best-effort persistence)', async () => {
    // Pass a circular-ref meta that would JSON-fail. recordMetric should
    // catch and console.warn without throwing.
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    await expect(
      recordMetric({
        taskId: 't1',
        layer: 'role',
        op: 'x',
        latencyMs: 1,
        ok: true,
        meta: circ,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('summary', () => {
  it('returns empty array for a task with no metrics', async () => {
    expect(await summary('t1')).toEqual([]);
  });

  it('buckets by op + computes count, success rate, p50, p95, mean', async () => {
    // 5 executor turns, latencies 100, 200, 300, 400, 500 — last fails.
    for (const ms of [100, 200, 300, 400, 500]) {
      await recordMetric({
        taskId: 't1',
        layer: 'role',
        op: 'executor_turn',
        latencyMs: ms,
        ok: ms !== 500,
      });
    }
    // 2 planner turns, latencies 1000, 1500.
    for (const ms of [1000, 1500]) {
      await recordMetric({
        taskId: 't1',
        layer: 'role',
        op: 'planner_initial',
        latencyMs: ms,
        ok: true,
      });
    }
    const s = await summary('t1');
    // Sorted by mean latency desc → planner first (1250 vs 300).
    expect(s.map((b) => b.op)).toEqual(['planner_initial', 'executor_turn']);
    const exec = s.find((b) => b.op === 'executor_turn')!;
    expect(exec.count).toBe(5);
    expect(exec.okCount).toBe(4);
    expect(exec.successRate).toBeCloseTo(0.8, 5);
    expect(exec.meanLatencyMs).toBe(300); // (100+200+300+400+500)/5
    // p50 of [100,200,300,400,500] is index 2 → 300.
    expect(exec.p50LatencyMs).toBe(300);
    // p95 of 5 entries → index 4 → 500.
    expect(exec.p95LatencyMs).toBe(500);
  });

  it('isolates summary by taskId', async () => {
    await recordMetric({ taskId: 'a', layer: 'role', op: 'planner', latencyMs: 100, ok: true });
    await recordMetric({ taskId: 'b', layer: 'role', op: 'planner', latencyMs: 99999, ok: true });
    const sA = await summary('a');
    expect(sA).toHaveLength(1);
    expect(sA[0]!.meanLatencyMs).toBe(100);
  });
});

describe('_resetMetrics', () => {
  it('wipes only the targeted task', async () => {
    await recordMetric({ taskId: 'a', layer: 'role', op: 'p', latencyMs: 1, ok: true });
    await recordMetric({ taskId: 'b', layer: 'role', op: 'p', latencyMs: 2, ok: true });
    await _resetMetrics('a');
    expect(await metricsByTask('a')).toHaveLength(0);
    expect(await metricsByTask('b')).toHaveLength(1);
  });

  it('wipes all metrics when called with no taskId', async () => {
    await recordMetric({ taskId: 'a', layer: 'role', op: 'p', latencyMs: 1, ok: true });
    await recordMetric({ taskId: 'b', layer: 'role', op: 'p', latencyMs: 2, ok: true });
    await _resetMetrics();
    expect(await metricsByTask('a')).toHaveLength(0);
    expect(await metricsByTask('b')).toHaveLength(0);
  });
});
