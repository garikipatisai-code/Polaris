# Stream 5 — Memory & Personalization (Implementation Playbook)

## Overview

The MemGPT three-tier picture, mapped onto Polaris:

| Tier | MemGPT term | Polaris today | Gap |
| --- | --- | --- | --- |
| **Working** | Main context | role prompts + recent scratch entries inlined | none |
| **Episodic** | Recall storage (per-conversation log) | `scratchpad` + `findings` IDB stores keyed by `taskId`; Compactor pages scratch → findings under context pressure | none |
| **Archival** | Free-form, embedded, retrieved | does not exist — `findings` are forgotten when a new task starts | this stream |
| **Persona / human block** | Pinned core memory, always-in-context, user-editable | does not exist | this stream |

Polaris primitives we should reuse, not reinvent:

- `agent/tools/memory.ts` — three tools (`memory.read/write/list`) the model can call. Currently `taskId`-scoped; generalizing the discriminator from `taskId` → `(scope, ownerId)` is the cheapest way to add cross-task memory without a new prompt for the Executor.
- `Finding.embedding?: number[] | null` is already in the schema but never populated. Writer is missing.
- `OllamaClient.embed(model, input)` already handles `mxbai-embed-large` (1024-d) with timeout/retry plumbing.
- The Compactor is already the structural extractor. Promoting a Finding into archival is a one-row copy, not a new pipeline.
- `chrome.storage.local` (~10 MB) for the pinned profile (small, hot, every Planner call); IDB (~50 MB practical) for archival, lessons, history-derived knowledge.

Reference repos: `~/Documents/Spike/Personal/Browser/refs/` is empty on this Mac, so recommendations cite `letta-ai/letta`, `noahshinn/reflexion`, and `unclecode/crawl4ai` by file/algorithm name from training data; a Linux-side Claude with the cloned repos can verify line-by-line.

---

## Feature 1: MemGPT-style archival memory

### Recommendation

Add an **archival** IDB store alongside the existing four. Three new model tools — `memory.archival_write/search/delete` — symmetric with `memory.read/write/list`, so the Executor's prompt grows by three tools, not a new role.

How Letta does archival (`letta/agent.py` + `letta/services/passage_manager.py`): each row is a `Passage` with `{id, text, embedding, metadata, created_at, organization_id, user_id, agent_id}`. Retrieval is paginated cosine-similarity (5/page) so a single recall can't blow context. Letta's prompt: "archival is for evergreen facts, recall is for things in this conversation."

For Polaris, the discriminator is `(scope, ownerId)`:

```ts
type ArchivalScope = 'task' | 'user' | 'global';
interface ArchivalPassage {
  id: string;                       // ULID
  scope: ArchivalScope;
  ownerId: string;                  // taskId for 'task'; 'local' for 'user'/'global'
  text: string;                     // ≤ 1000 chars
  embedding: number[];              // 1024-d
  embeddingModel: string;           // 'mxbai-embed-large' for v1
  tag?: string;                     // optional snake_case label for tag-based recall
  source: 'agent' | 'user' | 'imported';
  privacy: 'public' | 'pii' | 'sensitive';   // see Feature 10
  kind: 'fact' | 'lesson';          // see Feature 4
  accuracy?: 'guess' | 'confirmed'; // lessons only
  confirmCount?: number;            // lessons only
  createdAt: number;
  lastAccessedAt: number;           // LRU
  accessCount: number;              // tiebreaker
}
```

### Alternatives

- Reuse `MemoryCell` with magic `taskId='__archival__'`. Rejected: wrong key shape, schema bump for embeddings required anyway.
- Auto-mirror every Finding into archival. Rejected as default: most findings are noise (`"clicked button #4"`); promotion belongs to the Curator (Feature 2).
- External vector DB (Chroma, pgvector via WASM). Rejected: extra bundle, no benefit over a 1k-row in-process cosine running in <5 ms.

### Integration

`src/agent/idb.ts` — add `archival` store, indexes `by-scope-owner`, `by-tag`, `by-last-accessed`, `by-kind`. Bump `DB_VERSION` 1→2 (additive; existing `upgrade()` handles cleanly).

`src/agent/state_store.ts` — `archivalWrite/Search/Delete/ById`. Writer is the only path that calls `OllamaClient.embed()`; `await`-only so a failed embed errors out rather than silently corrupting the index.

