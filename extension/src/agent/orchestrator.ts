// Orchestrator — the agent loop driver.
//
// Single point that owns the state-machine transitions. Reads/writes
// persistent state via state_store, invokes role functions, dispatches
// tools, emits events for the UI.
//
// Includes (all shipped):
//   - Planner role (initial + replan)
//   - Executor loop with mock + browser tools
//   - Compactor fires before each Executor turn when scratchpad ≥ 80%
//     of executor budget
//   - Evaluator runs after every EVAL_EVERY_N_STEPS turns AND on finish
//   - Verdict routes: done → DONE, continue → EXECUTING,
//     replan → PLANNING (with hint), abort → ABORTED
//   - Circuit breaker (action-repeat, distinct-action, hallucinated-tool,
//     no-progress, total-replan-cap, fatal-tool)
//   - Heartbeat keeping the watchdog from stomping on long Planner calls
//   - Crash-resume via state_store.loadHot + replay-from-IDB
//   - closeOwnedTabs cleanup at terminal phase

import type { OllamaClient } from '../background/ollama';
import { ToolRegistry, createDefaultRegistry } from './tools';
import { closeOwnedTabs } from './tools';
import { runExecutor } from './roles/executor';
import { runPlanner } from './roles/planner';
import { runEvaluator } from './roles/evaluator';
import { runCompactor } from './roles/compactor';
import * as store from './state_store';
import * as breaker from './circuit_breaker';
import { recordMetric } from './metrics';
import { log } from './log';
import type {
  AgentStateHot,
  AgentEventType,
} from '../shared/agent_types';
import { BUDGETS, COMPACT_THRESHOLD, COMPACT_ENTRY_COUNT } from './budget';
import { SPECIAL_TOOLS } from './tools';
import type { Plan, PlanStep } from '../shared/agent_types';

/** Evaluate every N successful Executor turns (in addition to on-finish). */
const EVAL_EVERY_N_STEPS = 5;

/** Force-advance the plan step if the Executor spends this many turns on it without calling next_step. */
const MAX_TURNS_PER_STEP = 8;

/**
 * Bump lastTouch this often during a long-running task so the watchdog can't
 * mistakenly abort an in-flight Planner / Evaluator call (those can take 30+ s
 * on slow hardware). The watchdog's stale threshold is 5 min, so 30 s gives
 * plenty of margin.
 */
