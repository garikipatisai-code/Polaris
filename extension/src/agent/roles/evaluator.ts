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
import type { OllamaClient } from '../../background/ollama';
import type { AgentStateHot } from '../../shared/agent_types';
import { evaluatorSystemPrompt } from '../prompts/evaluator';
import { parseJSONPermissive } from './planner';
import { approxTokens, BUDGETS } from '../budget';
import * as store from '../state_store';

export type Verdict = 'done' | 'continue' | 'replan' | 'abort';

export interface EvaluatorInput {
  state: AgentStateHot;
  client: OllamaClient;
  model: string;
  signal?: AbortSignal;
  thinkingMode: boolean;
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
}

const EvaluatorResponseSchema = z.object({
  verdict: z.enum(['done', 'continue', 'replan', 'abort']),
  reason: z.string().max(500),
  finalAnswer: z.string().max(2000).optional(),
  replanHint: z.string().max(500).optional(),
});

export async function runEvaluator(input: EvaluatorInput): Promise<EvaluatorOutput> {
  const { state, client, model, signal, thinkingMode } = input;

  const findings = await store.findingsByRecency(state.taskId, 30);
  const scratchTail = await store.readScratchTail(state.taskId, 15);
  const systemPrompt = evaluatorSystemPrompt({
    goal: state.goal.text,
    successCriteria: state.goal.successCriteria,
    plan: state.plan,
    findings,
    scratchTail,
    pendingFinishSummary: state.pendingFinishSummary,
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

  let response = await client.chatOnce({
    model,
    messages: [{ role: 'system', content: systemPrompt }],
    format: 'json',
    think: thinkingMode,
    signal,
  });
  let promptTokens = response.prompt_eval_count ?? estimated;
  let genTokens = response.eval_count ?? 0;
  let content = response.message?.content ?? '';
  let parsed: unknown;
  let retried = false;

  try {
    parsed = parseJSONPermissive(content);
  } catch {
    retried = true;
    response = await client.chatOnce({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'system',
          content:
            'Your previous output was not valid JSON. Output ONLY a single JSON object with verdict, reason, and optional finalAnswer / replanHint.',
        },
      ],
      format: 'json',
      think: false,
      signal,
    });
    promptTokens += response.prompt_eval_count ?? 0;
    genTokens += response.eval_count ?? 0;
    content = response.message?.content ?? '';
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
  };
}
