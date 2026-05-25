# Polaris Research Synthesis — competing with Comet on a local-first niche

> **Status: scope inventory, NOT a committed plan.** This document was synthesized from 8 parallel research subagents that worked from training data — none of the cited file paths in `Skyvern-AI/skyvern`, `letta-ai/letta`, `browser-use`, or `mozilla/readability` have been personally verified, and none of the "what does NOT work at 4B" claims have been benchmark-grounded. Estimates in the accompanying roadmap are agent guesses, not calibrated. Treat this as a useful map of the problem space, not a strategy. Per arch-nemesis round 5: planning artifacts written without reading the underlying material are theater. We're keeping this doc for orientation but starting M3.5 (the M3-debt-cleanup milestone) opportunistically and re-planning at each closure rather than committing to the M4-M7 sequence as written.

> Written 2026-05-24 after 8 parallel research streams (≈25 000 words) covered every feature surface needed to compete with Perplexity Comet while running entirely on consumer hardware (Linux P2200 5 GB VRAM + 32 GB DDR4 + i7, ~38 tok/s on qwen3.5:4b at ≤32 K context).
>
> This document collapses the streams into the cross-cutting picture: shared infrastructure, dependency graph, what we can and can't build at 4B, and the open questions for the user. The accompanying milestone roadmap (`docs/roadmap/M4-M7.md`) sequences implementation; this doc explains the WHY behind that sequencing.

---

## 1. The competitive picture

Comet's value proposition is four-pronged: **per-page Q&A**, **agentic "do this for me"**, **smart search + cross-source synthesis**, and **a polished side-panel UX**. Each comes with a cloud-model assumption — they ride GPT-4-class reasoning, multi-modal grounding, and vector-DB-backed memory across devices.

We can't match raw model capability at 4 B. We compete on three axes:

1. **Privacy** — nothing leaves the local machine; the user's logged-in context stays on the user's box.
2. **Goal anchoring** — the verbatim user goal lives outside the model context and is re-injected every Planner / Evaluator call. Empirically validated; this is the project's load-bearing thesis.
3. **Domain quality** — for the shopping deal-hunter Phase-1 use case, the retailer adapter framework + ARIA-tree extraction + cross-source synthesis is sufficient to beat a cloud model that has to interpret 50 KB of cluttered HTML over the wire.

The research streams confirm this is a *defensible* niche but require ~9 weeks of sequenced work (M3.5 → M7) to arrive at it.

---

## 2. Cross-cutting infrastructure (must be in place before user-visible features)

Five infrastructure layers fall out of the streams as foundational; multiple downstream features depend on them. They are *not optional* and they are *not sequenceable in parallel* with the features that consume them.

### 2.1 Embedding + cosine + IDB-v2 (shared by Streams 3, 4, 5)

`mxbai-embed-large` is already in the user's Ollama stack (1024-d, ~50 ms/embedding on CPU). What's missing:

