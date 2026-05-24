// Orchestrator — the agent loop driver.
//
// Single point that owns the state-machine transitions. Reads/writes
// persistent state via state_store, invokes role functions, dispatches
// tools, emits events for the UI.
//
// M2.5 scope:
//   - Real Planner role (initial + replan)
//   - Executor loop with mock tools
//   - Compactor fires before each Executor turn when scratchpad ≥ 80%
//     of executor budget
//   - Evaluator runs after every EVAL_EVERY_N_STEPS turns AND on finish
//   - Verdict routes: done → DONE, continue → EXECUTING,
//     replan → PLANNING (with hint), abort → ABORTED
//
// Still missing (lands later):
//   - Circuit breaker (action repetition / stuck-loop detection) → M2.6
//   - chrome.alarms watchdog + crash-resume → M2.6
//   - Synthetic stress test + UI polish → M2.7

import type { OllamaClient } from '../background/ollama';
import { ToolRegistry, createDefaultRegistry } from './tools';
import { runExecutor } from './roles/executor';
import { runPlanner } from './roles/planner';
import { runEvaluator } from './roles/evaluator';
import { runCompactor } from './roles/compactor';
import * as store from './state_store';
import * as breaker from './circuit_breaker';
import { log } from './log';
import type {
  AgentStateHot,
  AgentEventType,
} from '../shared/agent_types';
import { BUDGETS, COMPACT_THRESHOLD } from './budget';
import { SPECIAL_TOOLS } from './tools';

/** Evaluate every N successful Executor turns (in addition to on-finish). */
const EVAL_EVERY_N_STEPS = 5;

export interface OrchestratorEvent {
  type: AgentEventType;
  data?: unknown;
}

export interface OrchestratorOptions {
  client: OllamaClient;
  model: string;
  registry?: ToolRegistry;
  /** Called for every meaningful agent event; mirrored into IDB events store. */
  onEvent?: (event: OrchestratorEvent) => void;
  /** Hard cap on Executor turns per run (safety net before circuit breaker lands). */
  maxSteps?: number;
  /** Use thinking mode for the Planner role. Default true. */
  plannerThinking?: boolean;
  /** Use thinking mode for the Evaluator role. Default true. */
  evaluatorThinking?: boolean;
}

export class Orchestrator {
  private readonly client: OllamaClient;
  private readonly model: string;
  private readonly registry: ToolRegistry;
  private readonly onEvent: (event: OrchestratorEvent) => void;
  private readonly maxSteps: number;
  private readonly plannerThinking: boolean;
  private readonly evaluatorThinking: boolean;
  private abort: AbortController | null = null;
  private stepsSinceEval = 0;

  constructor(opts: OrchestratorOptions) {
    this.client = opts.client;
    this.model = opts.model;
    this.registry = opts.registry ?? createDefaultRegistry();
    this.onEvent = opts.onEvent ?? (() => {});
    this.maxSteps = opts.maxSteps ?? 30;
    this.plannerThinking = opts.plannerThinking ?? true;
    this.evaluatorThinking = opts.evaluatorThinking ?? true;
  }

  /**
   * Begin a new task. PLANNING → (Planner) → EXECUTING.
   */
  async start(goalText: string): Promise<AgentStateHot> {
    this.abort = new AbortController();
    this.stepsSinceEval = 0;
    const fresh = await store.startTask(goalText);
    await this.emit(fresh.taskId, 'phase', { phase: 'PLANNING' });
    return await this.runPlannerStep(fresh, /*isInitial=*/ true, /*replanHint=*/ undefined);
  }

  /**
   * Resume an incomplete task from persistent state. The task must be in
   * a non-terminal phase. Used by SW restart / browser restart / panel
   * reconnect — the orchestrator instance is fresh but state is recovered
   * from chrome.storage.local + IndexedDB.
   */
  async resume(): Promise<AgentStateHot> {
    this.abort = new AbortController();
    this.stepsSinceEval = 0;
    const state = await store.loadHot();
    if (!state) throw new Error('resume: no task in storage');
    if (state.phase === 'IDLE' || state.phase === 'DONE' || state.phase === 'ABORTED') {
      throw new Error(`resume: task already terminal (phase=${state.phase})`);
    }
    const resumed = await store.patchHot({ resumedAt: Date.now() });
    await this.emit(resumed.taskId, 'phase', {
      phase: resumed.phase,
      resumed: true,
      reason: 'service-worker / browser restart — resuming from persisted state',
    });
    return resumed;
  }

