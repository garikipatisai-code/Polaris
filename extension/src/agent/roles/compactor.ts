// Compactor role.
//
// Pure transform: takes the full scratchpad for a task plus existing
// finding keys, returns a list of new findings to persist. The scratch
// entries are then deleted by the orchestrator (the orchestrator owns
// that transactional contract, not the role).
//
// Thinking OFF — it's a transform, not a decision; we want it fast and
// deterministic. format:"json" string mode. One retry on parse failure.

import { z } from 'zod';
import type { OllamaClient } from '../../background/ollama';
import type { ScratchEntry, FindingKind } from '../../shared/agent_types';
import { compactorSystemPrompt } from '../prompts/compactor';
import { parseJSONPermissive } from './planner';
import { approxTokens, BUDGETS } from '../budget';

export interface CompactorInput {
  goal: string;
  scratchEntries: ScratchEntry[];
  existingKeys: string[];
  client: OllamaClient;
  model: string;
  signal?: AbortSignal;
}

export interface CompactorFinding {
  kind: FindingKind;
  key: string;
  value: string;
  evidence?: string;
}

export interface CompactorOutput {
  ok: boolean;
  findings?: CompactorFinding[];
  error?: string;
  promptTokens: number;
  genTokens: number;
  retried: boolean;
}

const FindingItemSchema = z.object({
  kind: z.enum(['fact', 'observation', 'reflection', 'sub-answer']),
  key: z.string().min(1).max(80),
  value: z.string().min(1).max(500),
  evidence: z.string().max(120).optional(),
});

const CompactorResponseSchema = z.object({
  findings: z.array(FindingItemSchema).max(50),
});

export async function runCompactor(input: CompactorInput): Promise<CompactorOutput> {
  const { goal, scratchEntries, existingKeys, client, model, signal } = input;

  const systemPrompt = compactorSystemPrompt({ goal, scratchEntries, existingKeys });
  const estimated = approxTokens(systemPrompt);
  if (estimated > BUDGETS.compactor) {
    return {
      ok: false,
      error: `compactor prompt ${estimated}t exceeds budget ${BUDGETS.compactor}t`,
      promptTokens: 0,
      genTokens: 0,
      retried: false,
    };
  }

  let response = await client.chatOnce({
    model,
    messages: [{ role: 'system', content: systemPrompt }],
    format: 'json',
    think: false,
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
            'Your previous output was not valid JSON. Output ONLY a single JSON object {"findings": [...]}.',
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
        error: `compactor output not parseable after retry: ${(e2 as Error).message}`,
        promptTokens,
        genTokens,
        retried,
      };
    }
  }

  let validated: z.infer<typeof CompactorResponseSchema>;
  try {
    validated = CompactorResponseSchema.parse(parsed);
  } catch (e) {
    return {
      ok: false,
      error: `compactor output schema violation: ${(e as Error).message.slice(0, 200)}`,
      promptTokens,
      genTokens,
      retried,
    };
  }

  return {
    ok: true,
    findings: validated.findings.map((f) => ({
      kind: f.kind,
      key: f.key,
      value: f.value,
      evidence: f.evidence,
    })),
    promptTokens,
    genTokens,
    retried,
  };
}
