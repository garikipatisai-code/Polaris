// Token accounting for the agent loop.
//
// We use a chars/4 heuristic for *pre-call* budget gating (we have to decide
// whether to call the model before we know its exact tokenization). After
// each Ollama response we reconcile the running ratio against the actual
// `prompt_eval_count` / promptChars pair. This is critical for unicode-heavy
// inputs (€, ★, Chinese) where BPE tokens-per-char is much lower than 4 —
// an underestimate would let an oversized prompt slip past the budget guard.
//
// EWMA smoothing (α=0.2) and bounds [1.5, 8] keep the estimate sane.

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

// ----------------------------------------------------------------------------
// Empirical chars-per-token reconciliation
// ----------------------------------------------------------------------------

const RATIO_ALPHA = 0.2;
const RATIO_MIN = 1.5;
const RATIO_MAX = 8;
const RATIO_DEFAULT = 4;

let observedCharsPerToken = RATIO_DEFAULT;
let ratioObservations = 0;

/**
 * Record a (chars, tokens) observation from a real Ollama response. EWMA-
 * smoothed; bounded to [1.5, 8] to refuse pathological inputs (e.g., a
 * prompt that's 95% whitespace would otherwise skew the ratio).
 */
export function recordCharsPerToken(chars: number, tokens: number): void {
  if (chars <= 0 || tokens <= 0) return;
  const observed = chars / tokens;
  if (observed < RATIO_MIN || observed > RATIO_MAX) return;
  observedCharsPerToken =
    ratioObservations === 0
      ? observed
      : observedCharsPerToken * (1 - RATIO_ALPHA) + observed * RATIO_ALPHA;
  ratioObservations++;
}

/** Current empirical chars-per-token estimate. Used by approxTokens. */
export function getCharsPerToken(): number {
  return observedCharsPerToken;
}

/** Test/debug only — reset the running estimate to the default. */
export function _resetCharsPerToken(): void {
  observedCharsPerToken = RATIO_DEFAULT;
  ratioObservations = 0;
}

export function approxTokens(s: string | null | undefined): number {
  if (!s) return 0;
  return Math.ceil(s.length / observedCharsPerToken);
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

/**
 * Maximum chars of failed-output to replay back to the model on retry. The
 * model doesn't need its full broken output to course-correct — a short
 * prefix is enough, and replaying the full thing risks pushing the retry
 * prompt past the role's budget. Defaults to 500 chars (~125 tokens at the
 * default ratio).
 */
export const REPLAY_TRUNCATE_CHARS = 500;

/**
 * Truncate a failed-response string for safe inclusion in a retry's
 * assistant turn. Long outputs get a clear "[truncated]" marker so the
 * model knows it was cut.
 */
export function truncateForReplay(s: string, max = REPLAY_TRUNCATE_CHARS): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…[truncated]';
}
