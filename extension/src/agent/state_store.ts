// Persistent state CRUD for the Polaris agent.
//
// Single boundary between the agent code and storage. Two responsibilities
// only: read/write hot state in chrome.storage.local, and read/append IDB
// stores. Never invokes the model; never mutates state outside the public
// methods.
//
// Goal immutability is enforced structurally:
//   - startTask() refuses if a task is in a non-terminal phase
//   - patchHot() rejects any patch that touches `goal`
//   - There is no `setGoal()` exported method
//
// Atomicity: append* methods coordinate IDB write + scratchpadRef counter
// in chrome.storage.local. This is two writes — a SW crash between them can
// leave the counter stale. M2.5's compactor uses a single IDB transaction
// across stores; for M2.1 we accept the small drift window.

import { getDB } from './idb';
import { ulid } from './ulid';
import { approxTokens, approxTokensOf, BUDGETS } from './budget';
import type {
  AgentStateHot,
  Phase,
  ScratchEntry,
  ScratchKind,
  Finding,
  FindingKind,
  FindingSource,
  MemoryCell,
  AgentEvent,
  AgentEventType,
} from '../shared/agent_types';

const HOT_KEY = 'polaris.agent.hot';
const SCHEMA_VERSION = 1;

const TERMINAL_PHASES = new Set<Phase>(['IDLE', 'DONE', 'ABORTED']);

/** A task in a non-terminal phase with no lastTouch update in this long is presumed crashed. */
const STALE_TASK_MS = 60_000;

// ============================================================================
// Hot state (chrome.storage.local)
// ============================================================================

export async function loadHot(): Promise<AgentStateHot | null> {
  const out = await chrome.storage.local.get(HOT_KEY);
  return (out[HOT_KEY] as AgentStateHot | undefined) ?? null;
}

export async function setHot(state: AgentStateHot): Promise<void> {
  await chrome.storage.local.set({ [HOT_KEY]: state });
}

type Patchable = Omit<AgentStateHot, 'goal' | 'taskId' | 'schemaVersion' | 'createdAt'>;

export async function patchHot(patch: Partial<Patchable>): Promise<AgentStateHot> {
  if ('goal' in patch) {
    throw new Error('cannot patch immutable field: goal');
  }
  if ('taskId' in patch || 'schemaVersion' in patch || 'createdAt' in patch) {
    throw new Error('cannot patch immutable field in patch');
  }
  const current = await loadHot();
  if (!current) throw new Error('no hot state to patch');
  const next: AgentStateHot = { ...current, ...patch, lastTouch: Date.now() };
  await setHot(next);
  return next;
}

export async function bumpLastTouch(): Promise<void> {
  const current = await loadHot();
  if (!current) return;
  current.lastTouch = Date.now();
  await setHot(current);
}

/**
 * Begin a new task with a verbatim, immutable goal.
 *
 * If an existing task is in a non-terminal phase:
 *   - if its lastTouch is older than STALE_TASK_MS, treat it as a crashed
 *     task (SW died mid-flight, reload, etc.), mark it ABORTED, and proceed
 *   - otherwise throw — there's a genuinely active task we shouldn't preempt
 *
 * The full crash-resume design (continue from persisted phase) lands in M2.6.
 * For now this just unblocks the user.
 */
export async function startTask(goalText: string): Promise<AgentStateHot> {
  const trimmed = goalText.trim();
  if (!trimmed) throw new Error('goal text must be non-empty');
  const current = await loadHot();
  if (current && !TERMINAL_PHASES.has(current.phase)) {
    const age = Date.now() - (current.lastTouch || current.createdAt);
    if (age > STALE_TASK_MS) {
      // Crashed — abort the zombie and proceed.
      const aborted: AgentStateHot = {
        ...current,
        phase: 'ABORTED',
        resumedAt: Date.now(),
        lastTouch: Date.now(),
      };
      await setHot(aborted);
      console.warn(
        `[polaris] auto-aborted stale task ${current.taskId} ` +
        `(was ${current.phase}, no activity for ${Math.round(age / 1000)}s)`,
      );
    } else {
      throw new Error(
        `cannot start task: existing task ${current.taskId} is in phase ${current.phase} ` +
        `(last activity ${Math.round(age / 1000)}s ago — use polaris.state.clearHot() to force)`,
      );
    }
  }
  const taskId = ulid();
  const now = Date.now();
  const initial: AgentStateHot = {
    schemaVersion: SCHEMA_VERSION,
    taskId,
    phase: 'PLANNING',
    goal: { text: trimmed, successCriteria: [], createdAt: now },
    plan: { rootSteps: [], revision: 0, generatedAt: now },
    budgets: {
      executor:  { used: 0, max: BUDGETS.executor },
      planner:   { used: 0, max: BUDGETS.planner },
      evaluator: { used: 0, max: BUDGETS.evaluator },
      totalTokens: 0,
    },
    visited: { hashes: [] },
    breaker: { repeats: {}, recentErrors: 0, stepsWithoutProgress: 0, trips: [] },
    scratchpadRef: { count: 0, tokens: 0 },
    currentStepId: null,
    lastTouch: now,
    resumedAt: null,
    createdAt: now,
  };
  await setHot(initial);
  return initial;
}

