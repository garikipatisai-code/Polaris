// Orchestrator — the agent loop driver.
//
// Single point that owns the state-machine transitions. Reads/writes
// persistent state via state_store, invokes role functions, dispatches
// tools, emits events for the UI.
//
// M2.3 scope: minimal. Uses a hardcoded 1-step plan ("achieve the goal
// using available tools, then call finish"). The real Planner arrives
// in M2.4; Evaluator + Compactor in M2.5; Circuit breaker in M2.6.
// The state-machine *shape* matches the M2 design — later milestones
// fill in the phase handlers.

import type { OllamaClient } from '../background/ollama';
import { ToolRegistry, createDefaultRegistry } from './tools';
import { runExecutor } from './roles/executor';
import * as store from './state_store';
import type {
  AgentStateHot,
  Plan,
  AgentEventType,
} from '../shared/agent_types';
import { SPECIAL_TOOLS } from './tools';

/** Hardcoded plan used in M2.3 until the Planner role lands in M2.4. */
function hardcodedPlan(now: number): Plan {
  return {
    rootSteps: [
      {
        id: 's1',
        title: 'Use available tools to satisfy the goal, then call finish.',
        status: 'active',
      },
    ],
    revision: 1,
    generatedAt: now,
    notes: '[M2.3 placeholder plan — Planner role arrives in M2.4]',
  };
}

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
}

export class Orchestrator {
  private readonly client: OllamaClient;
  private readonly model: string;
  private readonly registry: ToolRegistry;
  private readonly onEvent: (event: OrchestratorEvent) => void;
  private readonly maxSteps: number;
  private abort: AbortController | null = null;

  constructor(opts: OrchestratorOptions) {
    this.client = opts.client;
    this.model = opts.model;
    this.registry = opts.registry ?? createDefaultRegistry();
    this.onEvent = opts.onEvent ?? (() => {});
    this.maxSteps = opts.maxSteps ?? 30;
  }

  /**
   * Begin a new task with the given verbatim goal. Throws if a task is
   * already in a non-terminal phase. Transitions IDLE → PLANNING → EXECUTING
   * (skipping real PLANNING for M2.3).
   */
  async start(goalText: string): Promise<AgentStateHot> {
    this.abort = new AbortController();
    const fresh = await store.startTask(goalText);
    await this.emit(fresh.taskId, 'phase', { phase: 'PLANNING' });
    // M2.3: skip real planning, jump straight to EXECUTING with hardcoded plan.
    const planned = await store.patchHot({
      phase: 'EXECUTING',
      plan: hardcodedPlan(Date.now()),
      currentStepId: 's1',
    });
    await this.emit(planned.taskId, 'phase', { phase: 'EXECUTING' });
    return planned;
  }

  /** Run the loop until a terminal phase (DONE / ABORTED). */
  async runUntilTerminal(): Promise<AgentStateHot> {
    let state = await store.loadHot();
    if (!state) throw new Error('runUntilTerminal: no active task');
    let stepCount = 0;
    while (state.phase === 'EXECUTING' && stepCount < this.maxSteps) {
      if (this.abort?.signal.aborted) {
        state = await store.patchHot({ phase: 'ABORTED' });
        await this.emit(state.taskId, 'verdict', { verdict: 'abort', reason: 'user_abort' });
        return state;
      }
      stepCount++;
      state = await this.executeOneStep(state);
    }
    if (state.phase === 'EXECUTING' && stepCount >= this.maxSteps) {
      state = await store.patchHot({ phase: 'ABORTED' });
      await this.emit(state.taskId, 'error', { error: `max steps (${this.maxSteps}) reached` });
    }
    return state;
  }

  /** Abort the in-flight task. Marks phase ABORTED on next loop iteration. */
  async stop(): Promise<void> {
    this.abort?.abort();
    const state = await store.loadHot();
    if (state && state.phase === 'EXECUTING') {
      await store.patchHot({ phase: 'ABORTED' });
      await this.emit(state.taskId, 'verdict', { verdict: 'abort', reason: 'user_abort' });
    }
  }

  // -----------------------------------------------------------------------
  // internals
  // -----------------------------------------------------------------------

  private async executeOneStep(state: AgentStateHot): Promise<AgentStateHot> {
    const step = state.plan.rootSteps.find((s) => s.id === state.currentStepId) ?? null;
    await this.emit(state.taskId, 'role_start', { role: 'executor', stepId: step?.id });

    const result = await runExecutor({
      state,
      step,
      registry: this.registry,
      client: this.client,
      model: this.model,
      signal: this.abort?.signal,
    });

    // Persist call + result into scratchpad + events.
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

    // Update Executor budget tally.
    const next = await store.patchHot({
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

    if (result.finished) {
      // M2.3: short-circuit to DONE. M2.5 will route to EVALUATING first.
      const done = await store.patchHot({ phase: 'DONE' });
      await this.emit(done.taskId, 'verdict', {
        verdict: 'done',
        summary: result.finishSummary,
        tool: SPECIAL_TOOLS.FINISH,
      });
      return done;
    }

    if (!result.ok) {
      // M2.3: bail on first failure. M2.6 circuit breaker will retry/replan.
      const aborted = await store.patchHot({ phase: 'ABORTED' });
      await this.emit(aborted.taskId, 'error', {
        error: result.error ?? 'unknown executor error',
      });
      return aborted;
    }

    return next;
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
