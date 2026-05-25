// IndexedDB schema and connection for Polaris agent state.
//
// Schema versions:
//   1 — initial: scratchpad, findings, memory, events
//   2 — adds `metrics` (M3.5 telemetry foundation)
//
// Stores:
//   scratchpad  — FIFO ring per task; primary key [taskId, seq]
//   findings    — structured atomic facts; primary key id (ULID)
//   memory      — agent-controlled namespaced cells; key [taskId, namespace, key]
//   events      — audit log for UI replay; primary key [taskId, seq]
//   metrics     — per-op latency / outcome telemetry; primary key auto-inc

import { openDB } from 'idb';
import type { IDBPDatabase, DBSchema } from 'idb';
import type {
  ScratchEntry,
  Finding,
  MemoryCell,
  AgentEvent,
} from '../shared/agent_types';

const DB_NAME = 'polaris';
const DB_VERSION = 2;

/**
 * Telemetry record for one observable operation. Cheap and append-only.
 * Read by the debug console (`polaris.metrics.summary(taskId)`) to expose
 * p50/p95 latencies and success rates without a third-party telemetry stack.
 */
export interface MetricEntry {
  /** Auto-incremented primary key. */
  seq: number;
  taskId: string;
  ts: number;
  /** Layer that produced the metric: 'role', 'tool', 'ollama', etc. */
  layer: 'role' | 'tool' | 'ollama' | 'breaker' | 'compactor';
  /** Operation name: 'planner_turn', 'executor_turn', 'tool:echo', etc. */
  op: string;
  latencyMs: number;
  ok: boolean;
  error?: string;
  /** Free-form structured payload — kept small. */
  meta?: Record<string, unknown>;
}

export interface PolarisDB extends DBSchema {
  scratchpad: {
    key: [string, number];
    value: ScratchEntry;
    indexes: { 'by-task': string };
  };
  findings: {
    key: string;
    value: Finding;
    indexes: {
      'by-task-ts': [string, number];
      'by-task-key': [string, string];
    };
  };
  memory: {
    key: [string, string, string];
    value: MemoryCell;
    indexes: { 'by-task-ns': [string, string] };
  };
  events: {
    key: [string, number];
    value: AgentEvent;
    indexes: { 'by-task': string };
  };
  metrics: {
    key: number;
    value: MetricEntry;
    indexes: {
      'by-task-ts': [string, number];
      'by-task-op': [string, string];
    };
  };
}

let dbPromise: Promise<IDBPDatabase<PolarisDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<PolarisDB>> {
  if (!dbPromise) {
    dbPromise = openDB<PolarisDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        // v1 stores — idempotent creation.
        if (!db.objectStoreNames.contains('scratchpad')) {
          const s = db.createObjectStore('scratchpad', { keyPath: ['taskId', 'seq'] });
          s.createIndex('by-task', 'taskId');
        }
        if (!db.objectStoreNames.contains('findings')) {
          const f = db.createObjectStore('findings', { keyPath: 'id' });
          f.createIndex('by-task-ts', ['taskId', 'ts']);
          f.createIndex('by-task-key', ['taskId', 'key']);
        }
        if (!db.objectStoreNames.contains('memory')) {
          db.createObjectStore('memory', { keyPath: ['taskId', 'namespace', 'key'] })
            .createIndex('by-task-ns', ['taskId', 'namespace']);
        }
        if (!db.objectStoreNames.contains('events')) {
          db.createObjectStore('events', { keyPath: ['taskId', 'seq'] })
            .createIndex('by-task', 'taskId');
        }
        // v2 — metrics store. `oldVersion < 2` covers both fresh installs
        // (oldVersion=0) and existing v1 users upgrading.
        if (oldVersion < 2 && !db.objectStoreNames.contains('metrics')) {
          const m = db.createObjectStore('metrics', { keyPath: 'seq', autoIncrement: true });
          m.createIndex('by-task-ts', ['taskId', 'ts']);
          m.createIndex('by-task-op', ['taskId', 'op']);
        }
      },
    });
  }
  return dbPromise;
}

/** Wipe the entire database. Test / reset utility only. */
export async function dropDB(): Promise<void> {
  if (dbPromise) {
    (await dbPromise).close();
    dbPromise = null;
  }
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve(); // best effort
  });
}
