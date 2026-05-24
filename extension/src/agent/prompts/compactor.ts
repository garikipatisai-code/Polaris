// Compactor role system-prompt template.
//
// Pure transform: scratchpad trace → structured findings. Thinking OFF
// (it's not a decision, it's a summarizer). Uses format:"json" string
// mode for reliable structured output.
//
// Crucially: must NOT discard load-bearing context. The trace is going
// to be deleted from the scratchpad after this runs — anything not
// preserved as a finding is lost.

import type { ScratchEntry } from '../../shared/agent_types';

export interface CompactorPromptInput {
  goal: string;
  scratchEntries: ScratchEntry[];
  existingKeys: string[];
}

export function compactorSystemPrompt(input: CompactorPromptInput): string {
  const traceBlock = input.scratchEntries.length === 0
    ? '(empty)'
    : input.scratchEntries.map(renderEntry).join('\n');

  const existingBlock = input.existingKeys.length === 0
    ? '(none)'
    : input.existingKeys.map((k) => `- ${k}`).join('\n');

  return `You are the COMPACTOR for Polaris.

GOAL (verbatim):
  "${input.goal}"

EXISTING FINDING KEYS (do NOT duplicate — use different key names):
${existingBlock}

SCRATCHPAD TRACE (oldest first, this is what you must compress):
${traceBlock}

YOUR JOB:
Extract meaningful facts, observations, and sub-answers from the trace
above into structured atomic findings. The trace will be DELETED after
this runs — anything not captured as a finding is permanently lost.

Each finding is one structured pair:
- key:   snake_case label, ≤80 chars, unique (not in existing keys above)
- value: dense factual text, ≤300 chars, self-contained
- kind:  "fact" (objective), "observation" (derived), or "sub-answer"
         (partial answer toward the goal)
- evidence: optional pointer like "seq:N" referencing the trace entry

Skip trivia. Skip duplicates. Do NOT include the goal text itself.
Prefer fewer, denser findings over many trivial ones.

Output ONLY a single JSON object matching this exact shape:
{
  "findings": [
    {"kind": "fact", "key": "amazon_price_sony_xm5", "value": "$298 + free shipping", "evidence": "seq:7"},
    {"kind": "sub-answer", "key": "best_price_so_far", "value": "Amazon at $298 total"}
  ]
}

If there's truly nothing worth preserving, output {"findings": []}.`;
}

function renderEntry(e: ScratchEntry): string {
  const p = e.payload as Record<string, unknown> | null;
  switch (e.kind) {
    case 'tool_call': {
      const fn = (p as { function?: { name?: string; arguments?: unknown } } | null)?.function;
      const args = fn?.arguments ? JSON.stringify(fn.arguments) : '{}';
      return `T${e.seq} call: ${fn?.name ?? '?'}(${truncate(args, 200)})`;
    }
    case 'tool_result': {
      const r = p as { ok?: boolean; data?: unknown; error?: string } | null;
      return r?.ok
        ? `T${e.seq} result: ${truncate(JSON.stringify(r.data ?? {}), 200)}`
        : `T${e.seq} ERROR: ${truncate(r?.error ?? '?', 200)}`;
    }
    case 'role_msg': {
      const m = p as { role?: string; content?: string } | null;
      return `T${e.seq} ${m?.role ?? '?'}: ${truncate(m?.content ?? '', 200)}`;
    }
    default:
      return `T${e.seq} ${e.kind}: ${truncate(JSON.stringify(p ?? {}), 100)}`;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