`src/agent/tools/memory.ts` — three tools using the existing argsSchema/outputSchema/parametersJSON triple pattern.

### Dependencies & risks

`mxbai-embed-large` is ~50 ms warm (Linux GPU), ~2.9 s cold first call. Cosine in-house — no `hnswlib`/`faiss-node`/`@xenova/transformers` at this scale. Rate-limit to 1 archival write/Executor turn so chatty agents don't stack 30 embed calls. Embedding-model drift: store `embeddingModel` per row; refuse or backfill on mismatch.

### Open questions

- Auto-tag PII default for agent-initiated archival writes? Default `pii` until proven otherwise.
- Letta uses fixed-page recall; Polaris probably wants top-k flat. Confirm with a real Linux-box run.

---

## Feature 2: Cross-task long-term memory

### Recommendation

Two complementary mechanisms:

1. **Curator at task end.** When a task → `DONE`, run a one-shot Curator role over findings + final answer. Output: at most ~5 `{text, tag, scope, privacy}` triples. Curator is a Compactor variant (thinking OFF, JSON mode, `BUDGETS.compactor` budget) with rubric: "of this task's findings, which would be useful across future tasks?" Auto-promoted to archival as `scope='user'`, `source='agent'`.
2. **Retrieval at every Planner call.** Embed goal text → top-3 cosine over `scope='user'` archival → drop similarity < 0.45 (empirical noise floor for L2-normalized `mxbai`-like vectors) → inject under `RELEVANT MEMORIES` block.

Phase-1 disable model-initiated archival writes during execution — that's the highest-failure path on a 4B model; the end-of-task Curator pass with thinking OFF and a tight rubric is where 4B can earn its keep. Why retrieval at the Planner, not Executor: Planner runs rarely, has the largest budget (≤32K), and decides plan shape. Memory shapes the plan; injecting at Executor-turn-N is too late and burns 6K-budget tokens per turn for diminishing return.

### Alternatives, integration, risks