  /** Run the loop until a terminal phase (DONE / ABORTED). */
  async runUntilTerminal(): Promise<AgentStateHot> {
    let state = await store.loadHot();
    if (!state) throw new Error('runUntilTerminal: no active task');
    let stepCount = 0;

    while (stepCount < this.maxSteps) {
      if (this.abort?.signal.aborted) {
        return await this.finalizeAborted('user_abort');
      }
      state = (await store.loadHot())!;
      if (state.phase === 'DONE' || state.phase === 'ABORTED') break;

      // Pre-flight: compactor runs when scratchpad pressure is high.
      if (
        state.phase === 'EXECUTING' &&
        state.scratchpadRef.tokens >= COMPACT_THRESHOLD * BUDGETS.executor
      ) {
        state = await this.runCompaction(state);
        continue;
      }

      if (state.phase === 'EXECUTING') {
        stepCount++;
        this.stepsSinceEval++;
        state = await this.executeOneStep(state);

        // Periodic Evaluator (separate from on-finish — that path sets EVALUATING directly).
        if (state.phase === 'EXECUTING' && this.stepsSinceEval >= EVAL_EVERY_N_STEPS) {
          state = await store.patchHot({ phase: 'EVALUATING' });
          this.stepsSinceEval = 0;
        }
        continue;
      }

      if (state.phase === 'EVALUATING') {
        state = await this.runEvaluation(state);
        continue;
      }

      if (state.phase === 'PLANNING') {
        // Replan path. The Evaluator put us here; pull the hint from state.
        state = await this.runPlannerStep(state, /*isInitial=*/ false, state.replanHint ?? undefined);
        continue;
      }

      // COMPACTING / BREAKER shouldn't be reached at top of loop — pre-flight handles them.
      // If we ever land here, just nudge back to EXECUTING.
      console.warn('[polaris] unexpected phase at loop top:', state.phase);
      state = await store.patchHot({ phase: 'EXECUTING' });
    }

    if (state.phase !== 'DONE' && state.phase !== 'ABORTED') {
      return await this.finalizeAborted(`max steps (${this.maxSteps}) reached`);
    }
    return state;
  }

  /** Abort the in-flight task. */
  async stop(): Promise<void> {
    this.abort?.abort();
    const state = await store.loadHot();
    if (state && state.phase !== 'DONE' && state.phase !== 'ABORTED') {
      await this.finalizeAborted('user_abort');
    }
  }

  // -----------------------------------------------------------------------
  // phase handlers
  // -----------------------------------------------------------------------

