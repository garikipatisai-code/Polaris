# Stream 7 — Performance & Infrastructure (Implementation Playbook)

**Status:** Research; nothing ships until reviewed. **Date:** 2026-05-24.
**Scope:** KV cache reuse, prefix caching, parallel tools, embeddings, budget pruning, telemetry, crash-resume, background work, concurrency.
**Reference repos at `~/Documents/Spike/Personal/Browser/refs/`:** **does not exist.** Citations to Ollama, llama.cpp, vLLM, Letta are from training data; file/function names accurate enough for Linux-side verification.

---

## Overview — latency budget by role on the P2200

CLAUDE.md's measured curve gives a hard ceiling per role:

| Role | Target ctx | Wall on P2200 | Frequency |
|---|---|---|---|
| Executor | ≤ 6K | ~22s | 30–100×/task — **hot path** |
| Planner | ≤ 32K | 130s | 1× initial + ≤3 replans |
| Evaluator | ≤ 8K | ~25s | every 5 Executor turns + on-finish |
| Compactor | ≤ 8K | ~25s | every ~10 Executor turns |

A 20-step task ≈ 9 minutes wall, **80% of which is Executor turns**. Every win on Executor multiplies; Planner wins are linear in task count. Three categories of optimization:

1. **Reduce per-call wall at fixed context** (KV / prefix caching). 70–90% of `prompt_eval` time is reusable at steady state.
2. **Reduce calls per task** (parallel tools, composite tools).
3. **Reduce blocking I/O around the hot path** (async embed, telemetry, background work).

The single highest-leverage win is **reliable Executor KV reuse**: the system + plan + findings prefix is 1.5–4 K stable tokens, 90%+ identical between consecutive Executor turns. Re-evaluating that costs 3–6 s per turn, ~2 min over a 20-step task.

---

## Cross-cutting: Ollama KV-cache reality check

Before committing, be honest about what Ollama actually does.

- **llama.cpp's server has `cache_prompt: true` as default since 2024.** Compares new prompt's prefix against the previous prompt's KV cache, reuses the longest common prefix, evaluates only the divergent tail. This is what we want.
- **Ollama's `/api/chat` does not expose `cache_prompt`** in the documented `options` bag. Inspecting Ollama Go source `server/routes.go::ChatHandler`, the flag is set internally to true; the caller can't turn it off but also can't confirm it.
- **Slot identity is per-runner, not per-session.** llama.cpp keeps a fixed pool (default 4); two consecutive `/api/chat` calls share a slot only if no other request was scheduled between them. `runner/llamarunner/runner.go::findBestSlot()` prefers slots with the longest matching prefix — this is the prefix-cache lookup.
- **`keep_alive` keeps weights in VRAM, not the KV cache** — but in practice the slot pool is owned by the loaded runner, so weights-resident implies slots-resident.
- **Different `num_ctx` between calls invalidates the cache** — llama.cpp re-allocates KV when `n_ctx` changes. Polaris currently doesn't override `num_ctx`; safe.

**Verdict:** KV cache reuse works across consecutive `/api/chat` calls when (a) same model loaded, (b) `keep_alive` holds it, (c) `num_ctx` consistent, (d) no other client interleaves a request that evicts the slot, (e) the prefix is byte-equal at the **tokenizer** level. We control all but (d) and (e); (d) is fine because Polaris is the only client.

The optimistic case (90% prompt-eval reduction) is what separates "feels like Comet" from "feels like a 4B local model." The pessimistic case (cache flaky) is still acceptable for shipping. The right test on the Linux box: send identical 1500-token prompt twice, compare `prompt_eval_duration` from the second response. If second is <10% of first, KV reuse is real.

References to verify: `ollama/server/sched.go`, `ollama/runner/llamarunner/runner.go::findBestSlot`, `llama.cpp/examples/server/server.cpp::slot_prompt_similarity`, `llama.cpp/common/sampling.cpp::common_sampler_init` (for grammar interaction).

---

## Feature 1 — KV cache reuse across turns

**Recommendation:** do nothing in code; everything in measurement and prompt structure. The reuse is automatic when conditions hold; what we control is whether prompts hit the conditions.

