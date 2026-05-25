# Stream 4 — Reasoning & Planning (Implementation Playbook)

## Overview

Polaris already implements the load-bearing skeleton: hierarchical Planner / Executor / Evaluator / Compactor with goal-anchored prompts, JSON-mode + Zod schemas, a circuit breaker, and a 14-tool registry. What is missing is the *reasoning fabric* that lets a 4B local model compete with cloud Comet/Perplexity — patterns that turn a brittle ReAct-equivalent into something that learns across tasks, recovers from failure, composes tools, and verifies its own answers.

This playbook is an M4/M5 work plan for that fabric. Constraints: Qwen3.5:4b on a P2200 5 GB box; thinking ON for Planner (~32 K) and Evaluator (~8 K), thinking OFF for Executor (~6 K); `format:<schema>` is broken (use `format:"json"` + permissive parser, or `tools` with one-retry); reasoning happens *between* model calls, not inside a mega-prompt.

**Tier-1 (M4 must-have):** Reflexion lessons (#1), micro-ReAct rationale (#2), tool-chain hints (#3), self-verification before DONE (#9), retrieval-augmented replan (#7). 2–4 days each, together they close the perceived gap with cloud agents on the shopping target.

**Tier-2 (M5 polish):** multi-source synthesis with citations (#4), comparison-table generation (#5), plan-revision diffs (#10).

**Tier-3 (deferred):** counterfactual reasoning (#6 — needs price-history dataset), full Voyager-style codegen skill compilation (#8 in scope as prompt-template macros, not as eval'd JS).

Reference repos: `~/Documents/Spike/Personal/Browser/refs/` doesn't exist on this Mac, so I cite by arxiv ID (Reflexion 2303.11366, ReAct 2210.03629, Voyager 2305.16291, CoVe 2309.11495, Self-Refine 2303.17651) and refer to file-level patterns from `noahshinn/reflexion`, `MineDojo/Voyager`, `letta-ai/letta`, `madaan/self-refine` by description. Linux-side Claude should `git clone` and verify.

---

## Feature 1: Reflexion — long-term lessons across task boundaries

### Recommendation

Add a **Reflexor role** plus a **`lessons` IDB store**. Fires on `phase=ABORTED` or `verdict=done` after >1 replan. Writes 1–3 short lesson sentences ("when shopping for X on retailer Y, prefer Z because…"). The Planner retrieves the top-K lessons by cosine similarity against the current goal text and surfaces them as a `LESSONS LEARNED FROM PRIOR TASKS` block between `KNOWN FINDINGS` and `AVAILABLE TOOLS` in `plannerSystemPrompt`. This is verbal feedback per Shinn et al. 2023 §3.2 — same pattern as `reflexion/agents/reflexion_agent.py`'s `memory: list[str]`, scoped by goal-embedding rather than task boundary.

### Trigger and schema

```ts
on TaskTerminate(phase): if (phase=='ABORTED' || (phase=='DONE' && breaker.totalReplans >= 1)) enqueueReflexor()

interface Lesson {
  id: string;                    // ULID, primary key
  ts: number;
  goalText: string;              // verbatim
  goalEmbedding: number[];       // 1024-d (mxbai-embed-large)
  embeddingModel?: string;       // sanity check
  outcome: 'aborted' | 'done_with_replan';
  retailer?: string; category?: string;
  text: string;                  // ≤300 chars, second-person
  triggers: string[];            // ≤5 keywords for non-embedding fallback
  evidence?: string;             // 'task:taskId' or 'finding:id'
  hits: number; dismissals: number;
  lastUsedAt: number | null;
}
```

Index `by-ts` only — vector search runs in-memory (≤500 lessons × 1024-d = ~2 MB, ~5 ms cosine). Eviction by Wilson lower bound `(hits + 1) / (hits + dismissals + 2)`.

### Retrieval

In `runPlanner`, before `plannerSystemPrompt`: `goalEmb = embed(state.goal.text); lessons = store.lessonsTopK(goalEmb, 5, minCosine=0.55)`. Embedding-failure fallback: keyword-overlap on `triggers[]` so Mac dev (no embed model) still works. Empty result is a no-op. Block header reads `LESSONS FROM PRIOR TASKS (consider but don't blindly follow)` — without this advisory framing a 4B model treats them as hard constraints and ignores live evidence.

### Reflexor prompt (sketch)

```
GOAL: "{goal}"
OUTCOME: {aborted|done_with_replan}  REPLANS: {n}  TRIPS: {trips}
FULL TRACE: {compacted findings + scratch tail, ≤2000 tokens}

YOUR JOB: Write 1–3 lessons (≤200 chars each), each:
- generalizable (NOT specific to this URL or SKU)
- actionable ("if X, prefer Y" or "avoid Z when W")
- second-person addressing a future agent
- backed by trace ("T:N" or finding key)

Output: { "lessons": [{ "text": "...", "triggers": ["shopping","amazon"], "evidence": "T:23" }] }
```

### Integration

`src/agent/roles/reflexor.ts` (mirror `compactor.ts`); IDB schema bump to v2 with `lessons` store; `state_store.ts` adds `appendLesson`, `lessonsTopK`, `recordLessonHit/Dismissal`; `orchestrator.ts:runUntilTerminal` finally block enqueues Reflexor synchronously (~2 s on Linux); `prompts/planner.ts` adds `lessons` input + section; new `embeddings.ts` with `cosine`. ~150 LOC.

### Risks

Stale lessons (90-day-old layout knowledge harms): surface `lesson.ts` to Planner; auto-dismiss when `hits/(hits+dismissals)<0.2 && (hits+dismissals)≥5`. Confirmation bias: cap at 3 per prompt; mark advisory; never let lessons block actions. Privacy: lessons are persisted user data; document in CLAUDE.md they MUST NOT leak to a future cloud mode without explicit consent.

### Open questions

Should Reflexion fire on smooth runs? No — degenerates into platitudes. Cross-task sharing of identical-goal-text lessons? Yes (the whole point). Lesson contradicts a finding mid-run? Finding wins (current evidence); future Reflexion may emit "stop trusting lesson L."

---

## Feature 2: Micro-ReAct in the Executor — `reason` field, not separate think turn

### Recommendation

Don't run full ReAct on the Executor — that violates CLAUDE.md §1 (no flat ReAct) and explodes the 6 K hot-path budget. Instead inject an optional `reason` arg into every tool's `parametersJSON` via a `withRationale` registry wrapper. The model writes a 1-sentence justification *as part of the tool call*; the orchestrator logs it; execute() ignores it. Same pattern as Anthropic Computer Use's `reasoning` field and browser-use's `thinking` parameter on actions.

```ts
function withRationale(handler: ToolHandler): ToolHandler {
  return { ...handler,
    argsSchema: handler.argsSchema.and(z.object({ reason: z.string().max(200).optional() })),
    parametersJSON: { ...handler.parametersJSON,
      properties: { ...handler.parametersJSON.properties,
        reason: { type:'string', maxLength:200, description:'1-sentence rationale.' }}}};
}
```

Executor system prompt gains: *"Include `reason` in every tool call: ≤200 chars explaining why this tool with these args is the right next action."* `compactScratch` prepends it: not just `T7: click({ref:42})` but `T7: click({ref:42}) — "the orange button labeled 'Add to cart' is the primary CTA"`.

### Why this works on a 4B model

ReAct's claim (arXiv:2210.03629 §4) is that interleaving thought+action raises tool-selection accuracy by forcing a hypothesis commit before arg binding. Original ReAct uses a *separate* `Thought:` line, costing a full extra inference. The reason-field gets ~80% of the benefit at ~10% of the cost: the model still writes the rationale (commit happens) but emits it in the same generation as the tool call. Self-Refine (arXiv:2303.17651) and the Reflection paper validate this — *writing* reasoning matters, not whether it's a separate round trip.

### Trade-offs

Cost: ~30–50 extra gen tokens per turn ≈ 1 s at 38 tok/s on Linux GPU. Executor budget is 6 K prompt + ~500 gen; lifts gen to ~550. Acceptable. Reliability: Qwen3.5:4b sometimes ignores optional fields; making it required for Planner-emitted chains (#3) but optional for raw calls keeps reliability. Prompt-injection: a hostile page could land malicious text in `reason`; the Compactor strips `reason` before persisting findings (it's a step-local artifact, not a finding).

### What NOT to do

Don't add a separate `think` tool call — full ReAct loop, 2 s/turn for negligible gain. Don't enable Qwen built-in thinking on the Executor — confirmed in CLAUDE.md §3 to blow latency. The reason-field is plain content, not Qwen-thinking-mode.

### Integration

`registry.ts`: `withRationale`, applied in `createDefaultRegistry`. `prompts/executor.ts`: rule + compact-view rendering. `roles/compactor.ts`: strip `reason` from tool-call payloads (noise for compaction). ~30 LOC.

### Risks / open questions

Verbose reasons: Zod max=200 + truncate(`…`). Reasoning gaslighting (model writes one rationale, calls a different thing): logged but not enforced — intentional, this is an audit trail not an oracle. Should the Evaluator read rationales? Yes for `triggeredByFinish=true` (the `finish` tool's reason is a soft self-justification worth sanity-checking).

---

## Feature 3: Tool composition — Planner-emitted tool chains

### Recommendation

Add `toolChain?: ToolChainHint[]` and `chainMode?: 'strict'|'advisory'` to each `PlanStep`. When the Planner *knows* the deterministic sequence (e.g., `search → tab.open(top) → aria.extract → product.extract → memory.write`), it lists the calls. The Executor walks the chain by default; only re-thinks when a chain entry's preconditions fail.

```ts
interface ToolChainHint {
  name: string;                            // tool name, must be in registry
  argsTemplate?: Record<string, unknown>;  // partial args; "${prev.0.url}" placeholders
  reason?: string;
  optional?: boolean;
}
```

In `runExecutor`, before model call: `idx = computeChainIndex(scratch, step.toolChain)` — count consecutive matching prefix calls; if `step.chainMode==='strict' && idx<chain.length`, execute `chain[idx]` directly (no model call). Mismatch resets idx to 0 and falls through. Strict mode skips the model entirely for chain-prefix calls — saves ~3 s and ~6 K prompt tokens per skipped turn.

### Argument templating

`${prev.N.field}` resolves from the *previous tool's output* via JSONPath: `tab.open({url: "${prev.0.url}"})` reads from chain entry 0's result. Implement in `src/agent/chain.ts` reading scratchpad.

### Why this works (and the literature)

Voyager (arXiv:2305.16291) ships *generated JS skills*, but the underlying insight generalizes: **for retailers and other regular sites, the high-leverage tool sequences are identical across tasks**. Generating JS is a Voyager-specific choice for Minecraft's API. Browser equivalent: a sequence of registered tool calls — no codegen, no eval. AgentTrek (arXiv:2412.09605) does this offline; we do it inline at planning time.

### Macros (skill compilation lite — see #8)

Persistent macros in IDB: a Planner that solved a goal-shape twice persists the chain as a named macro keyed by goal embedding. Next time a goal scores cosine ≥ 0.7 against a macro, the Planner emits the macro chain in `step.toolChain` without re-deriving. Voyager-equivalent skill replay via prompt templates (no codegen).

### Integration

`agent_types.ts`: extend `PlanStep`. `prompts/planner.ts`: emit chains for known patterns with examples. `orchestrator.ts:executeOneStep`: branch on chainMode. New `chain.ts`: `computeChainIndex`, `resolveTemplate`. New IDB store `macros` (v3). `roles/macro_recorder.ts`: runs after `verdict=done`. ~250 LOC.

### Risks

Brittle chains: default `chainMode='advisory'`; `'strict'` only for macros with ≥3 successCount and zero failures in last 5 attempts. Wrong abstraction level (laptop vs shoes vs cross-retailer): trigger keywords + retailer scoping in the macro keep these separate. Pruning: 90 days untouched → retire.

---

## Feature 4: Multi-source synthesis with citations

### Recommendation

**Map-reduce summarization with required citation tags.** Map: each visited page → Compactor-produced findings tagged `source=i, url=URL`. Reduce: a Synthesizer prompt receives the source list `[1] URL [2] URL …` plus all findings, emits a final answer with inline `[1][2]` markers. This is Perplexity's public design. Refine summarization (accumulate iteratively) was rejected — drifts on small models, garbles citation order.

### Required-citation prompting

```
EVERY factual claim MUST be followed by [N] referencing SOURCES above.
A claim with no citation is forbidden — re-emit with citation, or omit.
If two sources disagree, mention both: "X says $999 [1] but Y says $1049 [2]."
NEVER fabricate a citation number. Only use numbers in SOURCES above.
```

Runtime validator: parse `\[\d+\]` tags, fail on out-of-range. Re-prompt once with `"You used [4] but only [1]-[3] exist."` and stop.

### Token economy

4B with 8 K Evaluator budget comfortably ingests ~30 findings × 200 chars each (~1 600 tokens). Page count × findings/page must stay under that — each page contributes ~3–6 findings post-Compactor. Practical ceiling: 5–10 sources per synthesis. For more, two-level reduce: synthesize per-cluster, then synthesize cluster summaries.

### Integration

`roles/synthesizer.ts`. New special tool `synthesize` (like `finish`). `prompts/synthesizer.ts` with citation rules. Add `Finding.sourceUrl?: string` for citation rendering. ~200 LOC.

### Risks / open questions

Citation hallucination: validator + 1 re-prompt; if still bad → `replan` with hint "synthesizer fabricated citations." Source-set mutation mid-task: pin citation numbers at synthesis time (snapshot the source list). Where do citations link? URL in user-facing answer; finding-id in audit log.

---

## Feature 5: Comparison-table generation

### Recommendation

**Schema-coerced JSON via tool calls** (not `format:<schema>` — broken). Define `compare.table` whose `parametersJSON` IS the table schema. Ollama's tool-call grammar enforces shape.

```ts
const compareTableTool: ToolHandler = {
  name: 'compare.table',
  argsSchema: z.object({
    columns: z.array(z.object({ key: z.string(), label: z.string(), unit: z.string().optional() })).min(2).max(8),
    rows: z.array(z.object({
      name: z.string(),
      cells: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
    })).min(2).max(10),
    notes: z.string().max(500).optional(),
  }),
  // execute() validates every row has every declared column key
};
```

Tool-call args ARE schema-validated by Ollama (part of chat-template surface) — empirically ~80% first-try; existing empty-tool-call retry handles the rest.

### Few-shot consistency

Add a "TARGET TABLE SHAPE" hint at planning time:
```
columns: ['model','price_usd','weight_g','battery_h']
rows: 3 (Pixel 8, iPhone 15, Galaxy S24)
```
This pins the shape; without it, a 4B model emits `{price:'$999'}` for one row and `{price_usd:999}` for another.

### Unit normalization

Schema's `unit?` lets the Planner pre-declare units. Executor prompt: *"Convert all values to declared unit. If you cannot convert, emit `null` and add a `notes` line."* More reliable than asking the Compactor to normalize after.

### Integration

`tools/compare.ts`. New finding kind `'comparison'` (or reuse `'sub-answer'`). Side panel renders `comparison` findings as actual HTML tables. ~80 LOC + UI.

### Risks / open questions

Sparse cells: schema permits `null`; prompt says "emit null rather than fabricate." Exploding columns: Zod max columns≤8 rows≤10. Mobile-tall? Add `orientation:'row'|'column'`.

---

## Feature 6: Counterfactual reasoning — DEFERRED

Use cases require external data Polaris doesn't have: price-history counterfactuals need a price-history store; decision counterfactuals need high-quality reasoning beyond 4B. Phase-2 path: build price-history finding store via repeated visits; add `counterfactual.compare` tool that REFUSES if history store has <3 observations; re-use comparison-table pattern (#5) with columns `current / 30d-low / 30d-high`. **Hard guardrail:** the counterfactual tool MUST fail-closed on missing history — otherwise a 4B model invents numbers. Document as future work; skip for v1.

---

## Feature 7: Long-context retrieval-augmented planning

### Recommendation

On replan, surface this-task findings via embedding similarity, not just recency. Today `runPlanner` reads `findingsByRecency(taskId, 20)` — a flat tail. Fails for long sessions where finding 50+ buries finding 7's "Walmart was OOS for this SKU."

Add `findingsByRelevance(taskId, queryEmb, k)`: read all findings (≤500 typical), filter to those with embeddings, compute cosine, sort, return top-k. Findings are embedded **lazily on Compactor exit** (Executor hot-path can't afford a 2 s embed); embedding persisted on Finding row.

### Threading through `runPlanner`

```ts
const replanQuery = replanHint ?? state.goal.text;  // initial: goal; replan: hint
const queryEmb = await embed(replanQuery);
const relevant = queryEmb ? await store.findingsByRelevance(state.taskId, queryEmb, 20)
                          : await store.findingsByRecency(state.taskId, 20);
const recent = await store.findingsByRecency(state.taskId, 5);
const findings = mergeUnique([...relevant, ...recent], 25);
```

Recency-keep of 5 prevents stale-but-similar findings displacing critical recent ones.

### Why this works

Letta (`letta-ai/letta`) does exactly this for archival memory: embedding-match against working set + archival. The Planner's "what should I plan now" is structurally the same query — replan-hint as query, prior findings as corpus. **Recency is a poor proxy for relevance once a task phases through multiple sub-goals.**

### Integration

`embeddings.ts` (new): `embed`, `cosine`, `mergeUnique`. `state_store.ts`: `findingsByRelevance`. `roles/compactor.ts`: embed each new finding before persisting (~2 s on Linux GPU; acceptable for batch op). `runPlanner`: swap retrieval. ~150 LOC.

### Risks

Embed model unavailable: fall back to `findingsByRecency` (current). Embedding drift: store `embeddingModel` on each Finding; mismatch → treat as missing.

### Open questions

Embed lessons too (Feature 1)? Yes — same mechanism, same store; #1+#7 share infra.

---

## Feature 8: Skill compilation — record-and-replay macros (prompt-template, NOT codegen)

### Recommendation

See Feature 3 for the chain mechanism. This is the *lifecycle* on top.

```
on TaskTerminate(verdict='done'):
  candidate = extractToolChain(scratch)        // drop error/retry pairs
  if candidate.length >= 3 && length <= 8:
    if existing = findSimilar(candidate, goalEmb): existing.successCount++
    else: persistMacro(candidate, goalEmb, derivedTriggers)
```

`extractToolChain` walks scratchpad emitting canonical successful path. `derivedTriggers` heuristic: split goal text on whitespace, take words ≥4 chars not in stopwords. Quick and dirty but seeds retrieval.

### Replay

In `runPlanner` for new tasks: `macros = store.macrosTopK(goalEmb, 3); eligible = filter(successCount≥3 && failureCount==0 && cosine≥0.7)`. Surface highest-scoring macro as a strong hint in the planner prompt. Planner can adopt (emit `step.toolChain`), modify, or reject. **Macros are proposed, not forced.** Strict-mode skip (Feature 3) only after Planner explicitly opts in.

### Why prompt-template, not codegen

(1) **Security:** Voyager eval's generated JS at runtime; in MV3 SW, CSP forbids `eval`/`new Function`. (2) **Reliability:** Qwen3.5:4b is not a great coder; emitting a tool list is much easier than correct JS. (3) **Auditability:** a list of tool calls is reviewable; generated functions aren't. (4) **MV3 compliance:** templates dodge entirely.

### Integration

Builds on Feature 3 (~100 LOC additional). Macro pruning: `lastSuccessAt < now - 60d` → demote to `chainMode='advisory'` only.

### Risks / open questions

Macro freshness (6-month-old before Amazon redesign): refuse strict on macros older than 60d. Macro pollution (a 20-turn success isn't a clean pattern): only persist when path was ≤8 tool calls. Export/share for community library? Schema supports import/export from day 1; UI hidden in v1.

---

## Feature 9: Self-verification before DONE — Chain-of-Verification

### Recommendation

Before `EXECUTING → DONE`, run a **Verifier** sub-step: ask the model to generate verification questions about the proposed answer, answer them strictly from findings, and report mismatches. This is CoVe (arXiv:2309.11495). Current Evaluator does *some* of this but it's a single-shot judgment with thinking ON; CoVe decomposes.

```
GOAL, SUCCESS CRITERIA, FINDINGS, PROPOSED FINAL ANSWER

YOUR JOB:
1. Generate 3-5 verification questions (e.g. "Is price in USD?" "In stock at cited retailer?")
2. Answer each USING ONLY FINDINGS. Cannot-answer = verification failure.
3. List every mismatch.

Output: { "questions":[...], "answers":[{"q":"...","answer":"...","fromFindings":bool}],
          "mismatches":[...], "verdict":"consistent"|"inconsistent" }
```

`verdict='consistent'` → proceed to DONE. `'inconsistent'` → return Evaluator verdict to `replan` with hint listing mismatches.

### Why CoVe over self-consistency

Self-consistency (Wang et al. 2022) is sample-N-and-vote. On 4B, N×latency for marginal gain — model isn't diverse enough across samples. CoVe is one extra inference with thinking ON, ~3 s on Linux. Acceptable for the once-per-task DONE check.

### Where it fits

In `runEvaluation`, when `result.verdict==='done' && triggeredByFinish===true`, run Verifier. Periodic Evaluator skips Verifier — too expensive at every checkpoint. UI shows "verifying answer…" so the ~3 s isn't perceived as hung.

### Integration

`roles/verifier.ts` mirroring evaluator structure. New event type `'verification'` for UI. ~120 LOC.

### Risks / open questions

Over-zealous (correct→inconsistent due to bad question): cap to 1 verifier pass (no re-verify after replan); failures count toward breaker `totalReplans`. Should it gate on a Planner-emitted `complexity` hint (skip for trivial goals)? Possible; for v1 always-on for safety.

---

## Feature 10: Plan revision via diffs

### Recommendation

On replan, Planner emits a **diff** instead of a full plan. Reduces token churn (~300 tokens vs ~1 500), preserves stable step IDs (good for breaker progress tracking), Planner explains *what changed*.

```ts
const PlanDiffSchema = z.object({
  delete: z.array(z.string()).optional(),
  add: z.array(RootStepSchema.extend({ after: z.string().optional() })).optional(),
  modify: z.array(z.object({ id: z.string(), title: z.string().optional(), rationale: z.string().optional() })).optional(),
  rationale: z.string().min(50).max(500),
});
```

Orchestrator validates: delete/modify targets exist; add IDs don't collide; resulting plan has ≥1 pending step. New IDs generated server-side as `s{revision}-{n}`.

### Fallback

Planner emits diff OR full plan, distinguished by output shape:

```
PLANNER PROMPT (replan path):
Either:
  (a) diff: {"delete":[...],"add":[...],"modify":[...]} — preferred when most steps remain valid
  (b) full plan: {"rootSteps":[...]} — only when previous plan was fundamentally wrong
Prefer (a). Pick (b) only if more than half of existing steps need to change.
```

### Integration

`roles/planner.ts`: accept either shape; `applyPlanDiff(currentPlan, diff)` helper. `prompts/planner.ts`: instruct on the choice. New tests for diff path. ~150 LOC.

### Risks / open questions

Underspecified diffs: rationale ≥50 chars enforced; if rationale doesn't justify, retry with full-plan instructions. Track diff history for telemetry: emit a `'plan_diff'` event with deltas — useful for debugging replan loops.

---

## Cross-cutting: prompt engineering on a 4B model

**Works:** verbatim goal at prompt top (~60 tokens, non-negotiable — attention drifts past 3 K otherwise); `[system, user-anchor]` pattern (flips structured-output mode, M2.7.2 retro); tool calls beat schema mode (~80% vs 0%); `format:"json"` + permissive parser (handles markdown fences without retries 90% of the time); one example > zero examples; truncated replay (500-char) on retry.

**Doesn't:** multi-step instructions in one prompt (model picks 1 of 3 — let the loop drive sequencing); negative instructions ("don't include markdown" → markdown; positive "Output ONLY a JSON object"); long bullet lists (>10 degrades adherence; the model picks 3–5); "Let's think step by step" (2 K tokens of meandering — use Qwen `think:true` instead, controllable); self-consistency sample-N-vote (4B isn't diverse enough); few-shot >2 examples (3 confuses Qwen3.5:4b — finds wrong patterns; one or two specific outperforms five generic).

**Hard probe constraints:** vision <50 KB hallucinates, ≥1200 px verifies; tool-call ~80%, retry on empty; long-context curve 4 K=14 s, 32 K=130 s — keep interactive roles under 32 K; `keep_alive:'10m'` cuts cold-start ~3 s → ~0.1 s.

---

## Cross-cutting: lesson + skill IDB schemas

IDB v2 adds `lessons`; v3 adds `macros`. Both are upgrade migrations.

```ts
// 'lessons' (v2): see Feature 1 schema.
//   Indexes: by-ts. Vector search in-memory.
//   Eviction: count>500 → delete by lowest Wilson lower-bound.

// 'macros' (v3):
interface Macro {
  id: string; ts: number; name: string;        // 'shop_amazon_for_product'
  triggers: string[]; goalEmbedding: number[]; embeddingModel?: string; retailer?: string;
  steps: Array<{ name: string; argsTemplate?: object; reason?: string; optional?: boolean }>;
  successCount: number; failureCount: number; lastSuccessAt: number; averageDurationMs?: number;
}
//   Indexes: by-ts, by-retailer.
//   Pruning: lastSuccessAt < now-60d → demote (chainMode='advisory' only).

// Findings (existing) gain:
//   embedding?: number[] | null; embeddingModel?: string; sourceUrl?: string;
```

Steady-state IDB footprint: ~500 lessons × ~8 KB = 4 MB; ~50 macros × 4 KB = 200 KB; findings already exist. Well within IDB per-origin quota (typically 60% of disk).

---

## Implementation order

Three sprints, ~1 week each, parallelizable across 2–3 sessions per sprint.

**Sprint 1 — Memory infra (M4.1):** embeddings + cosine + IDB v2 + `lessons` store + `findingsByRelevance` (#1 and #7 share infra). Lazy embedding on Compactor exit. Reflexor role + trigger + lesson surfacing in Planner prompt.

**Sprint 2 — Reasoning patterns (M4.2):** `reason` field on every tool (#2, ~30 LOC). Tool chains in PlanStep + chain executor + Planner prompt for emitting chains (#3). Verifier role + DONE-boundary CoVe (#9). Plan diffs on replan (#10).

**Sprint 3 — Polish (M5):** macro recording + replay (#8, builds on #3). Synthesizer + citation tags (#4). `compare.table` tool (#5). Deferred: #6.

Total: ~1 200 LOC + tests + UI work + 2 IDB schema bumps. Throughout: keep CLAUDE.md updated, never break the existing 231 mock tests, every new role gets fast-tier integration coverage.

---

## Open questions for the user

1. **Privacy on lessons.** Local persistence is fine for v1; document the policy. Lessons sync across machines? My recommendation: no — keep per-device.
2. **Macro auto-persistence vs explicit consent.** Clean ≤8-step success → silently persist macro, or prompt? Silent + a "your skills" panel for review/delete is friendliest.
3. **Embedding model bundling.** `mxbai-embed-large` is on Linux but not Mac. Detect-and-fallback (recency on Mac, embedding on Linux) or require? Recommend detect-and-fallback so dev stays smooth.
4. **Reflexor latency.** Synchronous adds ~5 s to ABORTED transition. Run in `runInBackground` after panel resolves? Recommend synchronous v1 (simpler error model); revisit if user complains.
5. **Verifier opt-out.** For super-simple tasks ("cheapest X"), CoVe at DONE feels like ceremony. Planner-emitted `complexity` hint gating verification, or always-on? Recommend always-on for safety; revisit.
6. **Macro export/share.** v2 question; flag now: schema should support import/export from day 1 even if UI hidden, so we don't paint into a corner.
7. **Counterfactual price-history.** #6 is deferred but the *data* (price observations) accumulates naturally. Persist `price_observed` as a structured finding kind even before the counterfactual tool? Recommend yes — cheap insurance.