Always-on injection (no embedding gate) rejected — 100 user memories × 80 chars = 8K chars before the goal even reads. Per-Executor-turn retrieval rejected — 200–400 token overhead per turn, diminishing return. Reflexion lessons only rejected as the only mechanism — declarative facts ("user lives in Austin") need a simpler bucket than procedural lessons. `src/agent/roles/curator.ts` (~100 lines, mirrors `compactor.ts`). Run from `orchestrator.finalizeDone()`. Output → `archivalWrite()`. `src/agent/prompts/planner.ts` — extend `PlannerPromptInput` with `relevantMemories: ArchivalPassage[]`. Orchestrator calls `archivalSearch(goal, k=3)` before constructing input. Template gains `RELEVANT MEMORIES` block above `KNOWN FINDINGS`. Curator-hallucinates-preferences risk: rubric requires evidence quoted from a Finding (not goal text); auto-promoted memories shown post-task with one-tap delete (Letta's `core_memory_replace` flow). Retrieval pollution at low similarity: log retrieval scores in `events` for the first month so the threshold (currently a guessed 0.45) can be tuned from real data.

### Open questions

- Per-scope cap (max 200 `scope='user'` rows) vs aggregate-only? Per-scope is more interpretable.
- Update protocol for fact change ("I moved"): Letta's `search → delete → insert` (3 steps) vs `archival_update(id, text)` convenience.

---

## Feature 3: Explicit user profile (pinned memory)

### Recommendation

A separate, **always-in-Planner-context**, **user-curated** profile block — Letta's "human/persona" core memory translated to our setting. Storage: `chrome.storage.local['polaris.profile']` (small, hot, no embedding).

```ts
interface UserProfileBlock {
  id: string; label: string;       // ≤ 32 chars, e.g. "Address"
  value: string;                   // ≤ 200 chars
  pinned: boolean;                 // true = inject every Planner call
  privacy: 'public' | 'pii' | 'sensitive';
  createdAt: number;
}
```

UI: Profile pane in side panel — list with edit / delete / pin toggle. New-block adder is one text input ("My address is 123 Main St, Austin TX") with auto-suggested label.

Inject pinned blocks at the top of the Planner system prompt under `USER PROFILE`. Aggregate cap 800 chars (~200 tokens) enforced at injection (not edit), so a verbose user can have many blocks but only the most-recent 800 chars get pinned. Order respects manual arrangement.

**Inferred memory (Feature 2) ≠ pinned profile (Feature 3).** Inferred lives in IDB archival, retrieved by similarity, may be wrong, gets a "review" prompt. Pinned lives in `chrome.storage.local`, always present, only changed by user. The Executor never auto-writes profile blocks. Planner sees both in different prompt sections so the model can tell them apart.

### Alternatives, integration, risks

Unified store for pinned + inferred rejected — different trust models, different privacy defaults, different UI affordances; conflating them is the original Letta sin v0.4 fixed. Auto-fill profile from observed actions (scrape shipping address from a checkout) rejected — privacy disaster surface (the agent saw a credit card and now offers to "remember" it). Templated profile (Name/Address/Diet) rejected — too rigid; useful preferences are unpredictable ("aisle seats", "ship to office on weekdays"). `src/sidepanel/Profile.tsx` — list + add + edit + delete + pin toggle. `src/agent/state_store.ts` — `loadProfile`, `saveProfile`, plus per-block CRUD. `src/agent/prompts/planner.ts` — pinned profile is a new top-of-prompt section. Bloat — users will pin too much; injection cap means the user sees "5 above the line, 12 below" and can prune. PII in profile lives in `chrome.storage.local` — extension-local, not encrypted at rest; document threat model. Profile vs `agent.reset` semantics: reset clears task state, NOT profile.

---

## Feature 4: Implicit preference learning

### Recommendation — and honest verdict

**Don't attempt fully-implicit learning on a 4B model. Do attempt Reflexion-style explicit-lesson capture, gated to end-of-task and to user confirmation.**

Reflexion's lesson schema (`noahshinn/reflexion/reflexion/agents.py`): after a trial, the model writes one short reflection — "next time I should X because Y" — appended to a buffer the next trial reads at prompt top. A *narrow* form of implicit learning: not "the user always does X" but "when the goal looks like X, do Y." Achievable on 4B because the prompt explicitly asks for it, not relying on emergent generalization.

Concrete plan: Curator emits two channels — `facts: ArchivalFact[]` and `lessons: ReflexionLesson[]`. Lessons store in archival with `kind: 'lesson'`. Same cosine retrieval path, but the prompt block is labelled `LESSONS FROM PRIOR TASKS` so Planner knows these are heuristics. Lesson starts `accuracy='guess'`. After 3 successful tasks without contradiction → `confirmed`. Contradictions reset to `guess`. Crude, but honest.

What 4B **cannot** reliably do: pure observational generalization ("user always picks the cheapest") requires statistics over actions, not text; multi-modal preference inference ("user dismissed an ad → dislikes brand") not happening at 4B without an absurd scaffold; cross-domain transfer leaks. Trigger-embedding gating helps but doesn't guarantee — accept that recall sometimes leaks across domains and rely on Planner thinking-mode reasoning to ignore irrelevant lessons.

**Honest verdict on feasibility**: explicit lessons gated by end-of-task Curator + user confirmation will work; fully-emergent implicit preference learning will not work on qwen3.5:4b and is not worth chasing for v1. If we ever want it, it lives behind the user's qwen3.6:35b-a3b on the Linux box, run as an offline "sleep-time" pass — separate stream.

### Integration & risks

Same as Feature 2's Curator, second JSON sub-array. `archivalWrite` accepts `kind: 'fact' | 'lesson'`. Wrong lessons stick — `accuracy='guess'` with visual hedge in UI. Surveillance feel — per-task opt-in ("Save lessons? [yes][no, just this once]") and global toggle. Promotion count default 3, tunable. Lesson decay (half-weight every 90 days) is a Feature 9 concern.

---

## Feature 5: Multi-tab synthesis

### Recommendation

A new `tabs.synthesize` tool that takes `tabIds: number[]` and an optional `question: string`, calls `aria.extract` per tab capping each at ~1500 chars (not 4000), concatenates under labelled `### TAB n: <url>` headers, and routes the union through a Compactor-shaped role (the **Synthesizer**) with rubric "given these N extracts, produce a structured cross-tab summary keyed against the user's question." Returns `{summary, perTab, conflicts}`.

Token economy on 6K Executor budget × 4B: per-tab 1500 chars (~375 tokens) × 3 tabs = 1125 tokens + ~1500 scaffolding. Comfortably under 4K. Synthesizer inherits compactor budget (8K), JSON mode. Don't reuse Compactor function directly — different rubric — but copy structure. Output is one Finding `kind='sub-answer'`, `key='cross_tab_summary_<ts>'`.

What `crawl4ai` does worth borrowing: their `chunking_strategy` interface lets you swap chunk-then-summarize impls (regex / sliding-window / semantic). Label-by-tab covers Phase 1; semantic chunking is later when a single tab itself overflows.

### Alternatives, integration, risks

Sequential per-tab summary rejected — the user's intent in "summarize" *is* the cross-tab synthesis. Single big Executor call rejected — blows 6K at 3+ tabs and puts cross-tab reasoning in the wrong role. Embedding-clustering rejected — only useful at 50+ tabs. `src/agent/tools/browser/tabs_synthesize.ts` (tool). `src/agent/roles/synthesizer.ts` (~80 lines, mirrors `compactor.ts`). `src/agent/prompts/synthesizer.ts` rubric: "find common entities, divergent claims, and the answer to the user's question." The 4000-char cap in `aria.ts` becomes a parameter. Cross-origin iframes are Stream 1 territory. Synthesizer hallucinating consensus when tabs disagree — rubric explicitly asks for `conflicts: string[]` and rewards listing disagreements. 0-tabs default: use active tab. Auto-archive cross-tab summaries: lean no.

---

## Feature 6: Bookmark / history integration

### Recommendation

Three concentric circles, smallest first:

1. **Read-only signal at retrieval time** (start here). When the Planner does its top-k archival recall, also `chrome.history.search({text: goalKeywords, maxResults: 20})` for the past 30 days; rank with last-7-days boost and bookmarked-domain boost. Inject a `RECENT BROWSING SIGNAL` block (≤3 entries: title + domain + days-ago) under `KNOWN FINDINGS`. Titles only.
2. **Pull-on-demand tools.** `history.search(query, since?)` and `bookmarks.list(folder?)` as Executor tools — Planner can route "find that article I read last week" → `history.search`. Returns title+URL+timestamp lists, capped at 20.
3. **Optional indexing pass** (later, behind a setting). Per bookmark, run `aria.extract` once at idle, summarize via Compactor, store `scope='user'`, `source='imported'`. Privacy gate: opt-in per folder, "purge imported memories" button.

### Alternatives, integration, risks

Auto-import all history rejected — privacy disaster, embedding cost (10K items × 50ms = 500s), most history is junk. External fts5/SQLite wrap rejected — `chrome.history.search` already does substring matching across the user's whole history server-side (Chrome's process, not network). `src/manifest.ts` — add `"history"` and `"bookmarks"` permissions (loud Chrome warnings on update). New tools register in `createDefaultRegistry()`. `runPlannerStep` — optional `historySignal` injection alongside `relevantMemories`. Phase as Stream 5 "advanced" toggle, default OFF; explain in onboarding (data lives locally, never sent off-device). Sensitive history (bank, healthcare, employer): user-editable domain blocklist, post-filter at the tool boundary. Default time window 30 days. Expose bookmark folder structure via `bookmarks.list`.