`slot_prompt_similarity` matches **token-level**, not byte-level — small UTF-8 changes near the start (`€` vs `EUR`) shift token boundaries downstream. Maximize hit rate by structuring the prompt **stable-first, churn-last**.

Today's Executor prompt (`executor.ts::executorSystemPrompt`):
```
GOAL → PLAN → RELEVANT FINDINGS → RECENT ACTIONS → AVAILABLE TOOLS → RULES
```

`RELEVANT FINDINGS` mutates between turns (compaction adds entries), invalidating everything downstream. **Re-order:**

```
GOAL [stable]
PLAN [stable within revision]
AVAILABLE TOOLS [stable per session]
RULES [stable]
RELEVANT FINDINGS [grows monotonically]
RECENT ACTIONS [tail-only churn]
```

A typical Executor turn now changes only the last 200–400 chars of the prompt; **expected hit rate >85% of prompt tokens**.

**Integration:** restructure `executor.ts::executorSystemPrompt`. Add `prompt_eval_duration` and derived `effectiveCacheHitPct` to the `chatOnce` log at `ollama.ts:366`. **Deps:** none.

**Risks:** `format: "json"` mode partially defeats KV reuse for **generated** tokens (grammar restarts each call) but does not affect prompt-prefix reuse. Schema mode (`format: <object>`) does kill cache reuse — we already don't use it. Tool-call retries (executor.ts:104) prepend extra messages on the ~20% retry path; not hot-path.

**Open question:** does Ollama's `prompt_eval_duration` reliably distinguish cache hit from miss, or report full count regardless? Linux-box test will tell us. Confirm `OLLAMA_NUM_PARALLEL=1`; ≥2 means multiple slots and consecutive calls may land in different ones.

---

## Feature 2 — Cross-role prefix sharing

**Recommendation: don't.** Roles have different system prompts by design (Executor lists tools, Planner describes tools, Evaluator references criteria). Forcing a shared header adds prompt tokens (each role carries irrelevant text) and confuses the model about its identity.

**Share within a role across turns** (Feature 1) — same role, same model, byte-stable header. Cross-role is rare (Planner runs ≤4 times); cache-miss cost on those calls is dwarfed by their thinking-mode generation cost (130 s for a 32K Planner). If we ever wanted true cross-role sharing, define a `POLARIS_SYSTEM_HEADER` constant prepended verbatim in each role — only worth it if measurement proves cross-role misses dominate.

**Risks:** trying too hard adds tokens and clarity tax for negligible gain. **Open question:** what's the actual miss cost on a Planner cold-prompt call? `prompt_eval_duration` from a clean run on 32K context tells us.

---

## Feature 3 — Parallel tool execution

**Recommendation:** add a **`parallel_extract`** tool that takes an array of URLs and returns an array of results. **Don't** rely on the model emitting `tool_calls.length > 1` arrays — at ~80% reliability per probe, the parallel-array path forces full-turn retries on 20% of turns, more expensive than just sequencing.

```ts
// sketch
parallel_extract({ urls: string[] /*≤3*/, waitMs?: number })
  // internally: Promise.allSettled(urls.map(url => tab.open → wait → aria.extract))
  // returns: [{ url, tabId, tree | error }]
```

The model emits **one** tool call (95%+ reliable); the tool internally parallelizes. **Concurrency cap = 3** (default) / 5 (hard). Each `chrome.debugger.attach + getFullAXTree + detach` cycle owns a debugger session; multiple tabs is fine; >5 risks Chrome's task throttling.

**Hidden upside:** the parallel tool error-handles internally. When 1 of 3 tabs fails, the result is `{url, error}` mixed with successes — model continues over partial set instead of retrying the whole pattern.

**Token tax:** returning 3× ARIA trees is ~12 K chars — exceeds Executor's 6 K. Mitigation: return only **adapter-extracted summaries** (~200 chars/page from `product.extract`), not raw trees.

**Integration:** new `src/agent/tools/browser/parallel.ts`. Existing `ownedTabs` set already supports multiple tabs. **Deps:** none.

