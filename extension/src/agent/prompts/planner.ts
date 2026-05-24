// Planner role system-prompt template.
//
// Thinking ON (deliberation pays off because Planner runs rarely).
// Output via `format: "json"` string mode (100% reliable per probe data;
// `format:<schema>` is broken on qwen35).
//
// The Planner is the only role permitted to emit the *initial* success
// criteria. After that, it omits them — the criteria become part of the
// immutable goal envelope that subsequent Planner calls (replans) read
// but cannot rewrite.

import type { Plan, Finding } from '../../shared/agent_types';

export interface PlannerPromptInput {
  goal: string;
  successCriteria: string[];
  currentPlan: Plan | null;
  findings: Finding[];
  toolIndex: { name: string; description: string }[];
  replanHint?: string;
  isInitial: boolean;
}

export function plannerSystemPrompt(input: PlannerPromptInput): string {
  const criteriaBlock = input.successCriteria.length === 0
    ? '(none yet — derive from the goal in this plan)'
    : input.successCriteria.map((c) => `- ${c}`).join('\n');

  const planBlock = input.currentPlan && input.currentPlan.rootSteps.length > 0
    ? renderPlan(input.currentPlan)
    : '(no plan yet — produce the initial one)';

  const findingsBlock = input.findings.length === 0
    ? '(none yet)'
    : input.findings
        .slice(0, 15)
        .map((f) => `- ${f.key}: ${f.value}`)
        .join('\n');

  const toolsBlock = input.toolIndex
    .map((t) => `- ${t.name}: ${t.description}`)
    .join('\n');

  const replanBlock = input.replanHint
    ? `\nREPLAN HINT (why the previous plan needs revision):\n${input.replanHint}\n`
    : '';

  const criteriaInstruction = input.isInitial
    ? 'Include 2–5 successCriteria — concrete bullets that, when all true, mean the goal is achieved.'
    : 'Omit "successCriteria" — they are already set and immutable.';

  return `You are the PLANNER for Polaris, a focused local browser agent.

GOAL (verbatim, never restate in titles, never modify):
  "${input.goal}"

EXISTING SUCCESS CRITERIA:
${criteriaBlock}

CURRENT PLAN:
${planBlock}

KNOWN FINDINGS:
${findingsBlock}

AVAILABLE TOOLS (the Executor calls these, not you):
${toolsBlock}
${replanBlock}
YOUR JOB:
Produce a refined hierarchical plan for achieving the goal. Each step must be:
- a short action-oriented title (≤12 words)
- optionally a one-line rationale (≤30 words)
- at most ONE level of nesting (children)
- with a stable id like "s1", "s2", "s2.1"

${criteriaInstruction}

Do NOT execute tools yourself. Do NOT include prose or markdown fences
outside the JSON.

Output ONLY a single JSON object matching this exact shape:
{
  "successCriteria": ["criterion 1", "criterion 2"],
  "rootSteps": [
    {"id": "s1", "title": "...", "rationale": "..."},
    {"id": "s2", "title": "...", "children": [{"id": "s2.1", "title": "..."}]}
  ],
  "notes": "≤30 words on what's in this plan and why"
}`;
}

function renderPlan(plan: Plan): string {
  if (plan.rootSteps.length === 0) return '(empty)';
  const lines: string[] = [];
  for (const s of plan.rootSteps) {
    lines.push(`${s.id} [${s.status}] ${s.title}${s.rationale ? ` — ${s.rationale}` : ''}`);
    if (s.children) {
      for (const c of s.children) {
        lines.push(`  ${c.id} [${c.status}] ${c.title}`);
      }
    }
  }
  lines.push(`(revision ${plan.revision})`);
  return lines.join('\n');
}
