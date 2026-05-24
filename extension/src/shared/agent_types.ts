// Persistent agent state schema for Polaris.
//
// Storage split:
//   - `chrome.storage.local` holds the small, frequently-read "hot" state
//     (AgentStateHot). Target: < 50 KB so deserialization is sub-ms.
//   - IndexedDB holds larger append-mostly stores (scratchpad, findings,
//     memory cells, events). See `agent/idb.ts` for the DB schema.
//
// Goal immutability is enforced structurally by StateStore.startTask() —
// it refuses to start a new task while one is in a non-terminal phase, and
// `patchHot()` explicitly forbids the `goal` field.

export type Phase =
  | 'IDLE'
  | 'PLANNING'
  | 'EXECUTING'
  | 'COMPACTING'
  | 'EVALUATING'
  | 'BREAKER'
  | 'DONE'
  | 'ABORTED';

// ============================================================================
// Hot state (chrome.storage.local)
// ============================================================================

export interface AgentStateHot {
  readonly schemaVersion: 1;
  readonly taskId: string;
  phase: Phase;
  readonly goal: GoalRecord;        // immutable wrt patches
  plan: Plan;
  budgets: BudgetState;
  visited: VisitedSet;
  breaker: BreakerState;
  scratchpadRef: ScratchpadRef;
  currentStepId: string | null;
  /** Set by Executor when it calls `finish`; consumed by Evaluator. */
  pendingFinishSummary: string | null;
  /** Set by Evaluator when verdict='replan'; consumed by next Planner call. */
  replanHint: string | null;
  /** Set by Evaluator on verdict='done' (or fallback to pendingFinishSummary). */
  finalAnswer: string | null;
  lastTouch: number;                // epoch ms; watchdog bumps
  resumedAt: number | null;         // set on crash-resume detection
  readonly createdAt: number;
}

export interface GoalRecord {
  readonly text: string;            // verbatim user goal
  successCriteria: string[];        // populated by Planner on first run
  readonly createdAt: number;
}

export interface Plan {
  rootSteps: PlanStep[];
  revision: number;                 // bumped on each Planner write
  generatedAt: number;
  notes?: string;                   // Planner's "what changed and why"
}

export type StepStatus = 'pending' | 'active' | 'done' | 'skipped' | 'failed';

export interface PlanStep {
  id: string;                       // stable id; e.g. "s1", "s1.1"
  title: string;                    // ≤ ~12 words human-readable
  rationale?: string;               // optional, ≤ ~30 words
  status: StepStatus;
  children?: PlanStep[];
  resultRef?: string;               // Finding id pointing at result
}

export interface RoleBudget {
  used: number;
  readonly max: number;
}

export interface BudgetState {
  executor: RoleBudget;
  planner: RoleBudget;
  evaluator: RoleBudget;
  totalTokens: number;
}

export interface VisitedSet {
  // Hash of (toolName + canonicalArgs). Capped at 256 entries (LRU evict).
  hashes: string[];
}

export interface BreakerState {
  /** action hash → consecutive count (only most-recent action retained) */
  repeats: Record<string, number>;
  /** sliding window of last 5 step outcomes */
  recentOutcomes: ('ok' | 'error')[];
  /** ticks where FINDINGS didn't grow */
  stepsWithoutProgress: number;
  /** Findings count seen at the previous check; used to detect growth. */
  lastFindingsCount: number;
  /** last 5 trips for telemetry */
  trips: { at: number; reason: string; level?: 'nudge' | 'replan' | 'abort' }[];
}

export interface ScratchpadRef {
  count: number;
  tokens: number;
}

// ============================================================================
// IndexedDB stores
// ============================================================================

export type ScratchKind = 'tool_call' | 'tool_result' | 'role_msg' | 'thinking';

export interface ScratchEntry {
  taskId: string;
  seq: number;                      // monotone; primary key [taskId, seq]
  ts: number;
  kind: ScratchKind;
  /** Shape depends on kind. Validated at consumption time. */
  payload: unknown;
  tokens: number;                   // approximate
}

export type FindingKind = 'fact' | 'observation' | 'reflection' | 'sub-answer';
export type FindingSource = 'planner' | 'executor' | 'evaluator' | 'compactor' | 'tool';

export interface Finding {
  taskId: string;
  id: string;                       // ULID
  ts: number;
  source: FindingSource;
  stepId: string | null;
  kind: FindingKind;
  /** ≤ 80 chars, snake_case symbolic label */
  key: string;
  /** ≤ 300 chars, dense factual text */
  value: string;
  /** optional pointer (url, "seq:N", etc.) */
  evidence?: string;
  /** 1024-d (mxbai-embed-large), lazily computed */
  embedding?: number[] | null;
}

export interface MemoryCell {
  taskId: string;
  namespace: string;
  key: string;
  value: string;                    // ≤ 4000 chars
  updatedAt: number;
}

export type AgentEventType =
  | 'phase'
  | 'tool_call'
  | 'tool_result'
  | 'role_start'
  | 'role_end'
  | 'breaker'
  | 'compaction'
  | 'verdict'
  | 'error';

export interface AgentEvent {
  taskId: string;
  seq: number;                      // monotone; primary key [taskId, seq]
  ts: number;
  type: AgentEventType;
  data: unknown;
}