  private async runPlannerStep(
    state: AgentStateHot,
    isInitial: boolean,
    replanHint: string | undefined,
  ): Promise<AgentStateHot> {
    log('info', 'planner', isInitial ? 'initial planning' : 'replan', {
      taskId: state.taskId,
      replanHint,
      planRevision: state.plan.revision,
      totalReplans: state.breaker.totalReplans,
    });

    // On replan, reset short-window breaker counters so the new plan starts
    // with a clean slate; bump the replan counter for max-replan tracking.
    let prepared = state;
    if (!isInitial) {
      const resetBreaker = breaker.resetForReplan(state.breaker);
      // If max replans now reached, abort instead of planning again.
      if (resetBreaker.totalReplans > breaker.MAX_TOTAL_REPLANS) {
        const aborted = await store.patchHot({ phase: 'ABORTED', breaker: resetBreaker });
        await this.emit(aborted.taskId, 'breaker', {
          action: 'abort',
          reason: `exceeded ${breaker.MAX_TOTAL_REPLANS} replans — task appears unsolvable with available tools`,
        });
        await this.emit(aborted.taskId, 'error', {
          error: `gave up after ${resetBreaker.totalReplans} replans`,
        });
        return aborted;
      }
      prepared = await store.patchHot({ breaker: resetBreaker });
    }

    await this.emit(prepared.taskId, 'role_start', { role: 'planner', isInitial, replanHint });
    const result = await runPlanner({
      state: prepared,
      registry: this.registry,
      client: this.client,
      model: this.model,
      signal: this.abort?.signal,
      isInitial,
      replanHint,
      thinkingMode: this.plannerThinking,
    });

    if (!result.ok || !result.plan) {
      const aborted = await store.patchHot({ phase: 'ABORTED' });
      await this.emit(aborted.taskId, 'role_end', {
        role: 'planner',
        ok: false,
        error: result.error,
        promptTokens: result.promptTokens,
        genTokens: result.genTokens,
        retried: result.retried,
      });
      await this.emit(aborted.taskId, 'error', { error: `planner failed: ${result.error ?? 'unknown'}` });
      return aborted;
    }

    let after = prepared;
    if (isInitial && result.successCriteria && result.successCriteria.length > 0) {
      after = await store.appendSuccessCriteria(result.successCriteria);
    }

    const planned = await store.patchHot({
      plan: result.plan,
      currentStepId: result.plan.rootSteps[0]?.id ?? null,
      phase: 'EXECUTING',
      replanHint: null,        // consumed
      budgets: {
        ...after.budgets,
        planner: {
          ...after.budgets.planner,
          used: after.budgets.planner.used + result.promptTokens,
        },
        totalTokens: after.budgets.totalTokens + result.promptTokens + result.genTokens,
      },
    });
    await this.emit(planned.taskId, 'role_end', {
      role: 'planner',
      ok: true,
      plan: result.plan,
      successCriteria: planned.goal.successCriteria,
      promptTokens: result.promptTokens,
      genTokens: result.genTokens,
      retried: result.retried,
    });
    await this.emit(planned.taskId, 'phase', { phase: 'EXECUTING' });
    return planned;
  }

  private async executeOneStep(state: AgentStateHot): Promise<AgentStateHot> {
    const step = state.plan.rootSteps.find((s) => s.id === state.currentStepId) ?? null;
    await this.emit(state.taskId, 'role_start', { role: 'executor', stepId: step?.id });

    const result = await runExecutor({
      state,
      registry: this.registry,
      client: this.client,
      model: this.model,
      signal: this.abort?.signal,
    });

    if (result.toolCall) {
      await store.appendScratch(state.taskId, 'tool_call', result.toolCall);
      await this.emit(state.taskId, 'tool_call', {
        name: result.toolCall.function.name,
        args: result.toolCall.function.arguments,
      });
    }
    if (result.toolResult) {
      await store.appendScratch(state.taskId, 'tool_result', result.toolResult);
      await this.emit(state.taskId, 'tool_result', {
        name: result.toolCall?.function.name,
        ok: result.toolResult.ok,
        data: result.toolResult.data,
        error: result.toolResult.error,
      });
    }

    let next = await store.patchHot({
      budgets: {
        ...state.budgets,
        executor: {
          ...state.budgets.executor,
          used: state.budgets.executor.used + result.promptTokens,
        },
        totalTokens: state.budgets.totalTokens + result.promptTokens + result.genTokens,
      },
    });
    await this.emit(next.taskId, 'role_end', {
      role: 'executor',
      ok: result.ok,
      retried: result.retried,
      promptTokens: result.promptTokens,
      genTokens: result.genTokens,
    });

    // Circuit breaker: update counters, check trip signatures.
    if (result.toolCall && result.toolResult) {
      const planned = {
        name: result.toolCall.function.name,
        args: result.toolCall.function.arguments,
      };
      const findingsCount = await store.countFindings(state.taskId);
      const update = breaker.recordAfter(
        next,
        planned,
        { ok: result.toolResult.ok, fatal: result.toolResult.fatal },
        findingsCount,
      );
      next = await store.patchHot({ breaker: update.breaker });

      // Fatal-error abort takes precedence.
      if (update.abortReason) {
        const aborted = await store.patchHot({
          phase: 'ABORTED',
          breaker: breaker.recordTrip(next, update.abortReason, 'abort'),
        });
        await this.emit(aborted.taskId, 'breaker', {
          action: 'abort',
          reason: update.abortReason,
        });
        await this.emit(aborted.taskId, 'error', { error: update.abortReason });
        return aborted;
      }

      // Behavioural trips (repetition, no-progress).
      const decision = breaker.evaluate(next, planned);
      if (decision.kind === 'replan') {
        next = await store.patchHot({
          phase: 'PLANNING',
          replanHint: `circuit breaker: ${decision.reason}`,
          breaker: breaker.recordTrip(next, decision.reason, 'replan'),
        });
        await this.emit(next.taskId, 'breaker', {
          action: 'replan',
          reason: decision.reason,
        });
        return next;
      }
      if (decision.kind === 'abort') {
        const aborted = await store.patchHot({
          phase: 'ABORTED',
          breaker: breaker.recordTrip(next, decision.reason, 'abort'),
        });
        await this.emit(aborted.taskId, 'breaker', {
          action: 'abort',
          reason: decision.reason,
        });
        return aborted;
      }
    }

    if (result.finished) {
      // Executor proposed a final answer. Route to EVALUATING; Evaluator
      // decides whether to accept it or send back for replan.
      next = await store.patchHot({
        phase: 'EVALUATING',
        pendingFinishSummary: result.finishSummary ?? null,
      });
      await this.emit(next.taskId, 'phase', {
        phase: 'EVALUATING',
        trigger: SPECIAL_TOOLS.FINISH,
      });
      return next;
    }

    if (!result.ok) {
      // M2.5: still bail on first hard tool error (no breaker yet — M2.6).
      const aborted = await store.patchHot({ phase: 'ABORTED' });
      await this.emit(aborted.taskId, 'error', { error: result.error ?? 'unknown executor error' });
      return aborted;
    }

    return next;
  }