**Risks:** 3 parallel debugger attaches ≈ 2 s worst case (first attach spins up DevTools backend ~1 s; subsequent faster). Chrome MV3 background throttling — open only when panel is open. **Open question:** Executor- or Planner-level? Recommendation: Executor with adapter summaries.

---

## Feature 4 — Speculative tool calling

**Recommendation: defer the speculative-pre-fetch pattern; ship composite tools instead.**

Pre-fetching while waiting for the next chat call saves at most ~1 s per turn (the time `tab.open` takes if it overlaps). On a P2200 where chat dominates at 22 s, 1 s is below the perceptual threshold. Implementation complexity is high (gate on Planner output before commit, reconcile on mismatch).

**Where speculation does pay:** **after** a `tab.open` is committed, before the model's next turn, chain `wait_stable + aria.extract` as one tool. Frame this as a **composite tool**, not speculation:

```ts
tab.open_and_extract({ url, waitMs?: number /*default 3000*/ })
  // chains: open → wait → aria.extract → return tree
```

Saves the model **two turns × 22 s = 44 s** per page load. Trivial to implement, deterministic, no speculation needed.

**Risks:** model can't intervene mid-chain (paywall, redirect to login). Mitigation: tool returns title + post-redirect URL so the model can decide to abandon next turn. Wait-time tuning (3 s default) over- or under-shoots; use `page.wait_stable` (Stream 1 Feature 8) once it ships.

**Integration:** alongside Feature 3 in `parallel.ts`. **Deps:** none.

**Open question:** should we ship `search_and_open_top3` and other compositions? Recommendation: just `tab.open_and_extract` first; let agent behavior tell us which other compositions earn a tool-list slot.

---

## Feature 5 — Embedding-index latency

**Recommendation:** **lazy + async batched** at write time.

Today (state_store.ts:373) `appendFinding` already persists with `embedding: null`. Reads use `findingsByRecency` — embeddings are unused. **The 5 s blocking-embed scenario doesn't exist yet** — but it will once we add similarity retrieval (likely M4).

Three-tier strategy:

1. **Don't block on embed at write time.** Persist `embedding: null`; post a `chrome.alarms` job to embed in background.
2. **Batch 10 embeds per `/api/embed` call.** mxbai-embed-large at 50 ms/embedding solo, ~10–15 ms/embedding batched. `client.embed` already accepts `input: string[]` — verified at `ollama.ts:390`.
3. **Don't introduce a second model.** "256-d hot / 1024-d cold" is overkill — IDB cap is 50 MB, 5K findings × 1024 floats × 4 bytes = 20 MB, fits. Single-tier, single model.

**Integration:**
- `src/agent/embedding_worker.ts` — new; batches pending embeds.
- New alarm `polaris.embed_tick` (1 min, MV3 min) alongside watchdog at `service_worker.ts:57`.
- `findingsBySimilarity(taskId, queryText, limit)` — embeds query, sorts by cosine, falls back to recency when any finding's embedding is still null.
- Worker checks `currentOrchestrator !== null` and skips if a task is hot — embed work doesn't compete with hot path.

**Deps:** none — cosine math is in-house per M2 framework decision (CLAUDE.md).

**Risks:** mxbai-embed-large not always loaded — `keep_alive: '10m'` per call covers it. Cosine accuracy at 1024-d acceptable per MTEB. **Open question:** task-scoped vs cross-task embeddings? Phase 1 = task-scoped; cross-task = M5 ADR.

---

## Feature 6 — Pre-call budget pruning

Today's pattern (`executor.ts:60`): assemble naively → check size → `return { ok: false, error: 'compactor must run' }`. That's pessimistic: bails to compaction rather than salvaging. **Replace with priority-tiered pruning.**

Tiers per role:

| Role | T0 (must) | T1 (high) | T2 (medium) | T3 (low) |
|---|---|---|---|---|
| Executor | goal + rules + tool list | active step + 3 findings | last 3 scratch | findings 4–8, scratch 4–5 |
| Planner | goal + criteria + tool index | replan hint + 5 findings | findings 6–15 | full plan rationales |
| Evaluator | goal + criteria + verdict schema | 5 findings + 5 scratch | findings 6–15 | scratch 6–15 |
| Compactor | goal + scratch-batch | existing finding keys | (n/a) | (n/a) |