/** Force-clear hot state. Use only for debug/reset; loses goal. */
export async function clearHot(): Promise<void> {
  await chrome.storage.local.remove(HOT_KEY);
}

// ============================================================================
// Scratchpad (IDB, per-task FIFO)
// ============================================================================

export async function appendScratch(
  taskId: string,
  kind: ScratchKind,
  payload: unknown,
  tokensOverride?: number,
): Promise<number> {
  const db = await getDB();
  const seq = await nextSeq(db, 'scratchpad', taskId);
  const entry: ScratchEntry = {
    taskId,
    seq,
    ts: Date.now(),
    kind,
    payload,
    tokens: tokensOverride ?? approxTokensOf(payload),
  };
  await db.put('scratchpad', entry);
  // Update scratchpadRef metadata in hot state if it's the active task.
  const hot = await loadHot();
  if (hot && hot.taskId === taskId) {
    hot.scratchpadRef.count++;
    hot.scratchpadRef.tokens += entry.tokens;
    hot.lastTouch = Date.now();
    await setHot(hot);
  }
  return seq;
}

/** Read the last N scratch entries for a task, chronological order. */
export async function readScratchTail(taskId: string, n: number): Promise<ScratchEntry[]> {
  const db = await getDB();
  const range = IDBKeyRange.bound([taskId, 0], [taskId, Number.MAX_SAFE_INTEGER]);
  const out: ScratchEntry[] = [];
  let cursor = await db.transaction('scratchpad').store.openCursor(range, 'prev');
  while (cursor && out.length < n) {
    out.push(cursor.value);
    cursor = await cursor.continue();
  }
  return out.reverse();
}

/** Read ALL scratch entries for a task, chronological order. Used by Compactor. */
export async function readScratchAll(taskId: string): Promise<ScratchEntry[]> {
  const db = await getDB();
  const range = IDBKeyRange.bound([taskId, 0], [taskId, Number.MAX_SAFE_INTEGER]);
  return db.getAll('scratchpad', range);
}

/** Delete scratch entries by seq. Compactor uses this after archiving to findings. */
export async function deleteScratchSeqs(taskId: string, seqs: number[]): Promise<void> {
  if (seqs.length === 0) return;
  const db = await getDB();
  const tx = db.transaction('scratchpad', 'readwrite');
  let deletedTokens = 0;
  for (const seq of seqs) {
    const existing = await tx.store.get([taskId, seq]);
    if (existing) {
      deletedTokens += existing.tokens;
      await tx.store.delete([taskId, seq]);
    }
  }
  await tx.done;
  // Update scratchpadRef
  const hot = await loadHot();
  if (hot && hot.taskId === taskId) {
    hot.scratchpadRef.count = Math.max(0, hot.scratchpadRef.count - seqs.length);
    hot.scratchpadRef.tokens = Math.max(0, hot.scratchpadRef.tokens - deletedTokens);
    hot.lastTouch = Date.now();
    await setHot(hot);
  }
}

// ============================================================================
// Findings (IDB, structured atomic facts)
// ============================================================================

export interface AppendFindingInput {
  taskId: string;
  source: FindingSource;
  stepId: string | null;
  kind: FindingKind;
  key: string;
  value: string;
  evidence?: string;
}

export async function appendFinding(input: AppendFindingInput): Promise<Finding> {
  const finding: Finding = {
    id: ulid(),
    ts: Date.now(),
    embedding: null,
    ...input,
  };
  const db = await getDB();
  await db.put('findings', finding);
  return finding;
}

/** Most-recent findings for a task, newest first. */
export async function findingsByRecency(taskId: string, limit: number): Promise<Finding[]> {
  const db = await getDB();
  const range = IDBKeyRange.bound([taskId, 0], [taskId, Number.MAX_SAFE_INTEGER]);
  const out: Finding[] = [];
  let cursor = await db
    .transaction('findings')
    .store.index('by-task-ts')
    .openCursor(range, 'prev');
  while (cursor && out.length < limit) {
    out.push(cursor.value);
    cursor = await cursor.continue();
  }
  return out;
}

