// Executor role: hot-path agent step.
//
// Each call: builds a tight prompt (≤6K tokens target), invokes the model
// with thinking OFF and `tools=[...]`, expects exactly one tool_call.
// Retries once with a directive nudge if the model returns an empty
// tool_calls array (~20% of the time per probe data).
//
// Does NOT persist anything itself — returns a structured result that the
// orchestrator turns into scratchpad entries + event log writes.

import type { AnyClient, DriveProvider } from '../../background/chat_driver';
import { driveChatOnce } from '../../background/chat_driver';
import type { ToolRegistry, ToolContext } from '../tools';
import { SPECIAL_TOOLS } from '../tools';
import type { AgentStateHot } from '../../shared/agent_types';
import type { ToolCall, ToolResult } from '../../shared/tool_types';
import * as store from '../state_store';
import { executorSystemPrompt, executorRetryNudge } from '../prompts/executor';
import { approxTokens, truncateForReplay } from '../budget';
import { log } from '../log';

export interface ExecutorInput {
  state: AgentStateHot;
  registry: ToolRegistry;
  client: AnyClient;
  model: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  numPredict?: number;
  numCtx?: number;
  fallback?: DriveProvider;
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
  const { state, registry, client, model, signal } = input;

  const toolDefs = registry.toToolDefs();
  const toolNames = registry.names();
  const scratchTail = await store.readScratchTail(state.taskId, 5);
  const relevantFindings = await store.findingsByRecency(state.taskId, 5);

  const systemPrompt = executorSystemPrompt({
    goal: state.goal.text,
    plan: state.plan,
    activeStepId: state.currentStepId,
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

  // The user-role anchor is critical for tool-call reliability on Qwen3
  // chat templates: a system-only conversation often produces prose instead
  // of tool_calls because the template treats the user turn as the "active
  // instruction channel." A short, generic anchor pushes the model into
  // tool-calling mode without leaking task-specific text.
  const userAnchor = 'Take the next action toward completing the goal. Call exactly one tool now.';

  const provider = { client, model, timeoutMs: input.timeoutMs, numPredict: input.numPredict, numCtx: input.numCtx };

  // First attempt
  const first = await driveChatOnce(provider, {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userAnchor },
    ],
    tools: toolDefs,
    think: true,
    signal,
  }, input.fallback);
  let toolCalls = first.message?.tool_calls ?? [];
  let promptTokens = first.prompt_eval_count ?? estimatedPromptTokens;
  let genTokens = first.eval_count ?? 0;
  let retried = false;

  // Empty-tool-call retry — Ollama tool-call success rate is ~80% per probe data.
  // Pattern: keep the user anchor, append a TRUNCATED echo of the failed
  // assistant turn so the model can see what it produced wrong, then a
  // corrective user turn. Truncating the replay (vs replaying the full
  // failed content verbatim) keeps the retry prompt under budget — long
  // failed outputs don't blow past BUDGETS.executor on the retry call.
  if (toolCalls.length === 0) {
    retried = true;
    const nudge = executorRetryNudge(toolNames);
    const failedContent = truncateForReplay(first.message?.content ?? '');
    const retryMessages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: userAnchor },
      { role: 'assistant' as const, content: failedContent },
      { role: 'user' as const, content: nudge },
    ];
    // Budget guard on the retry path: if even the truncated replay pushes us
    // over budget, fall back to a placeholder so we still get a retry attempt
    // rather than failing pre-flight.
    const retrySize = approxTokens(retryMessages.map((m) => m.content).join('\n'));
    if (retrySize > state.budgets.executor.max) {
      retryMessages[2] = {
        role: 'assistant',
        content: '[previous output was unparseable — call exactly one tool now]',
      };
    }
    const second = await driveChatOnce(provider, {
      messages: retryMessages,
      tools: toolDefs,
      think: true,
      signal,
    }, input.fallback);
    toolCalls = second.message?.tool_calls ?? [];
    promptTokens += second.prompt_eval_count ?? approxTokens(systemPrompt + nudge + failedContent);
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

  // Multi-tool-call: take the first, but log a warning so we can spot models
  // that frequently produce extras (would suggest tightening the prompt).
  if (toolCalls.length > 1) {
    log('warn', 'executor', `model produced ${toolCalls.length} tool calls; using first only`, {
      first: toolCalls[0]?.function.name,
      dropped: toolCalls.slice(1).map((c) => c.function.name),
    });
  }

  const call = toolCalls[0]!;
  const ctx: ToolContext = { taskId: state.taskId, stepId: state.currentStepId };
  const result = await registry.dispatch(call, ctx);

  // `finish` is special: orchestrator routes to EVALUATING.
  const isFinish = call.function.name === SPECIAL_TOOLS.FINISH;
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