Algorithm:

```
function buildPromptBounded(role, input, budget):
  parts = [renderTier0(input)]
  used = approxTokens(parts[0])
  if used > budget * 0.9:
    log('error', 'budget', `Tier 0 alone overflows for ${role}`)
    return { prompt: parts.join('\n\n'), droppedAll: true }
  for tier in tiers[1:]:
    items = tier.items(input).sortBy(priority)
    fitted = []
    for item in items:
      cost = approxTokens(item)
      if used + cost <= budget * 0.9:
        fitted.push(item); used += cost
      else if tier.canTruncate:
        fitted.push(truncateToFit(item, budget * 0.9 - used)); break
      else: break
    if fitted: parts.push(tier.header + '\n' + fitted.join('\n'))
  return { prompt: parts.join('\n\n'), finalTokens: used }
```

**Why 0.9 × budget:** the empty-tool-call retry path (executor.ts:104) replays failed-assistant (truncated) + nudge — ~600 extra chars. 100% on first call → retry overflows. 10% headroom keeps retries safe.

**Pruning order:** drop Tier 3 first, never Tier 0. If Tier 0 alone exceeds budget, that's structural — log and continue with truncated Tier 0 rather than fail pre-flight.

**Integration:**
- New `src/agent/prompt_builder.ts` — `buildPromptBounded(role, input, budget)`.
- `executor.ts`, `planner.ts`, `evaluator.ts`, `compactor.ts` switch their inline assembly to call the builder.
- Telemetry (Feature 7) emits `prompt_builder.dropped_tiers` events.

**Risks:** dropping findings 4–8 means model can't see them — mitigate via similarity-ranked retrieval (Feature 5). **Open question:** include a `[+5 older findings dropped]` marker? Recommendation: omit — model performs better on a clean shorter prompt than self-referential gap-fillers.

---

## Feature 7 — Telemetry / observability

**Recommendation:** minimal IDB layer + debug panel UI; **no external library**. MV3 SW environment is hostile to most Node-targeted libs (no fs, restricted Worker semantics).

**Schema** (new IDB store `telemetry`, alongside `events`/`findings`):

```ts
interface TelemetryEntry {
  taskId: string; ts: number;
  category: 'role' | 'tool' | 'compactor' | 'breaker' | 'embed';
  metric: string;            // 'role.executor.wallMs', 'tool.aria.extract.wallMs'
  value: number;
  tags?: Record<string, string>;
}
```

Indexed by `(taskId, ts)` and `(metric, ts)`. Cap 10K entries/task, 100K total — pruned on the same alarm tick that does embedding.

**Call sites** (one line each: `recordTelemetry({...})`):
- `ollama.ts::chatOnce` — `wallMs`, `promptTokens`, `genTokens`, `tokPerSec`, `retried`, **plus** `promptEvalMs`, `evalMs` (Feature 1).
- `registry.ts::dispatch` — `tool.{name}.wallMs`, `tool.{name}.ok`, `tool.{name}.fatal`.
- `orchestrator.ts::runEvaluation` — `evaluator.verdict={done|continue|replan|abort}`.
- `circuit_breaker.ts::evaluate` — trip events.
- `state_store.ts::appendFinding` — `compactor.findings_added`.

**API** (`src/agent/telemetry.ts`): `recordTelemetry`, `queryTelemetry`, `quantiles`, `rate`. **UI** (`src/sidepanel/Telemetry.tsx`, gated on debug toggle):

```
Task t01ABCD
  Roles                p50 / p95 / max / count
    planner            22.4s / 132s / 134s / 2
    executor           18.7s / 24.1s / 25.0s / 18
    evaluator          24.0s / 31.2s / 32.0s / 4
  Tools                success / median / count
    aria.extract       92% / 240ms / 12
    search             66% / 2.3s / 3 (1 timeout)
  Tokens
    total              62,400 (planner 18K, executor 38K, evaluator 5K, compactor 1.4K)
```

**Export:** `polaris.dumpTelemetry()` from SW DevTools console; `chrome.downloads.download(...)` for user-facing export (defer to M5 — needs `downloads` permission).

