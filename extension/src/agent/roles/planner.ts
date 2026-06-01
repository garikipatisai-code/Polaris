// Planner role.
//
// Called rarely (initial start + replans). Uses `format: "json"` string
// mode + permissive JSON extraction (the model occasionally wraps output
// in markdown fences or prose despite instructions). Validates against a
// Zod schema; one retry with a directive nudge on parse failure.
//
// Thinking ON because Planner outputs are load-bearing: replan rate is
// driven by Plan quality.

import { z } from 'zod';
import type { AnyClient, DriveProvider } from '../../background/chat_driver';
import { driveChatOnce } from '../../background/chat_driver';
import type { ToolRegistry } from '../tools';
import type { AgentStateHot, Plan, PlanStep } from '../../shared/agent_types';
import { plannerSystemPrompt } from '../prompts/planner';
import { approxTokens, BUDGETS, truncateForReplay } from '../budget';
import * as store from '../state_store';

export interface PlannerInput {
  state: AgentStateHot;
  registry: ToolRegistry;
  client: AnyClient;
  model: string;
  signal?: AbortSignal;
  isInitial: boolean;
  replanHint?: string;
  /** Whether to enable Qwen's thinking mode for this Planner call. */
  thinkingMode: boolean;
  timeoutMs?: number;
  numPredict?: number;
  numCtx?: number;
  options?: Record<string, unknown>;
  fallback?: DriveProvider;
}

export interface PlannerOutput {
  ok: boolean;
  plan?: Plan;
  successCriteria?: string[];
  error?: string;
  promptTokens: number;
  genTokens: number;
  retried: boolean;
}

// Zod can't directly express recursive types with full inference; cast.
// children: one level of nesting (no grandchildren).
const ChildStepSchema = z.object({
  id: z.string().min(1).max(20),
  title: z.string().min(1).max(200),
  rationale: z.string().max(300).optional(),
});

const RootStepSchema = z.object({
  id: z.string().min(1).max(20),
  title: z.string().min(1).max(200),
  rationale: z.string().max(300).optional(),
  children: z.array(ChildStepSchema).max(20).optional(),
});

const PlannerResponseSchema = z.object({
  successCriteria: z.array(z.string().max(300)).max(20).optional(),
  rootSteps: z.array(RootStepSchema).min(1).max(20),
  notes: z.string().max(500).optional(),
});

export async function runPlanner(input: PlannerInput): Promise<PlannerOutput> {
  const { state, registry, client, model, signal, isInitial, replanHint, thinkingMode } = input;

  const findings = await store.findingsByRecency(state.taskId, 20);
  const toolIndex = registry.toIndex();
  const systemPrompt = plannerSystemPrompt({
    goal: state.goal.text,
    successCriteria: state.goal.successCriteria,
    currentPlan: isInitial ? null : state.plan,
    findings,
    toolIndex,
    replanHint,
    isInitial,
  });

  // Pre-call budget guard.
  const estimatedPromptTokens = approxTokens(systemPrompt);
  if (estimatedPromptTokens > BUDGETS.planner) {
    return {
      ok: false,
      error: `planner prompt ${estimatedPromptTokens}t exceeds budget ${BUDGETS.planner}t`,
      promptTokens: 0,
      genTokens: 0,
      retried: false,
    };
  }

  // The user-role anchor is critical for tool-call/JSON reliability on Qwen3:
  // its chat template treats `user` as the active instruction channel, so a
  // system-only conversation can produce a thinking-aloud preamble before
  // the JSON. A short generic anchor pushes the model into structured-output
  // mode without leaking task-specific text.
  const userAnchor = isInitial
    ? 'Produce the initial JSON plan now.'
    : 'Produce the revised JSON plan now, taking the replan hint into account.';

  const provider = { client, model, timeoutMs: input.timeoutMs, numPredict: input.numPredict, numCtx: input.numCtx, options: input.options };

  // First attempt — thinking per setting.
  let response = await driveChatOnce(provider, {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userAnchor },
    ],
    format: 'json',
    think: thinkingMode,
    signal,
  }, input.fallback);
  let promptTokens = response.prompt_eval_count ?? estimatedPromptTokens;
  let genTokens = response.eval_count ?? 0;
  let content = response.message?.content ?? '';
  let parsed: unknown;
  let retried = false;

  try {
    parsed = parseJSONPermissive(content);
  } catch {
    // Retry with [system, user-anchor, assistant-failed, user-nudge].
    // Showing the model its own broken output + a corrective user turn beats
    // appending a second `system` message: Qwen3 templates emit only one
    // system block, so the second `system` gets inlined or dropped.
    // Truncate the replay so a corrupted long output doesn't blow past
    // BUDGETS.planner on the retry call.
    retried = true;
    const failedContent = truncateForReplay(content);
    const retryMessages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: userAnchor },
      { role: 'assistant' as const, content: failedContent },
      {
        role: 'user' as const,
        content:
          'Your previous output was not valid JSON. Output ONLY a single JSON object, ' +
          'no prose, no markdown fences, no leading or trailing text.',
      },
    ];
    const retrySize = approxTokens(retryMessages.map((m) => m.content).join('\n'));
    if (retrySize > BUDGETS.planner) {
      retryMessages[2] = {
        role: 'assistant',
        content: '[previous output was unparseable JSON — produce the JSON now]',
      };
    }
    response = await driveChatOnce(provider, {
      messages: retryMessages,
      format: 'json',
      think: false,
      signal,
    }, input.fallback);
    promptTokens += response.prompt_eval_count ?? 0;
    genTokens += response.eval_count ?? 0;
    content = response.message?.content ?? '';
    try {
      parsed = parseJSONPermissive(content);
    } catch (e2) {
      return {
        ok: false,
        error: `planner output not parseable after retry: ${(e2 as Error).message}`,
        promptTokens,
        genTokens,
        retried,
      };
    }
  }

  let validated: z.infer<typeof PlannerResponseSchema>;
  try {
    validated = PlannerResponseSchema.parse(parsed);
  } catch (e) {
    return {
      ok: false,
      error: `planner output schema violation: ${(e as Error).message.slice(0, 200)}`,
      promptTokens,
      genTokens,
      retried,
    };
  }

  // Build the final Plan, assigning status to each step (first root step = active).
  const priorRevision = state.plan?.revision ?? 0;
  const plan: Plan = {
    rootSteps: validated.rootSteps.map((s, i): PlanStep => ({
      id: s.id,
      title: s.title,
      rationale: s.rationale,
      status: i === 0 ? 'active' : 'pending',
      children: s.children?.map((c) => ({
        id: c.id,
        title: c.title,
        rationale: c.rationale,
        status: 'pending' as const,
      })),
    })),
    revision: priorRevision + 1,
    generatedAt: Date.now(),
    notes: validated.notes,
  };

  return {
    ok: true,
    plan,
    successCriteria: validated.successCriteria,
    promptTokens,
    genTokens,
    retried,
  };
}

/**
 * Permissive JSON extractor — tries direct parse first, then a balanced-
 * brace scan to extract the first valid `{...}` object even if the model
 * wrapped it in prose or fences. Throws if no valid object can be parsed.
 */
export function parseJSONPermissive(s: string): unknown {
  const trimmed = s.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const first = trimmed.indexOf('{');
  if (first < 0) throw new Error('no { in output');
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = first; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        return JSON.parse(trimmed.slice(first, i + 1));
      }
    }
  }
  throw new Error('unbalanced JSON braces');
}