---

## Feature 7: Reading list integration

Treat Chrome's reading list as a **deferred goal queue**. New side-panel surface "Polaris will read these": entries from `chrome.readingList.query({})`, each with a "Have Polaris read this" button that opens the URL in a background tab, runs `aria.extract` + Synthesizer (Feature 5), produces a Finding `kind='sub-answer'` summary, and optionally archives (`scope='user'`, `source='imported'`) on user confirm. Reading-list integration is *explicit* — the user already said "I want to read this later"; the agent offers to do it for them. No surprise indexing. `src/manifest.ts` — add `"readingList"` permission. `src/sidepanel/ReadingList.tsx` — new pane. No new agent code — workflow is "user clicks button → goal created → existing agent loop runs." Paywalled / login-gated articles work because `chrome.tabs.create` inherits user session. Mark items read on completion via `chrome.readingList.updateEntry`: default yes, settings to disable.

---

## Feature 8: Cross-device sync — out of scope

Why: **local-first, no-data-leaves-machine** is the project's privacy contract — `chrome.storage.sync` would push memory blobs to Google's servers, direct violation. **End-to-end-encrypted sync** (user keypair, server blobs) is meaningful work — key management, conflict resolution, schema evolution across devices — and not Phase 1. **Local-network sync** (laptop ↔ desktop on same LAN, WebRTC) is interesting but premature. If sync ever lands, separate stream.