/** Look up a finding by exact key. Returns the most recent match. */
export async function findingByKey(taskId: string, key: string): Promise<Finding | null> {
  const db = await getDB();
  const matches = await db.getAllFromIndex('findings', 'by-task-key', [taskId, key]);
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.ts - a.ts);
  return matches[0] ?? null;
}

export async function existingFindingKeys(taskId: string): Promise<string[]> {
  const db = await getDB();
  const range = IDBKeyRange.bound([taskId, ''], [taskId, '￿']);
  const out = new Set<string>();
  let cursor = await db
    .transaction('findings')
    .store.index('by-task-key')
    .openCursor(range);
  while (cursor) {
    out.add(cursor.value.key);
    cursor = await cursor.continue();
  }
  return [...out];
}

// ============================================================================
// Memory (IDB, agent-controlled key-value cells)
// ============================================================================

export async function memoryWrite(
  taskId: string,
  namespace: string,
  key: string,
  value: string,
): Promise<void> {
  if (value.length > 4000) throw new Error('memory value exceeds 4000 chars');
  const cell: MemoryCell = { taskId, namespace, key, value, updatedAt: Date.now() };
  const db = await getDB();
  await db.put('memory', cell);
}

export async function memoryRead(
  taskId: string,
  namespace: string,
  key: string,
): Promise<MemoryCell | null> {
  const db = await getDB();
  return (await db.get('memory', [taskId, namespace, key])) ?? null;
}

export async function memoryList(
  taskId: string,
  namespace: string,
  opts: { prefix?: string; limit?: number } = {},
): Promise<MemoryCell[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex('memory', 'by-task-ns', [taskId, namespace]);
  let filtered = all;
  if (opts.prefix) {
    filtered = filtered.filter((c) => c.key.startsWith(opts.prefix!));
  }
  const limit = Math.min(opts.limit ?? 50, 200);
  return filtered.slice(0, limit);
}

// ============================================================================
// Events (IDB, audit log)
// ============================================================================

export async function appendEvent(
  taskId: string,
  type: AgentEventType,
  data: unknown,
): Promise<number> {
  const db = await getDB();
  const seq = await nextSeq(db, 'events', taskId);
  const event: AgentEvent = { taskId, seq, ts: Date.now(), type, data };
  await db.put('events', event);
  return seq;
}

export async function eventsSince(taskId: string, fromSeq = 0): Promise<AgentEvent[]> {
  const db = await getDB();
  const range = IDBKeyRange.bound([taskId, fromSeq], [taskId, Number.MAX_SAFE_INTEGER]);
  return db.getAll('events', range);
}

// ============================================================================
// Full task wipe (debug / completed task cleanup)
// ============================================================================

export async function resetTask(taskId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['scratchpad', 'findings', 'memory', 'events'], 'readwrite');
  await Promise.all([
    deleteAllByTask(tx.objectStore('scratchpad').index('by-task'), taskId),
    deleteAllByRange(
      tx.objectStore('findings').index('by-task-ts'),
      IDBKeyRange.bound([taskId, 0], [taskId, Number.MAX_SAFE_INTEGER]),
    ),
    deleteAllByRange(
      tx.objectStore('memory').index('by-task-ns'),
      IDBKeyRange.bound([taskId, ''], [taskId, '￿']),
    ),
    deleteAllByTask(tx.objectStore('events').index('by-task'), taskId),
  ]);
  await tx.done;
  const hot = await loadHot();
  if (hot && hot.taskId === taskId) {
    await clearHot();
  }
}

// ============================================================================
// Helpers
// ============================================================================

async function nextSeq(
  db: Awaited<ReturnType<typeof getDB>>,
  store: 'scratchpad' | 'events',
  taskId: string,
): Promise<number> {
  const range = IDBKeyRange.bound([taskId, 0], [taskId, Number.MAX_SAFE_INTEGER]);
  const cursor = await db.transaction(store).store.openCursor(range, 'prev');
  return cursor ? (cursor.value as { seq: number }).seq + 1 : 1;
}

async function deleteAllByTask(index: any, taskId: string): Promise<void> {
  let cursor = await index.openCursor(IDBKeyRange.only(taskId));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
}

async function deleteAllByRange(index: any, range: IDBKeyRange): Promise<void> {
  let cursor = await index.openCursor(range);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
}

// Re-export approxTokens for convenience.
export { approxTokens };