  private async runEvaluation(state: AgentStateHot): Promise<AgentStateHot> {
    const triggeredByFinish = state.pendingFinishSummary !== null;
    await this.emit(state.taskId, 'role_start', {
      role: 'evaluator',
      trigger: triggeredByFinish ? 'finish' : 'periodic',
    });
    const result = await runEvaluator({
      state,
      client: this.client,
      model: this.model,
      signal: this.abort?.signal,
      thinkingMode: this.evaluatorThinking,
      triggeredByFinish,
    });

    // Always update budget regardless of outcome.
    const afterBudget = await store.patchHot({
      budgets: {
        ...state.budgets,
        evaluator: {
          ...state.budgets.evaluator,
          used: state.budgets.evaluator.used + result.promptTokens,
        },
        totalTokens:
          state.budgets.totalTokens + result.promptTokens + result.genTokens,
      },
    });

    if (!result.ok) {
      await this.emit(afterBudget.taskId, 'role_end', {
        role: 'evaluator',
        ok: false,
        error: result.error,
        promptTokens: result.promptTokens,
        genTokens: result.genTokens,
        retried: result.retried,
      });
      // Conservative fallback: pretend the Evaluator said "continue" — let
      // the Executor keep going. If we hit max steps the loop will abort.
      this.stepsSinceEval = 0;
      return await store.patchHot({
        phase: 'EXECUTING',
        pendingFinishSummary: null,
      });
    }

    await this.emit(afterBudget.taskId, 'role_end', {
      role: 'evaluator',
      ok: true,
      verdict: result.verdict,
      promptTokens: result.promptTokens,
      genTokens: result.genTokens,
      retried: result.retried,
    });
    await this.emit(afterBudget.taskId, 'verdict', {
      verdict: result.verdict,
      reason: result.reason,
      finalAnswer: result.finalAnswer,
      replanHint: result.replanHint,
    });

    switch (result.verdict) {
      case 'done': {
        // Defensive: a "done" verdict MUST come with a real final answer.
        // The Evaluator occasionally returns done with finalAnswer:"" — that's
        // a contract violation we refuse to honor (otherwise the user would
        // see a terminal DONE with empty answer).
        const fromEvaluator = result.finalAnswer?.trim();
        const fromExecutor = afterBudget.pendingFinishSummary?.trim();
        const answer = fromEvaluator || fromExecutor;
        if (!answer) {
          console.warn(
            '[polaris] evaluator returned done with empty finalAnswer and no executor summary; ' +
            'overriding to "continue" — model contract violation',
          );
          await this.emit(afterBudget.taskId, 'verdict', {
            verdict: 'continue',
            reason: `evaluator returned done with empty finalAnswer (was: "${result.reason ?? ''}") — overridden to continue`,
            originalVerdict: 'done',
          });
          this.stepsSinceEval = 0;
          return await store.patchHot({
            phase: 'EXECUTING',
            pendingFinishSummary: null,
          });
        }
        return await store.patchHot({
          phase: 'DONE',
          finalAnswer: answer,
          pendingFinishSummary: null,
        });
      }
      case 'continue':
        this.stepsSinceEval = 0;
        return await store.patchHot({
          phase: 'EXECUTING',
          pendingFinishSummary: null,
        });
      case 'replan': {
        // Defensive: replan also needs a real hint or we fall back to the reason.
        const hint =
          result.replanHint?.trim() ||
          result.reason?.trim() ||
          'evaluator requested replan without specific guidance';
        this.stepsSinceEval = 0;
        return await store.patchHot({
          phase: 'PLANNING',
          pendingFinishSummary: null,
          replanHint: hint,
        });
      }
      case 'abort':
        return await store.patchHot({
          phase: 'ABORTED',
          pendingFinishSummary: null,
        });
      default: {
        // Unreachable — verdict is Zod-validated as a fixed union before we get here.
        throw new Error(`unexpected verdict: ${String(result.verdict)}`);
      }
    }
  }