**Risks:** IDB write tax ~1 ms/call, 50 calls/task = 50 ms cumulative. 1.2 MB/task storage; pruning bounds it. **Privacy:** local-only by constraint; never include user-input strings (goal text, page content) — only metric names and durations.

**Open question:** on by default vs opt-in? Recommendation: on by default (local, small, no signal otherwise).

---

## Feature 8 — Crash-resume robustness

Today's `resume()` (orchestrator.ts:112) loads state, marks resumed, hands to `runUntilTerminal`. Failure modes not covered:

- **Ollama dead** → next role call times out at 5 min; user sees unresponsive panel.
- **Model unloaded** → same shape.
- **`breaker.totalReplans` already at max** → resumed task immediately aborts.
- **`lastTouch` >5 min** → watchdog will abort within 1 min of next alarm tick.
- **Manifest permission revoked** (user toggled extension off and on) → first browser tool fails.

**Add a pre-flight health check:**

```ts
async resume() {
  const state = await store.loadHot();
  if (!state) throw new Error('no task');
  if (TERMINAL_PHASES.has(state.phase)) throw new Error(`already terminal`);
  const ping = await this.client.ping();
  if (!ping.ok) { await store.patchHot({ phase: 'ABORTED' }); throw new Error(`Ollama unreachable: ${ping.error}`); }
  if (!ping.models?.includes(this.model)) { ...throw `model ${this.model} not loaded`; }
  if (state.breaker.totalReplans >= breaker.MAX_TOTAL_REPLANS) { ...throw `at replan cap — likely unsolvable`; }
  const idle = Date.now() - (state.lastTouch ?? state.createdAt);
  if (idle > STALE_TASK_MS) { ...throw `lastTouch too old (${idle}ms)`; }
  if (chrome.permissions) {
    const ok = await chrome.permissions.contains({ permissions: ['debugger', 'tabs'] });
    if (!ok) { ...throw `permissions revoked`; }
  }
  // ... existing resume body
}
```

Each failure surfaces a specific reason via `agent.terminal`. **Integration:** modify `orchestrator.ts::resume`. **Deps:** none — `chrome.permissions` MV3-since-Chrome-88.

**Risks:** ~1 s pre-flight tax on resume; acceptable (resume is rare). **Open question:** `dryRun` resume that loads state and reports without starting? Useful for "Resume from where you left off — last activity 3 min ago, 8 steps in" UI. Recommendation: yes for panel; expose `loadHot` + health checks separately.

---

## Feature 9 — Background indexing

Use `chrome.alarms` with **1-min period** (MV3 minimum) for: pending embeds, telemetry pruning, IDB vacuuming. **No Web Workers** — restricted in MV3 SW; the SW itself is the worker.

Per-tick checklist:
- `currentOrchestrator !== null`? If yes, defer non-critical work (avoid hot-path contention).
- Findings with `embedding: null`? Embed in batches of 10; bound at 5 batches/tick (50/min max).
- Telemetry over per-task cap (10K)? Prune oldest 10%.
- Events store >10K rows? Cap to most-recent 5K/task.

Each tick bounded at ~5 s (MV3 SW invocations time out at 30 s; we want margin).

**Integration:** `src/agent/background_worker.ts` exports `tick()`. `service_worker.ts` registers `polaris.background_tick` alongside the watchdog.

**Risks:** Chrome can suspend SW between alarms; if a tick is in progress when SW suspends, work interrupts. Acceptable: next tick picks up (idempotent — embed `null` rows, prune by count). SW wakeup ~50 ms × 1/min = 0.08% CPU. Negligible.

**Open question:** adaptive period via `chrome.idle`? Recommendation: no — fixed period; variable scheduling is complexity for marginal savings.

---

## Feature 10 — Concurrency limits

Today (`service_worker.ts:265`) `agent.start` refuses if `currentOrchestrator !== null`. Right default for single-task model. **Refine to a 3-state UX:**

1. **Currently running** → reject with `taskId` so UI offers "Abort and start new" / "Wait."
2. **Currently finalizing** (DONE/ABORTED transition propagating, ~100 ms) → **wait up to 1 s** for transition before refusing.
3. **No active task** → proceed.