- A dedicated `findingEmbeddings` IDB store (Stream 3 surprising finding: inlining vectors in the Findings row blows up `findingsByRecency` 50× via JSON deser).
- A `cosineSimilarity(a: Float32Array, b: Float32Array): number` helper (~10 LOC).
- A retrieval API: `findingsByRelevance(taskId | global, queryEmbedding, k)`.
- An `archival` IDB store separate from per-task `findings` (Stream 5 #1).
- A `lessons` IDB store (Stream 4 #1).

This is one IDB schema bump (DB_VERSION: 1 → 2) and ~150 LOC. It unlocks: archival recall (Stream 3 + 5), Reflexion (Stream 4), retrieval-augmented replan (Stream 4 + 5).

### 2.2 KV-cache-friendly prompt structure (Stream 7 #1)

Ollama wraps llama.cpp's `cache_prompt: true` with `keep_alive`. The cache holds **iff the prompt prefix is byte-equal at the tokenizer level**. Today the Executor prompt mixes stable bits (system rules, plan) with churning bits (scratchpad tail) in undefined order — the cache misses on every turn.

The fix is a pure refactor of `executor.ts::executorSystemPrompt`: stable-first, churn-last. Expected 30 – 50 % reduction in Executor `prompt_eval_duration`. Pure refactor, ½ day, no new deps.

**Single Linux probe needed:** send identical 1 500-token prompt twice; second call's `prompt_eval_duration` should be < 10 % of the first. If yes → ship the refactor. If no → KV reuse isn't actually working and Feature 1 is moot; we redirect effort.

### 2.3 Telemetry foundation (Stream 7 #7)

Without it, every measurement-driven decision (KV-cache verification, embedding-batch tuning, breaker threshold tuning) is guessing. Add a `metrics` IDB store + tap on existing log call sites + minimal debug panel. ~1.5 days.

### 2.4 Safety baseline (Stream 8 #1, #4, #6, #7, #11)

The "5-day non-negotiable safety floor" before *any* page-action tools ship to users:

| # | Feature | LOC | Why |
|---|---|---|---|
| 1 | Content tagging (`<untrusted_page_content>` wrapping in all prompts that include page extracts) | ~50 | Greshake et al. 2023 indirect-injection class. |
| 4 | Domain tier system (`read-only` / `click-only` / `full-action` per host) | ~150 | Default trust = `read-only`; user opts-in per domain. |
| 6 | CSP hardening in manifest | ~10 | MV3 default already strict; one extra clause. |
| 7 | Hallucinated-tool breaker tie-in | ~30 | Existing breaker counts unknown tools; route to abort. |
| 11 | Password-field hard refusal | ~20 | Hard rule: agent NEVER types into `<input type="password">`. |

These cannot be skipped. Stream 8 is explicit: the 4B model cannot self-classify or run dual-LLM defenses (5 GB VRAM); defenses must be infrastructural.

### 2.5 PII regex pre-filter (Stream 5 #10 + Stream 8 #2)

Lands before any persistence-touching feature. Microsoft Presidio's regex catalogue gives us credit-card / SSN / phone / email / address patterns. Filter at the Compactor's persistence layer + at the Curator's archival write. ~50 LOC. Separately tagged "privacy:high" findings get redacted before retrieval surfaces them in prompts.

---

## 3. Honest list of what does NOT work at 4B

The streams converge on five techniques to *avoid* — they look attractive in the literature but don't work for our model size.

1. **`format: <schema-object>`** — confirmed broken on qwen3.5:4b across Mac and Linux probes. Use `format: "json"` string-mode + Zod validation. (Already known; reinforced by Stream 4.)
2. **Self-consistency / sample-N-vote** — Stream 4: a 4 B model isn't diverse enough across samples; majority-vote produces the same wrong answer most of the time.
3. **LATS / MCTS-style tree search** — 5 – 20× model calls is unaffordable at 38 tok/s; Comet probably uses these on cloud, we cannot.
4. **Codegen-based skill compilation (Voyager-style JS)** — Qwen3.5:4b is a poor coder *and* MV3 CSP forbids `eval`. Use prompt-template macros instead (Stream 4 #8).
5. **LLM-as-reranker** — Stream 3: even thinking-OFF, sending 10 results to qwen3.5 to pick 3 burns 5 – 10 s on the Executor's hot path, defeating the point of reranking. Use embedding-cosine instead.

Plus three "honest no's" on multimodal:

6. **Implicit preference learning** (Stream 5 #4) — true observational generalization at 4 B doesn't work. Use Reflexion-style explicit lessons gated by Curator + user confirmation. If we ever need real implicit learning, it goes offline on the user's qwen3.6:35b-a3b as a sleep-time stream.
7. **Voice STT for chat / mid-task corrections** (Stream 6 #3) — Web Speech API in 2026 isn't fast/accurate/interruptible enough. STT for *goal entry only* is shippable.
8. **TTS for autonomous narration** (Stream 6 #4) — vanity. Ship as labeled-experimental opt-in; default off.

Documenting these in CLAUDE.md prevents future contributors (or future Claude in this repo) from re-trying them.

---

## 4. The dependency graph

```
                ┌─────────────────────────────────────┐
                │  M3.5 — Pre-Linux Foundation        │
                │  (≤1 week)                          │
                └─────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────────┐
│ Safety       │    │ KV-cache     │    │ Telemetry        │
│ baseline     │    │ prompt       │    │ + measurement    │
│ (5 features) │    │ restructure  │    │ harness          │
└──────────────┘    └──────────────┘    └──────────────────┘
        │                     │                     │
        ├───────── PII regex ─┴─── AX backendNodeId ┘
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│  M4 — Action Surface + Search Triad (2 weeks)           │
│  PRECONDITION: safety floor in place                    │
└─────────────────────────────────────────────────────────┘
   │            │            │              │              │
   ▼            ▼            ▼              ▼              ▼
page.* tools   SearXNG     reranker     tab.open_+      Confirmation
(click/type/   triad       (mxbai       extract         gate UI
scroll/...)                cosine)      composite
   │
   └─────── BLOCKED ON: confirmation-gate UX
   
        ┌───────── Shared embedding infra ─────────┐
        │                                          │
        ▼                                          ▼
┌─────────────────────────┐         ┌──────────────────────────┐
│  M5 — Personalization   │         │  Reasoning patterns      │
│  Core (2 weeks)         │         │  (alongside M5)          │
└─────────────────────────┘         └──────────────────────────┘
        │                                          │
   archival memory                            Reflexion lessons
   user profile                               retrieval-augmented
   eviction policy                              replan
   Curator role                               CoVe self-verify
                                              plan diff replans
                                              tool-chain hints
        │                                          │
        └────────────── Cross-source synthesis ────┘
                              │
                              ▼
              ┌──────────────────────────────────┐
              │  M6 — Multi-context + UX (2wk)   │
              └──────────────────────────────────┘
                              │
   multi-tab synthesis · vision.verify · citations · confidence
   pause/resume + hint · STT goal entry · Selection Q&A
                              │
                              ▼
              ┌──────────────────────────────────┐
              │  M7 — Polish + Differentiation   │
              │  (2 weeks)                       │
              └──────────────────────────────────┘
                              │
   macros · arXiv/SemSch · Site-search · Bookmarks/history
   Reading list · SoM grounding · TTS · PDF · Video transcripts
```

The graph has three load-bearing edges that must hold:

- **Safety baseline → M4 actions** — actions cannot ship without 5-day floor.
- **Embedding infra → M5 + Reasoning** — cannot do archival / Reflexion / cross-source synthesis without it.
- **Confirmation gate → page actions on by default** — `page.click` ships behind a flag until the gate UX exists.

---

## 5. The "gone-rogue agent" check

A consolidation pass against four real-world failure modes the streams flagged:

| Failure mode | Defense (which stream) | Status |
|---|---|---|
| Page injects "transfer money" into a review | Stream 8 #1 content tagging | M3.5 |
| Agent fills form on wrong site (look-alike domain) | Stream 8 #4 domain tier + Stream 2 #4 page-stability | M3.5 + M4 |
| Agent over-buys ("you said cheap → I bought 3") | Stream 8 #3 confirmation gate | M4 (must precede page-action default-on) |
| Agent leaks PII via `dumpLogs()` | Stream 8 #10 + Stream 5 #10 PII regex | M3.5 |

Every M4+ user-facing feature ships *only* after the safety floor is in place. This is the only sacred constraint.

---

## 6. Open questions surfaced by the streams (need user input)

The streams agreed on a lot but flagged seven decisions where research can't substitute for user judgment.

1. **SearXNG hosting.** Stream 3 recommends self-hosted SearXNG as primary. Run as a Docker side-car next to Ollama on the Linux box? Or accept DDG primary + Brave fallback and skip SearXNG complexity?
2. **Domain tier defaults.** Stream 8 wants `read-only` as the default trust tier. Should the canonical retailers (Amazon, Walmart, Target, Best Buy, eBay) ship in the *initial* allowlist as `full-action`, or should every domain require user opt-in?
3. **Confirmation-gate granularity.** Stream 8 wants confirmations on purchases / deletions / sending email. Should *every* action over a $-amount threshold require confirmation, or only on first contact with a new domain?
4. **Voice STT scope.** Stream 6 says "goal entry only is worth shipping." Confirm we DON'T ship STT for chat / mid-task corrections in M6?
5. **Persona / user profile schema.** Stream 5 recommends Letta-style "core memory" blocks (Address, Diet, Preferences, Persona). Is the user OK with us asking them at first-run setup, or should we infer from observed actions? (Inference at 4B is unreliable; explicit ask is recommended.)
6. **CAPTCHA UX.** Stream 8 #12: when CAPTCHA hit, the agent pauses and the user solves it manually. Acceptable, or do we want a "skip site" button instead?
7. **Comet-feature parity vs. local-first differentiation.** Multi-tab synthesis (Stream 5 #5) is shippable but expensive (3 ARIA extracts × 30 s each = 90 s on Mac CPU). Should this be an M6 feature or deferred to M7 polish?

---

## 7. Reference repos still wanted

None of the 8 agents found `~/Documents/Spike/Personal/Browser/refs/` cloned during their runs. The implementation phase will be much higher quality if we have at least these five locally:

| Repo | Used by streams | Highest-leverage concrete reference |
|---|---|---|
| `browser-use/browser-use` | 2, 3, 8 | Action set + selector strategy + page-stability |
| `Skyvern-AI/skyvern` | 2, 8 | `webeye/scraper/scraper.py::wait_for_page_to_load`, `LLMElementSelector`, `requires_human_review` confirmation pattern |
| `mozilla/readability` | 1 | `Readability.js` core algorithm |
| `letta-ai/letta` | 4, 5 | `letta/services/agent_manager.py` (archival), v0.4 core/archival split |
| `web-arena-x/webarena` | 1, 2, 3, 8 | Task definitions — what "agentic" means concretely |

These are open-source. Cloning into the suggested directory takes 5 minutes and improves implementation accuracy materially. The roadmap doc assumes they'll be cloned by M4 start.

---

## 8. What the streams agreed on without prompting

Six recurring themes appeared across all 8 docs without coordination:

1. **The Executor's hot path is THE constraint.** Every stream pushes structure that minimizes Executor turns or shifts cost to the rare Planner / Evaluator paths.
2. **`backendDOMNodeId` propagation through `simplifyAxTree`** — Stream 2 surfaced this as a high-impact gap; Streams 1, 6, 8 all assume it's available downstream.
3. **The Compactor is the right place to gate persistence.** PII redaction, embedding generation, lesson curation, archival write — all want to hook the Compactor's exit boundary.
4. **Ollama keep_alive is load-bearing.** Drop it and KV cache misses; embedding latency degrades; cold-load cost stacks per turn.
5. **The agent should not write its own selectors as code.** Streams 2 + 4 + 8 agree: keep selectors as data (AX node IDs, XPath, anchor descriptions) — never as JS strings the model emits.
6. **Cite, don't hallucinate.** Stream 4's citation-required prompting + Stream 6's citation rendering + Stream 3's cross-source synthesis converge on the same UX: every claim has an `[N]` marker linking to the finding / page that backs it.

These six become the project's M4+ design tenets.

---

*See the milestone roadmap (`docs/roadmap/M4-M7.md`) for the implementation sequence with estimates, integration-test strategy per milestone, and the Linux-box validation gates.*
