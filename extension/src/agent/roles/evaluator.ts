// Evaluator role.
//
// Called after every N Executor turns AND whenever Executor signals finish.
// Returns one of four verdicts that drive the state machine:
//   done     → terminal DONE (with finalAnswer)
//   continue → back to EXECUTING
//   replan   → back to PLANNING (with replanHint)
//   abort    → terminal ABORTED
//
// Thinking ON by default (verdicts are load-bearing); format:"json" for
// structured output + permissive JSON extractor (model occasionally
// wraps in prose). One retry on parse failure.

import { z } from 'zod';
import type { AnyClient, DriveProvider } from '../../background/chat_driver';
import { driveChatOnce } from '../../background/chat_driver';
import type { AgentStateHot } from '../../shared/agent_types';
import { evaluatorSystemPrompt } from '../prompts/evaluator';
import { parseJSONPermissive } from './planner';
import { approxTokens, BUDGETS, truncateForReplay } from '../budget';
import * as store from '../state_store';

export type Verdict = 'done' | 'continue' | 'replan' | 'abort';

export interface EvaluatorInput {
  state: AgentStateHot;
  client: AnyClient;
  model: string;
  signal?: AbortSignal;
  thinkingMode: boolean;
  /** True if the Executor's `finish` triggered this Evaluator, false for periodic checkpoint. */
  triggeredByFinish: boolean;
  timeoutMs?: number;
  numPredict?: number;
  numCtx?: number;
  options?: Record<string, unknown>;
  fallback?: DriveProvider;
}

export interface EvaluatorOutput {
  ok: boolean;
  verdict?: Verdict;
  reason?: string;
  finalAnswer?: string;
  replanHint?: string;
  error?: string;
  promptTokens: number;
  genTokens: number;
  retried: boolean;
  /** Model's thinking trace (Gemma 4 reasoning), if any. */
  thinking?: string;
}

const EvaluatorResponseSchema = z.object({
  verdict: z.enum(['done', 'continue', 'replan', 'abort']),
  reason: z.string().max(500),
  finalAnswer: z.string().max(2000).optional(),
  replanHint: z.string().max(500).optional(),
});

export async function runEvaluator(input: EvaluatorInput): Promise<EvaluatorOutput> {
  const { state, client, model, signal, thinkingMode, triggeredByFinish } = input;

  const findings = await store.findingsByRecency(state.taskId, 30);
  const scratchTail = await store.readScratchTail(state.taskId, 15);
  const systemPrompt = evaluatorSystemPrompt({
    goal: state.goal.text,
    successCriteria: state.goal.successCriteria,
    plan: state.plan,
    findings,
    scratchTail,
    pendingFinishSummary: state.pendingFinishSummary,
    triggeredByFinish,
  });

  const estimated = approxTokens(systemPrompt);
  if (estimated > BUDGETS.evaluator) {
    return {
      ok: false,
      error: `evaluator prompt ${estimated}t exceeds budget ${BUDGETS.evaluator}t`,
      promptTokens: 0,
      genTokens: 0,
      retried: false,
    };
  }

  // user-role anchor: see planner.ts comment — keeps Qwen3 in structured-
  // output mode rather than producing a thinking preamble.
  const userAnchor = triggeredByFinish
    ? 'Evaluate whether the executor\'s proposed finish answer satisfies the goal. Return JSON only.'
    : 'Evaluate progress so far. Return your verdict as JSON only.';

  const provider = { client, model, timeoutMs: input.timeoutMs, numPredict: input.numPredict, numCtx: input.numCtx, options: input.options };

  const firstResp = await driveChatOnce(provider, {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userAnchor },
    ],
    format: 'json',
    think: thinkingMode,
    signal,
  }, input.fallback);
  let promptTokens = firstResp.prompt_eval_count ?? estimated;
  let genTokens = firstResp.eval_count ?? 0;
  let content = firstResp.message?.content ?? '';
  const thinking = firstResp.message?.thinking;
  let parsed: unknown;
  let retried = false;

  try {
    parsed = parseJSONPermissive(content);
  } catch {
    // [system, user-anchor, assistant-failed (truncated), user-nudge] —
    // see planner.ts. Replay truncation prevents corrupted long outputs
    // from pushing the retry past BUDGETS.evaluator.
    retried = true;
    const failedContent = truncateForReplay(content);
    const retryMessages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: userAnchor },
      { role: 'assistant' as const, content: failedContent },
      {
        role: 'user' as const,
        content:
          'Your previous output was not valid JSON. Output ONLY a single JSON object with verdict, reason, and optional finalAnswer / replanHint.',
      },
    ];
    const retrySize = approxTokens(retryMessages.map((m) => m.content).join('\n'));
    if (retrySize > BUDGETS.evaluator) {
      retryMessages[2] = {
        role: 'assistant',
        content: '[previous output was unparseable JSON — produce the verdict JSON now]',
      };
    }
    const retryResp = await driveChatOnce(provider, {
      messages: retryMessages,
      format: 'json',
      think: false,
      signal,
    }, input.fallback);
    promptTokens += retryResp.prompt_eval_count ?? 0;
    genTokens += retryResp.eval_count ?? 0;
    content = retryResp.message?.content ?? '';
    try {
      parsed = parseJSONPermissive(content);
    } catch (e2) {
      return {
        ok: false,
        error: `evaluator output not parseable after retry: ${(e2 as Error).message}`,
        promptTokens,
        genTokens,
        retried,
      };
    }
  }

  let validated: z.infer<typeof EvaluatorResponseSchema>;
  try {
    validated = EvaluatorResponseSchema.parse(parsed);
  } catch (e) {
    return {
      ok: false,
      error: `evaluator output schema violation: ${(e as Error).message.slice(0, 200)}`,
      promptTokens,
      genTokens,
      retried,
    };
  }

  return {
    ok: true,
    verdict: validated.verdict,
    reason: validated.reason,
    finalAnswer: validated.finalAnswer,
    replanHint: validated.replanHint,
    promptTokens,
    genTokens,
    retried,
    thinking,
  };
}