const LAST_TOUCH_INTERVAL_MS = 30_000;

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
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

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
    this.startHeartbeat();
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
    this.startHeartbeat();
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
    let taskIdForCleanup: string | null = null;
    try {
      const final = await this.runUntilTerminalInner();
      taskIdForCleanup = final.taskId;
      return final;
    } catch (e) {
      // Any uncaught error from a role call (e.g., Ollama HTTP 503 after
      // retries exhausted, or the timeout fired) leaves the task in a
      // non-terminal phase. Transition to ABORTED before re-raising so a
      // subsequent `resume()` doesn't pick up the dead task and reissue
      // the failing call. The watchdog would eventually catch this, but
      // explicit transition is faster and more honest.
      try {
        const cur = await store.loadHot();
        if (cur && cur.phase !== 'DONE' && cur.phase !== 'ABORTED') {
          await store.patchHot({ phase: 'ABORTED' });
          taskIdForCleanup = cur.taskId;
          await this.emit(cur.taskId, 'error', {
            error: (e as Error).message ?? 'orchestrator failed',
          });
          await this.emit(cur.taskId, 'verdict', {
            verdict: 'abort',
            reason: `unrecoverable: ${(e as Error).message ?? 'unknown'}`,
          });
        } else if (cur) {
          taskIdForCleanup = cur.taskId;
        }
      } catch (transitionErr) {
        // Hot state may be cleared by a concurrent `agent.reset` — that's a
        // legitimate race and we just continue with the rethrow. Anything
        // else is suspicious; log so it's not silently swallowed.
        const msg = (transitionErr as Error).message ?? '';
        if (!/no hot state/i.test(msg)) {
          console.warn(
            '[polaris] runUntilTerminal: failed to transition to ABORTED on error path',
            transitionErr,
          );
        }
      }
      throw e;
    } finally {
      this.stopHeartbeat();
      // Close tabs the agent opened during this task. Best-effort with a hard
      // 2-second deadline — a hung chrome.tabs.remove (DevTools session
      // conflict, tab in unload, Chrome bug) can NOT be allowed to wedge
      // runUntilTerminal forever. We race against a sleep and log on cap.
      if (taskIdForCleanup !== null) {
        const cleanup = closeOwnedTabs(taskIdForCleanup);
        const deadline = new Promise<'deadline'>((resolve) =>
          setTimeout(() => resolve('deadline'), 2_000),
        );
        try {
          const result = await Promise.race([cleanup.then(() => 'done' as const), deadline]);
          if (result === 'deadline') {
            console.warn(
              `[polaris] closeOwnedTabs(${taskIdForCleanup}) did not complete within 2s; abandoning`,
            );
          }
        } catch (e) {
          console.warn('[polaris] closeOwnedTabs at terminal failed', e);
        }
      }
    }
  }

  private async runUntilTerminalInner(): Promise<AgentStateHot> {
    let state = await store.loadHot();
    if (!state) throw new Error('runUntilTerminal: no active task');
    let stepCount = 0;

    while (stepCount < this.maxSteps) {
      if (this.abort?.signal.aborted) {
        return await this.finalizeAborted('user_abort');
      }
      state = (await store.loadHot())!;
      if (state.phase === 'DONE' || state.phase === 'ABORTED') break;

      // Pre-flight: compactor runs when scratchpad pressure is high (token
      // budget OR entry count). The entry-count branch matters for normal-
      // length tasks where each tool round-trip is small (~30 tokens) — the
      // token threshold alone almost never trips at maxSteps=30.
      if (
        state.phase === 'EXECUTING' &&
        (state.scratchpadRef.tokens >= COMPACT_THRESHOLD * BUDGETS.executor ||
          state.scratchpadRef.count >= COMPACT_ENTRY_COUNT)
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
    this.stopHeartbeat();
    const state = await store.loadHot();
    if (state && state.phase !== 'DONE' && state.phase !== 'ABORTED') {
      await this.finalizeAborted('user_abort');
    }
  }

  /**
   * Within-SW heartbeat: bumps `lastTouch` every LAST_TOUCH_INTERVAL_MS
   * while `runUntilTerminal` is in-flight. Specifically protects against
   * the watchdog (chrome.alarms in service_worker.ts) tripping its 5-min
   * stale threshold during a single long Planner / Evaluator call —
   * thinking-mode runs against a slow box can plausibly run 1–4 minutes,
   * and without this heartbeat the watchdog could mark such a task ABORTED
   * and race the in-flight call's own write of EXECUTING.
   *
   * Limits: this only buys safety inside a healthy SW lifetime. If the SW
   * itself dies mid-task, the heartbeat dies with it — crash-resume is
   * then handled separately by `resume()`, whose first `patchHot` bumps
   * `lastTouch` and re-claims the task. The heartbeat does NOT defend
   * against SW death.
   *
   * Does not race with patchHot — both go through the state_store hot
   * mutex (which serializes writes).
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void store.bumpLastTouch().catch((e) => {
        console.warn('[polaris] heartbeat bumpLastTouch failed', e);
      });
    }, LAST_TOUCH_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
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
    const t0 = performance.now();
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
    const latencyMs = Math.round(performance.now() - t0);
    void recordMetric({
      taskId: prepared.taskId,
      layer: 'role',
      op: isInitial ? 'planner_initial' : 'planner_replan',
      latencyMs,
      ok: result.ok,
      error: result.ok ? undefined : result.error,
      meta: { promptTokens: result.promptTokens, genTokens: result.genTokens, retried: result.retried },
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
      turnsOnCurrentStep: 0,
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

    const t0 = performance.now();
    const result = await runExecutor({
      state,
      registry: this.registry,
      client: this.client,
      model: this.model,
      signal: this.abort?.signal,
    });
    const latencyMs = Math.round(performance.now() - t0);
    void recordMetric({
      taskId: state.taskId,
      layer: 'role',
      op: 'executor_turn',
      latencyMs,
      ok: result.ok,
      error: result.ok ? undefined : result.error,
      meta: {
        promptTokens: result.promptTokens,
        genTokens: result.genTokens,
        retried: result.retried,
        toolName: result.toolCall?.function.name,
      },
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
        {
          ok: result.toolResult.ok,
          fatal: result.toolResult.fatal,
          unknownTool: result.toolResult.unknownTool,
        },
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

    // Step advancement — explicit (next_step tool) or forced (max turns hit).
    const askedNextStep =
      result.toolCall?.function.name === SPECIAL_TOOLS.NEXT_STEP &&
      result.toolResult?.ok === true;
    const turnsOnStep = (next.turnsOnCurrentStep ?? 0) + 1;
    let stepAdvanced = false;
    if (askedNextStep) {
      next = await this.advancePlanStep(next, 'explicit');
      stepAdvanced = true;
    } else if (turnsOnStep >= MAX_TURNS_PER_STEP && next.currentStepId) {
      log('warn', 'agent', `force-advancing step after ${turnsOnStep} turns`, {
        stepId: next.currentStepId,
      });
      next = await this.advancePlanStep(next, 'forced');
      stepAdvanced = true;
    } else {
      next = await store.patchHot({ turnsOnCurrentStep: turnsOnStep });
    }

    if (!result.ok && !result.toolCall) {
      // The Executor itself failed BEFORE getting a tool call out of the
      // model — typically "no tool call after retry" when qwen3.5 returns
      // empty tool_calls twice in a row. No breaker signal exists for this
      // case (we don't know what the model meant to do), so we hard-bail.
      //
      // When `result.toolCall` IS present, even if its tool result was
      // not-ok, the breaker has already had its chance to record the
      // failure and decide replan/abort/ok above. Don't pre-empt it —
      // recoverable tool errors are exactly what the breaker exists to
      // handle. (Earlier this branch fired for ALL `!result.ok`, which
      // pre-empted the unknown-tool / repeated-action breaker windows
      // before they could fill.)
      const aborted = await store.patchHot({ phase: 'ABORTED' });
      await this.emit(aborted.taskId, 'error', { error: result.error ?? 'unknown executor error' });
      return aborted;
    }

    // If we advanced past the last step, route to EVALUATING — the model is
    // out of plan to walk and the Evaluator decides done/replan/abort.
    if (stepAdvanced && next.currentStepId === null) {
      next = await store.patchHot({
        phase: 'EVALUATING',
        pendingFinishSummary: null,
      });
      await this.emit(next.taskId, 'phase', {
        phase: 'EVALUATING',
        trigger: 'all_steps_done',
      });
    }

    return next;
  }

  /**
   * Mark the current plan step as `done`, find the next pending step, set
   * it `active`, reset the breaker's repeats counter (different action set
   * is now legitimate), and zero `turnsOnCurrentStep`.
   *
   * Returns updated state. If no next pending step exists, currentStepId
   * becomes null and the caller routes to EVALUATING.
   */
  private async advancePlanStep(
    state: AgentStateHot,
    trigger: 'explicit' | 'forced',
  ): Promise<AgentStateHot> {
    const result = walkPlan(state.plan, state.currentStepId);
    log('info', 'agent', `step advance (${trigger})`, {
      from: state.currentStepId,
      to: result.nextStepId,
      planRevision: state.plan.revision,
    });
    const next = await store.patchHot({
      plan: result.plan,
      currentStepId: result.nextStepId,
      turnsOnCurrentStep: 0,
      // Reset BOTH per-action counters: a different step's tool calls are
      // legitimately different actions, not stuck-loop signal. Without
      // clearing recentActionHashes, the distinct-action breaker would
      // immediately trip after a force-advance from a single-tool step.
      breaker: { ...state.breaker, repeats: {}, recentActionHashes: [] },
    });
    await this.emit(next.taskId, 'phase', {
      step_advance: true,
      trigger,
      fromStep: state.currentStepId,
      toStep: result.nextStepId,
    });
    return next;
  }

  private async runEvaluation(state: AgentStateHot): Promise<AgentStateHot> {
    const triggeredByFinish = state.pendingFinishSummary !== null;
    await this.emit(state.taskId, 'role_start', {
      role: 'evaluator',
      trigger: triggeredByFinish ? 'finish' : 'periodic',
    });
    const t0 = performance.now();
    const result = await runEvaluator({
      state,
      client: this.client,
      model: this.model,
      signal: this.abort?.signal,
      thinkingMode: this.evaluatorThinking,
      triggeredByFinish,
    });
    void recordMetric({
      taskId: state.taskId,
      layer: 'role',
      op: triggeredByFinish ? 'evaluator_finish' : 'evaluator_periodic',
      latencyMs: Math.round(performance.now() - t0),
      ok: result.ok,
      error: result.ok ? undefined : result.error,
      meta: { verdict: result.verdict, promptTokens: result.promptTokens, genTokens: result.genTokens, retried: result.retried },
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

    const t0 = performance.now();
    const result = await runCompactor({
      goal: state.goal.text,
      scratchEntries: allScratch,
      existingKeys,
      client: this.client,
      model: this.model,
      signal: this.abort?.signal,
    });
    void recordMetric({
      taskId: state.taskId,
      layer: 'role',
      op: 'compactor_pass',
      latencyMs: Math.round(performance.now() - t0),
      ok: result.ok,
      error: result.ok ? undefined : result.error,
      meta: {
        scratchEntries: allScratch.length,
        findingsProduced: result.findings?.length ?? 0,
        promptTokens: result.promptTokens,
        genTokens: result.genTokens,
        retried: result.retried,
      },
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
      // until the Executor's per-call budget guard refuses it. The breaker
      // will then nudge / abort via the no-progress signal.
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

    // Roll the compactor's token usage into the running totalTokens. The role
    // doesn't have a per-role budget cell in BudgetState (only the three call
    // sites that matter for hot-path latency have those); but the compactor's
    // cost is real and we want it visible in the per-task tally.
    const back = await store.patchHot({
      phase: 'EXECUTING',
      budgets: {
        ...state.budgets,
        totalTokens: state.budgets.totalTokens + result.promptTokens + result.genTokens,
      },
    });
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

/**
 * Mark the step at currentStepId as `done` and find the next pending step
 * (set it `active`). Returns the new plan + the next step id (or null if
 * we've walked off the end).
 *
 * Children stay as-is — M2.6.3 only walks root steps. M2.7+ may add
 * sub-step traversal if needed.
 *
 * Exported so tests can hold the real implementation under property-based
 * verification rather than duplicating it (the duplicate-and-comment-the-
 * drift-risk pattern that arch-nemesis #4 caught).
 */
export function walkPlan(plan: Plan, currentStepId: string | null): { plan: Plan; nextStepId: string | null } {
  if (currentStepId === null) {
    return { plan, nextStepId: null };
  }
  const newRootSteps: PlanStep[] = plan.rootSteps.map((s) => ({ ...s }));
  let nextStepId: string | null = null;
  let foundCurrent = false;
  for (let i = 0; i < newRootSteps.length; i++) {
    if (newRootSteps[i]!.id === currentStepId) {
      foundCurrent = true;
      newRootSteps[i] = { ...newRootSteps[i]!, status: 'done' };
      // Find the next pending step.
      for (let j = i + 1; j < newRootSteps.length; j++) {
        if (newRootSteps[j]!.status === 'pending' || newRootSteps[j]!.status === 'active') {
          newRootSteps[j] = { ...newRootSteps[j]!, status: 'active' };
          nextStepId = newRootSteps[j]!.id;
          break;
        }
      }
      break;
    }
  }
  if (!foundCurrent) {
    // currentStepId not in plan (could happen after a replan). Bail.
    return { plan, nextStepId: null };
  }
  return {
    plan: { ...plan, rootSteps: newRootSteps },
    nextStepId,
  };
}
