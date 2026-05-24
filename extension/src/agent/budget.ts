// Token accounting for the agent loop.
//
// We use a chars/4 heuristic for *pre-call* budget gating (we have to decide
// whether to call the model before we know its exact tokenization). After
// each Ollama response we reconcile the running total from the actual
// `prompt_eval_count` / `eval_count` the server reports — see budget.recordActual().
//
// This avoids shipping a 1.5 MB tokenizer for a 10% improvement in estimation.

export type Role = 'executor' | 'planner' | 'evaluator' | 'compactor';

export const BUDGETS: Record<Role, number> = {
  executor:  6000,    // hot path; 30–100×/task; must stay GPU-resident
  planner:   32000,   // rare; thinking ON; tolerates higher latency
  evaluator: 8000,    // periodic; thinking ON
  compactor: 8000,    // pure transform; thinking OFF
};

/** Compaction fires when scratchpad reaches this fraction of the Executor budget. */
export const COMPACT_THRESHOLD = 0.8;

/**
 * Compaction also fires when scratchpad has accumulated at least this many
 * raw entries. Catches the realistic case where each entry is small (~30
 * tokens) so the token threshold never trips, but the trace is still long
 * enough that the model would benefit from compaction into structured
 * findings. ~10 entries ≈ 5 tool round-trips.
 */
export const COMPACT_ENTRY_COUNT = 10;

export function approxTokens(s: string | null | undefined): number {
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}

/** Approx tokens for an arbitrary structured payload (serialized as JSON). */
export function approxTokensOf(payload: unknown): number {
  if (payload == null) return 0;
  if (typeof payload === 'string') return approxTokens(payload);
  return approxTokens(JSON.stringify(payload));
}

export function withinRoleBudget(used: number, role: Role): boolean {
  return used <= BUDGETS[role];
}
