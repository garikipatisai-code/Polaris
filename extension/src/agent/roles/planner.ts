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
import type { OllamaClient } from '../../background/ollama';
import type { ToolRegistry } from '../tools';
import type { AgentStateHot, Plan, PlanStep } from '../../shared/agent_types';
import { plannerSystemPrompt } from '../prompts/planner';
import { approxTokens, BUDGETS } from '../budget';
import * as store from '../state_store';

export interface PlannerInput {
  state: AgentStateHot;
  registry: ToolRegistry;
  client: OllamaClient;
  model: string;
  signal?: AbortSignal;
  isInitial: boolean;
  replanHint?: string;
  /** Whether to enable Qwen's thinking mode for this Planner call. */
  thinkingMode: boolean;
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

  // First attempt — thinking per setting.
  let response = await client.chatOnce({
    model,
    messages: [{ role: 'system', content: systemPrompt }],
    format: 'json',
    think: thinkingMode,
    signal,
  });
  let promptTokens = response.prompt_eval_count ?? estimatedPromptTokens;
  let genTokens = response.eval_count ?? 0;
  let content = response.message?.content ?? '';
  let parsed: unknown;
  let retried = false;

  try {
    parsed = parseJSONPermissive(content);
  } catch {
    // Retry once — thinking OFF, terser nudge.
    retried = true;
    response = await client.chatOnce({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'system',
          content:
            'Your previous output was not valid JSON. Output ONLY a single JSON object, ' +
            'no prose, no markdown fences, no leading or trailing text.',
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
