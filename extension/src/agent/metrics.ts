// Telemetry foundation (#64 — M3.5).
//
// Append-only metric log + a tiny summary API. Backed by the `metrics`
// IDB store added in DB version 2. Tap points: orchestrator role_end
// events (latency + ok), tool dispatch, ollama chatOnce. Writes are
// best-effort: any persistence error is swallowed (we'd rather drop a
// metric than break the agent loop).
//
// The summary view is intentionally minimal — p50 / p95 latency and a
// per-op success rate. Surfaces in the SW DevTools console via
// `polaris.metrics.summary(taskId)`. UI surfacing is M5+ polish.

import { getDB } from './idb';
import type { MetricEntry } from './idb';

export type MetricLayer = MetricEntry['layer'];

export interface RecordMetricInput {
  taskId: string;
  layer: MetricLayer;
  op: string;
  latencyMs: number;
  ok: boolean;
  error?: string;
  meta?: Record<string, unknown>;
}

/**
 * Append a metric to IDB. Best-effort — persistence failures are
 * console.warn-logged but do NOT propagate, so a transient IDB hiccup
 * can't break the agent loop. Callers are encouraged to fire-and-forget
 * via `void recordMetric(...)`.
 */
export async function recordMetric(input: RecordMetricInput): Promise<void> {
  try {
    const db = await getDB();
    // The store has autoIncrement: true on `seq`; the runtime fills it.
    // The TS schema requires `seq` so we cast at the boundary; `seq` is
    // ignored on `put` because the keyPath is autoIncrement.
    await db.put('metrics', {
      ts: Date.now(),
      ...input,
    } as unknown as MetricEntry);
  } catch (e) {
    console.warn('[polaris] recordMetric failed', e);
  }
}

/** Recent metrics for a task, newest-last (chronological). */
export async function metricsByTask(
  taskId: string,
  limit = 500,
): Promise<MetricEntry[]> {
  const db = await getDB();
  const range = IDBKeyRange.bound([taskId, 0], [taskId, Number.MAX_SAFE_INTEGER]);
  const all = await db.getAllFromIndex('metrics', 'by-task-ts', range);
  return all.slice(-limit);
}

/** Per-op metrics for a task — used by `summary` to bucket by `op` cheaply. */
export async function metricsByTaskAndOp(
  taskId: string,
  op: string,
): Promise<MetricEntry[]> {
  const db = await getDB();
  return db.getAllFromIndex('metrics', 'by-task-op', [taskId, op]);
}

export interface OpSummary {
  op: string;
  count: number;
  okCount: number;
  /** Success rate in [0, 1]. */
  successRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  meanLatencyMs: number;
}

/**
 * Compute a per-op summary: count, success rate, p50/p95/mean latency.
 * Used by the SW console (`polaris.metrics.summary(taskId)`) for ad-hoc
 * debugging. p50/p95 use nearest-rank percentile (cheap; sufficient for
 * the small samples we see in a single task).
 */
export async function summary(taskId: string): Promise<OpSummary[]> {
  const all = await metricsByTask(taskId, Number.MAX_SAFE_INTEGER);
  const buckets = new Map<string, MetricEntry[]>();
  for (const m of all) {
    const arr = buckets.get(m.op);
    if (arr) arr.push(m);
    else buckets.set(m.op, [m]);
  }
  const out: OpSummary[] = [];
  for (const [op, entries] of buckets) {
    const okCount = entries.filter((e) => e.ok).length;
    const sorted = [...entries.map((e) => e.latencyMs)].sort((a, b) => a - b);
    const p = (frac: number): number => {
      if (sorted.length === 0) return 0;
      const idx = Math.min(sorted.length - 1, Math.floor(frac * sorted.length));
      return sorted[idx]!;
    };
    const sum = sorted.reduce<number>((acc, n) => acc + n, 0);
    out.push({
      op,
      count: entries.length,
      okCount,
      successRate: entries.length > 0 ? okCount / entries.length : 0,
      p50LatencyMs: p(0.5),
      p95LatencyMs: p(0.95),
      meanLatencyMs: sorted.length > 0 ? Math.round(sum / sorted.length) : 0,
    });
  }
  return out.sort((a, b) => b.meanLatencyMs - a.meanLatencyMs);
}

/** Test/debug only — wipe metrics for a specific task. */
export async function _resetMetrics(taskId?: string): Promise<void> {
  const db = await getDB();
  if (!taskId) {
    await db.clear('metrics');
    return;
  }
  const tx = db.transaction('metrics', 'readwrite');
  let cursor = await tx.store.index('by-task-ts').openCursor(
    IDBKeyRange.bound([taskId, 0], [taskId, Number.MAX_SAFE_INTEGER]),
  );
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}