  private async runCompaction(state: AgentStateHot): Promise<AgentStateHot> {
    await this.emit(state.taskId, 'role_start', { role: 'compactor' });
    await store.patchHot({ phase: 'COMPACTING' });

    const allScratch = await store.readScratchAll(state.taskId);
    const existingKeys = await store.existingFindingKeys(state.taskId);

    const result = await runCompactor({
      goal: state.goal.text,
      scratchEntries: allScratch,
      existingKeys,
      client: this.client,
      model: this.model,
      signal: this.abort?.signal,
    });

    if (!result.ok || !result.findings) {
      await this.emit(state.taskId, 'role_end', {
        role: 'compactor',
        ok: false,
        error: result.error,
        promptTokens: result.promptTokens,
        genTokens: result.genTokens,
      });
      // Continue executing without compacting — scratchpad will keep growing
      // until the Executor's per-call budget guard refuses it. M2.6 breaker
      // will then nudge / abort.
      return await store.patchHot({ phase: 'EXECUTING' });
    }

    // Persist findings, then delete the compacted scratch entries. M2.6 will
    // wrap these in a single IDB transaction so a crash between writes can't
    // double-count. M2.5 accepts the small race window.
    for (const f of result.findings) {
      await store.appendFinding({
        taskId: state.taskId,
        source: 'compactor',
        stepId: state.currentStepId,
        kind: f.kind,
        key: f.key,
        value: f.value,
        evidence: f.evidence,
      });
    }
    const compactedSeqs = allScratch.map((e) => e.seq);
    await store.deleteScratchSeqs(state.taskId, compactedSeqs);

    const back = await store.patchHot({ phase: 'EXECUTING' });
    await this.emit(back.taskId, 'compaction', {
      discarded: compactedSeqs.length,
      produced: result.findings.length,
      promptTokens: result.promptTokens,
      genTokens: result.genTokens,
    });
    await this.emit(back.taskId, 'role_end', {
      role: 'compactor',
      ok: true,
      promptTokens: result.promptTokens,
      genTokens: result.genTokens,
      retried: result.retried,
    });
    return back;
  }

  private async finalizeAborted(reason: string): Promise<AgentStateHot> {
    const state = await store.patchHot({ phase: 'ABORTED' });
    await this.emit(state.taskId, 'verdict', { verdict: 'abort', reason });
    return state;
  }

  private async emit(taskId: string, type: AgentEventType, data: unknown): Promise<void> {
    this.onEvent({ type, data });
    try {
      await store.appendEvent(taskId, type, data);
    } catch (e) {
      console.warn('[polaris] event persist failed', e);
    }
  }
}
