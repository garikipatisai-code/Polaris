// Executor role: hot-path agent step.
//
// Each call: builds a tight prompt (≤6K tokens target), invokes the model
// with thinking OFF and `tools=[...]`, expects exactly one tool_call.
// Retries once with a directive nudge if the model returns an empty
// tool_calls array (~20% of the time per probe data).
//
// Does NOT persist anything itself — returns a structured result that the
// orchestrator turns into scratchpad entries + event log writes.

import type { OllamaClient } from '../../background/ollama';
import type { ToolRegistry, ToolContext } from '../tools';
import type { AgentStateHot, PlanStep } from '../../shared/agent_types';
import type { ToolCall, ToolResult } from '../../shared/tool_types';
import * as store from '../state_store';
import { executorSystemPrompt, executorRetryNudge } from '../prompts/executor';
import { approxTokens } from '../budget';

export interface ExecutorInput {
  state: AgentStateHot;
  step: PlanStep | null;
  registry: ToolRegistry;
  client: OllamaClient;
  model: string;
  signal?: AbortSignal;
}

export interface ExecutorOutput {
  ok: boolean;
  toolCall?: ToolCall;
  toolResult?: ToolResult;
  finished?: boolean;
  finishSummary?: string;
  error?: string;
  promptTokens: number;
  genTokens: number;
  retried: boolean;
}

export async function runExecutor(input: ExecutorInput): Promise<ExecutorOutput> {
  const { state, step, registry, client, model, signal } = input;

  const toolDefs = registry.toToolDefs();
  const toolNames = registry.names();
  const scratchTail = await store.readScratchTail(state.taskId, 5);
  const relevantFindings = await store.findingsByRecency(state.taskId, 5);

  const systemPrompt = executorSystemPrompt({
    goal: state.goal.text,
    step: step ? { id: step.id, title: step.title, rationale: step.rationale } : null,
    relevantFindings,
    scratchTail,
    availableToolNames: toolNames,
  });

  // Budget guard: if the prompt alone exceeds the executor budget, abort
  // before the network call — compaction needs to run first.
  const estimatedPromptTokens = approxTokens(systemPrompt);
  if (estimatedPromptTokens > state.budgets.executor.max) {
    return {
      ok: false,
      error: `executor prompt ${estimatedPromptTokens}t exceeds budget ${state.budgets.executor.max}t — compactor must run`,
      promptTokens: 0,
      genTokens: 0,
      retried: false,
    };
  }

  // First attempt
  const first = await client.chatOnce({
    model,
    messages: [{ role: 'system', content: systemPrompt }],
    tools: toolDefs,
    think: false,
    signal,
  });
  let toolCalls = first.message?.tool_calls ?? [];
  let promptTokens = first.prompt_eval_count ?? estimatedPromptTokens;
  let genTokens = first.eval_count ?? 0;
  let retried = false;

  // Empty-tool-call retry — Ollama tool-call success rate is ~80% per probe data.
  if (toolCalls.length === 0) {
    retried = true;
    const nudge = executorRetryNudge(toolNames);
    const second = await client.chatOnce({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'system', content: nudge },
      ],
      tools: toolDefs,
      think: false,
      signal,
    });
    toolCalls = second.message?.tool_calls ?? [];
    promptTokens += second.prompt_eval_count ?? approxTokens(systemPrompt + nudge);
    genTokens += second.eval_count ?? 0;
  }

  if (toolCalls.length === 0) {
    return {
      ok: false,
      error: 'executor returned no tool call after retry',
      promptTokens,
      genTokens,
      retried,
    };
  }

  const call = toolCalls[0]!;
  const ctx: ToolContext = { taskId: state.taskId, stepId: state.currentStepId };
  const result = await registry.dispatch(call, ctx);

  // `finish` is special: orchestrator routes to EVALUATING.
  const isFinish = call.function.name === 'finish';
  const finishSummary = isFinish
    ? (call.function.arguments as { summary?: string }).summary
    : undefined;

  return {
    ok: result.ok,
    toolCall: call,
    toolResult: result,
    finished: isFinish && result.ok,
    finishSummary,
    error: result.ok ? undefined : result.error,
    promptTokens,
    genTokens,
    retried,
  };
}