---

## Feature 9: Memory eviction policy

Layered eviction, simplest first, per store:

| Store | Trigger | Policy |
| --- | --- | --- |
| `scratchpad` | Compactor (existing) | scratch deleted after compaction |
| `findings` (per task) | task → terminal, age > 30d | keep only those promoted into archival; bulk-delete rest |
| `archival` | size cap (5000 rows OR 50 MB) | LRU on `lastAccessedAt`, `accessCount` tiebreaker; never auto-evict `source='user'`; `scope='global'` evicted last |
| `events` | task lifetime | no change |
| `memory` | task → terminal | `resetTask(taskId)` |

Eviction runs on `chrome.idle.onStateChanged` once a day, not in the hot path. Walks archival, computes total size (`text.length + embedding.length*4`), and if over cap, deletes bottom-quartile by `lastAccessedAt`. User-curated rows (`source='user'`) never auto-evicted.

User-controlled: side-panel "Memory" pane lists archival rows with delete button. "Forget everything from before <date>" sweep is one click.

### Alternatives, integration & risks

TTL only — too crude. Manual only — IDB will fill, eventually error. `src/agent/state_store.ts` — `evictArchival(targetMaxBytes)`. New `agent/idle.ts` hooks `chrome.idle.onStateChanged`. Tombstone on user-deletes — mark `evicted: true, evictedAt` for 30 days before actual deletion, restore button in UI. Soft cap with warning, hard at 1.5×.

---

## Feature 10: PII redaction in scratchpad

### Recommendation

**Two layers**: regex pre-filter on every scratchpad write (cheap, always on) + per-finding privacy tag (Compactor and Curator emit it).

**Layer 1 — regex pre-filter** (`src/agent/safety/pii_redactor.ts`):

- Patterns: SSN (`\d{3}-\d{2}-\d{4}`), full credit card (`\d{16}` with Luhn), credit-card middle-digits (keep first/last 4), email when paired with `password|otp|verification`, phone (`(\d{3})?\s?\d{3}-\d{4}`). Street addresses: high false-positive — log not redact in v1.
- Action: replace with `[REDACTED-<KIND>]` on `payload` strings before `appendScratch`. Catches the common case of an agent scraping a checkout page and putting card number in scratchpad. The card never lands in IDB.

**Layer 2 — privacy tag** (already in Finding/Passage schemas): `Finding.privacy: 'public' | 'pii' | 'sensitive'`. Compactor writes from a rubric: PII for addresses/phones/emails; sensitive for medical/financial/auth; public otherwise. Archival passages inherit; a `pii` passage retrieved into Planner prompt gets a visible `[PII]` marker. UI's Memory pane visually differentiates.

Not in v1: real NER (spaCy/Presidio) — too heavy for the SW. Encryption at rest — IDB is plaintext; threat model is "the user's own machine is trusted; nothing leaves it." Document explicitly.

### Integration & open questions