```ts
async function waitForOrchestratorClear(maxMs = 1000): Promise<boolean> {
  const start = Date.now();
  while (currentOrchestrator !== null && Date.now() - start < maxMs) {
    await new Promise(r => setTimeout(r, 50));
  }
  return currentOrchestrator === null;
}
```

If wait times out, existing reject behavior fires. UX win: clicking "Start new task" right after the previous finished now Just Works.

**Why not a queue?** A request queue (B → enqueued; on A complete, A starts) mismatches user mental model — they expect immediate feedback, not delayed start. Batch-task processing is a different feature.

**Integration:** wrap `currentOrchestrator` checks in `service_worker.ts::handleAgentStart` and `handleAgentResume`.

**Risks:** ~50 ms latency on happy path (one poll). Race: two concurrent "Start" clicks both observe `null` simultaneously. Mitigation: a `_startMutex` flag separate from `currentOrchestrator`.

**Open question:** disable "Start" button while waiting? Yes — UI should reflect actual state. Adds an `agent.busy` event SW → panel.

---

## Implementation order

By **leverage on hot-path Executor latency** (where 80% of task wall-time goes):

1. **Feature 1 — KV reuse via prompt re-ordering.** Pure refactor; no permissions; expected 30–50% reduction in Executor `prompt_eval_duration` once measured. **Highest value/LOC.**
2. **Feature 7 — Telemetry foundation.** Without it, every measurement-driven decision (Feature 1 verification, Feature 5 batch tuning) is guessing.
3. **Feature 4 — Composite tool `tab.open_and_extract`.** Saves 2 turns × 22 s = 44 s per page load. Trivial.
4. **Feature 6 — Budget pruning.** Gracefully degrade when scratchpad heavy; today's pre-flight bail is too pessimistic.
5. **Feature 3 — `parallel_extract`.** Most-impactful for shopping (multi-retailer comparison).
6. **Feature 8 — `resume()` health checks.** Robustness; low cost.
7. **Feature 5 — Async embed worker.** Only matters once we use embeddings (M4).
8. **Feature 9 — Background tick infra.** Required by 5 and 7's pruning.
9. **Feature 10 — Concurrency-limit refinement.** Polish; current behavior correct, just unfriendly.
10. **Feature 2 — Cross-role prefix sharing.** Likely negative ROI; revisit only if Feature 1 shows cross-role misses dominate.

Phase mapping:
- **M3.5:** Features 1, 7, 4 (perf-foundation triad).
- **M4:** Features 6, 3, 5 (embeddings + multi-tool flow with shopping).
- **M5:** Features 8, 9, 10, 2 (polish + revisit).

---

## Open questions for the user

1. **Linux-box KV-reuse measurement** — can you run the back-to-back identical-prompt test (Feature 1) so we confirm the optimistic case before committing to prompt re-ordering?
2. **Telemetry default** — on by default vs opt-in? Recommendation: on (local, small); the privacy-first messaging matters for your audience.
3. **`parallel_extract` cap** — proposed 3 (default) / 5 (hard). Enough for shopping comparison?
4. **Embedding model strategy** — single-tier mxbai-embed-large for everything vs the 256-d hot / 1024-d cold sketch? Recommendation: single-tier until volume scales past 5K findings.
5. **Telemetry export UI** — JSON download (one line) vs in-panel histogram (~200 LOC React)?
6. **Manifest perm additions** — Feature 7 export needs `downloads`; Feature 8 health check uses `chrome.permissions` (already implicit). OK to add `downloads`?
7. **Composite tools scope** — just `tab.open_and_extract`, or also `search_and_open_top3` etc.? Recommendation: ship one; let agent behavior earn the others.
8. **Background tick period** — Chrome MV3 minimum is 1 min. OK with that?
9. **Resume health-check failure UX** — abort task with reason, or surface a "stalled — fix and retry" state? Recommendation: abort with clear reason — restarting cheap, resuming a doomed task is a UX trap.
10. **`prompt_eval_duration` log inflation** — adding 2–3 fields/Ollama call per chatOnce log. Keep ring buffer at 1000 entries (current MAX_BUFFER) and accept slightly tighter window?
