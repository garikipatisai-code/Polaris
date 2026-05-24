// Evaluator role system-prompt template.
//
// Reads goal + success criteria + findings + (optionally) the Executor's
// proposed finish summary, and returns a verdict: done | continue | replan
// | abort. Thinking ON by default — verdicts are load-bearing.

import type { Plan, Finding, ScratchEntry } from '../../shared/agent_types';

export interface EvaluatorPromptInput {
  goal: string;
  successCriteria: string[];
  plan: Plan;
  findings: Finding[];
  scratchTail: ScratchEntry[];
  pendingFinishSummary: string | null;
}

export function evaluatorSystemPrompt(input: EvaluatorPromptInput): string {
  const criteriaBlock = input.successCriteria.length === 0
    ? '(none listed — judge against the goal text)'
    : input.successCriteria.map((c) => `- ${c}`).join('\n');

  const planBlock = input.plan.rootSteps.length === 0
    ? '(no plan)'
    : input.plan.rootSteps.map(renderPlanStep).join('\n') + `\n(revision ${input.plan.revision})`;

  const findingsBlock = input.findings.length === 0
    ? '(none yet)'
    : input.findings.slice(0, 30).map((f) => `- ${f.key}: ${f.value}`).join('\n');

  const scratchBlock = input.scratchTail.length === 0
    ? '(no recent actions)'
    : input.scratchTail.map(compactScratch).join('\n');

  const finishBlock = input.pendingFinishSummary
    ? `EXECUTOR HAS PROPOSED THIS FINAL ANSWER (you decide whether to accept):\n  "${input.pendingFinishSummary}"\n`
    : '';

  return `You are the EVALUATOR for Polaris.

GOAL (verbatim, immutable):
  "${input.goal}"

SUCCESS CRITERIA:
${criteriaBlock}

CURRENT PLAN:
${planBlock}

RECENT ACTIONS (oldest first, last first):
${scratchBlock}

CURRENT FINDINGS:
${findingsBlock}

${finishBlock}YOUR JOB:
Look at what's been done and decide ONE of:
- "done": every success criterion is supported by findings or recent actions.
   Provide finalAnswer (≤1000 chars) — this is what the user will see.
- "continue": progress is healthy; the Executor should keep going on the plan.
- "replan": findings invalidate the plan, the plan was wrong, or arithmetic
   /answer in the proposed finish is incorrect. Provide replanHint
   (≤200 chars) explaining the issue concretely.
- "abort": goal is unreachable (contradictions, no candidates, blocked).
   Provide reason.

Be strict: if the Executor proposed a final answer but it does NOT match
findings (e.g., math wrong, missed inputs, fabricated steps), return
"replan" with a concrete hint — DO NOT just pass it through as "done".

Output ONLY a single JSON object matching this exact shape:
{
  "verdict": "done" | "continue" | "replan" | "abort",
  "reason": "≤200 chars",
  "finalAnswer": "only when verdict='done'",
  "replanHint": "only when verdict='replan'"
}`;
}

function renderPlanStep(s: Plan['rootSteps'][number]): string {
  const main = `${s.id} [${s.status}] ${s.title}`;
  const children = s.children?.map((c) => `  ${c.id} [${c.status}] ${c.title}`).join('\n') ?? '';
  return main + (children ? '\n' + children : '');
}

function compactScratch(e: ScratchEntry): string {
  const p = e.payload as Record<string, unknown> | null;
  switch (e.kind) {
    case 'tool_call': {
      const fn = (p as { function?: { name?: string; arguments?: unknown } } | null)?.function;
      const args = fn?.arguments ? JSON.stringify(fn.arguments) : '{}';
      return `T${e.seq}: call ${fn?.name ?? '?'}(${truncate(args, 100)})`;
    }
    case 'tool_result': {
      const r = p as { ok?: boolean; data?: unknown; error?: string } | null;
      return r?.ok
        ? `T${e.seq}: → ${truncate(JSON.stringify(r.data ?? {}), 100)}`
        : `T${e.seq}: → ERROR ${truncate(r?.error ?? '?', 100)}`;
    }
    default:
      return `T${e.seq}: ${e.kind}`;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
