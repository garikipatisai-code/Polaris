// Executor role system prompt template.
//
// Anchoring pattern: GOAL is the first content the model sees, verbatim,
// repeated in every turn. Literature (research-notes §1) shows small
// models lose attention to the goal when it moves around or gets
// summarized. Burning ~60 tokens per turn on verbatim goal re-injection
// is the architecture's load-bearing thesis.

import type { ScratchEntry, Finding } from '../../shared/agent_types';

export interface ExecutorPromptInput {
  goal: string;
  step: { id?: string; title: string; rationale?: string } | null;
  relevantFindings: Finding[];
  scratchTail: ScratchEntry[];
  availableToolNames: string[];
}

export function executorSystemPrompt(input: ExecutorPromptInput): string {
  const findingsBlock = input.relevantFindings.length === 0
    ? '(none yet)'
    : input.relevantFindings.slice(0, 8).map((f) => `- ${f.key}: ${f.value}`).join('\n');

  const scratchBlock = input.scratchTail.length === 0
    ? '(no prior actions)'
    : input.scratchTail.map(compactScratch).join('\n');

  const stepBlock = input.step
    ? `CURRENT STEP: ${input.step.title}${input.step.rationale ? `\nWHY: ${input.step.rationale}` : ''}`
    : 'CURRENT STEP: (no plan — improvise toward the goal)';

  return `You are the EXECUTOR for Polaris, a focused local browser agent.

GOAL (verbatim, never modify or restate in your output):
  "${input.goal}"

${stepBlock}

RELEVANT FINDINGS:
${findingsBlock}

RECENT ACTIONS (oldest first, most recent last):
${scratchBlock}

AVAILABLE TOOLS: ${input.availableToolNames.join(', ')}.

RULES:
- Call exactly ONE tool per turn. Never two.
- If the current step is satisfied by what you already know, call \`finish\`
  with a final summary.
- Never reply in prose. Never invent tool names. Never restate the goal.
- If you have already called a tool with the same arguments recently and
  it produced an error, try a different tool or different arguments.`;
}

function compactScratch(e: ScratchEntry): string {
  const p = e.payload as Record<string, unknown> | null;
  switch (e.kind) {
    case 'tool_call': {
      const fn = (p as { function?: { name?: string; arguments?: unknown } } | null)?.function;
      const argsStr = fn?.arguments ? JSON.stringify(fn.arguments) : '{}';
      return `T${e.seq}: call ${fn?.name ?? '?'}(${truncate(argsStr, 80)})`;
    }
    case 'tool_result': {
      const r = p as { ok?: boolean; data?: unknown; error?: string } | null;
      if (r?.ok) {
        return `T${e.seq}: → ${truncate(JSON.stringify(r.data ?? {}), 80)}`;
      }
      return `T${e.seq}: → ERROR ${truncate(r?.error ?? '?', 80)}`;
    }
    case 'role_msg': {
      const m = p as { role?: string; content?: string } | null;
      return `T${e.seq}: ${m?.role ?? '?'}: ${truncate(m?.content ?? '', 80)}`;
    }
    case 'thinking':
      return `T${e.seq}: (thinking trace omitted)`;
    default:
      return `T${e.seq}: ${e.kind}`;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** Used by the empty-tool-call retry path to nudge the model harder. */
export function executorRetryNudge(toolNames: string[]): string {
  return (
    `Your previous response did not call a tool. ` +
    `You MUST call exactly ONE tool from this list, with valid arguments: ` +
    `${toolNames.join(', ')}. ` +
    `Output ONLY the tool call — no prose, no thinking, no markdown.`
  );
}