Pure `redactPII(text) → {redacted, hits}`. Called from `appendScratch` *before* token estimation, so we don't bill the user for redacted bytes. Compactor + Curator prompts gain a `Tag each output's privacy as 'public' | 'pii' | 'sensitive'.` line. False-positives on real text "412 Broadway St" — acceptable, the model still has page context. User-visible "redaction count" telemetry — modest yes.

---

## Cross-cutting: IDB schema

DB version bump 1→2. Additive only — existing stores untouched.

```ts
archival: {
  key: 'id';                            // ULID
  value: ArchivalPassage;
  indexes: {
    'by-scope-owner': ['scope', 'ownerId'];
    'by-tag': 'tag';
    'by-last-accessed': 'lastAccessedAt';
    'by-kind': 'kind';
  };
}
// findings — additive, optional fields default-fill on read like loadHot's BreakerState pattern
finding.privacy?: 'public' | 'pii' | 'sensitive';
finding.embeddingModel?: string;
```

User profile lives in `chrome.storage.local['polaris.profile']` (≤2 KB even verbose, no IDB pressure). Lessons share the archival store with `kind: 'lesson'` discriminator. Letta uses the same trick (`Passage.metadata.type`); a single retrieval call can fetch facts and lessons together or filter to one. Migration: `idb.ts` `upgrade()` for v2 = `createObjectStore('archival')`, leaves the existing four stores. Forward-fill of optional fields in `state_store.ts` mirrors the existing `loadHot()` `BreakerState` pattern.

---

## Cross-cutting: retrieval flow

When does memory retrieval happen? **Two timings, no more.**

**Timing 1: Start of every Planner call** (initial + replan):

```text
runPlannerStep(state, isInitial, replanHint?)
  ├── (existing) findings = findingsByRecency(state.taskId, 20)
  ├── (NEW)      profile = loadProfile()                               // pinned blocks
  ├── (NEW)      memories = archivalSearch(state.goal.text, k=3, scope='user')
  ├── (NEW)      historySignal = chrome.history.search({...})          // gated by setting
  ├── (existing) plannerSystemPrompt({goal, profile, memories, historySignal, findings, ...})
  └── (existing) call Ollama
```

Why here: Planner is the only role that decides plan shape; cross-task memory injected at Executor turn N changes nothing about the plan, just adds noise.

**Timing 2: On-demand via tools.** When Executor needs specific recall ("did we research this product before?"), it calls `memory.archival_search(query, k)` directly.

What we explicitly do **not** do: inject archival on every Executor turn (token-economy disaster on 6K), into the Compactor (its job is local: scratch → findings), or into the Evaluator. Retrieval cost per Planner call: ~155 ms (1 embed + cosine + 1 history search). Negligible against a 30+s Planner LLM call.

---

## Implementation order

Each step builds on its predecessors:

1. **Feature 10 regex layer.** Lands first — every later feature persists data that may contain PII. ~50 lines, no UI.
2. **Feature 1 (archival store + 3 tools).** Foundation. Test with the canonical "write 'I prefer aisle seats' from one task, read from another."
3. **Feature 3 (explicit profile).** Independent of archival; small UI; immediate user-visible win not depending on Curator working.
4. **Feature 9 (eviction).** Lands before archival grows organically. Idle hook + LRU.
5. **Feature 2 (Curator + Planner-time injection).** When the agent becomes "personalized." Largest single change.
6. **Feature 4 (lessons via Curator second channel).** Small delta on Feature 2.
7. **Feature 5 (multi-tab synthesis).** Independent of memory but built on the same Compactor-shape pattern.
8. **Feature 6 (history & bookmarks).** Phase: read-only signal first, on-demand tools second, indexing pass much later or never.
9. **Feature 7 (reading list).** Smallest UI, leverages everything.
10. **Feature 10 privacy-tag layer.** Compactor + Curator emit `privacy:` tags; UI badges.

Feature 8 is out of scope. Milestone breakdown: 1–4 = M5 / "personalization core"; 5–7 = M6 / "multi-context"; 9 ongoing; 10's regex with M5, tag layer with the next Compactor change.

---

## Open questions for the user

1. **Trust default for Curator-promoted memories**: confirmation popup ("Save these 3 things? [yes][no]") or default-yes with "review later"? My read: confirmation popup for v1, revisit after a month.
2. **Cross-task memory scope**: single global "user" scope, or per-domain (shopping vs research)? Single is simpler; per-domain reduces cross-contamination but complicates UX.
3. **Profile editing surface**: standalone Profile pane, inline chat (`/profile add address: ...`), or both? Both — inline as a slash-command alias.
4. **History permission default**: prompt on install, or behind "advanced" toggle off-by-default? Off-by-default is privacy-respectful.
5. **Embedding model lock-in**: switching from `mxbai-embed-large` later means re-embedding (or losing recall on old rows). Acceptable? Yes — store `embeddingModel` per row, ship a one-shot "re-embed" command.
6. **Lesson confirmation count**: tasks of agreement before `guess → confirmed`? Default 3, tunable.
7. **Archival hard cap**: 5000 rows / 50 MB right? Tunable; absolute from Chrome's IDB quota (~60% of free disk on partition). Worth telemetering.
