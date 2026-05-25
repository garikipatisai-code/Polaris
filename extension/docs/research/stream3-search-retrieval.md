# Stream 3 — Search & Retrieval (Implementation Playbook)

**Status:** Research; nothing in this file ships until reviewed.
**Date:** 2026-05-24
**Scope:** The retrieval surface that lets a 4B local model find, rank, archive, and re-find information across a long-running task. Closes the Perplexity-Comet gap (smart search + cross-source synthesis) without any cloud dependency.
**Reference repos:** `~/Documents/Spike/Personal/Browser/refs/` is **not** present. Citations to `letta-ai/letta`, `unclecode/crawl4ai`, `web-arena-x/webarena`, `langchain-ai/langchain` are from training data — cross-check before implementation.

---

## Overview

Two triads frame everything below.

**The search-engine triad.** Where queries go: (1) DuckDuckGo HTML — already wired in `src/agent/tools/browser/search.ts`, zero key, brittle markup; (2) **SearXNG self-hosted** — the recommended primary, zero key, JSON, aggregates 70+ upstreams, runs as a Docker side-car next to Ollama; (3) Brave Search API — 2 000 q/mo free, JSON, opt-in fallback. Tavily (cloud-only, trial-tier) and SerpAPI (paid) are pluggable but not defaults.

**The embedding-retrieval triad.** How findings come back across long tasks: (1) lexical key-recall via the existing `findingByKey()`; (2) **cosine over `mxbai-embed-large` (1024-d)** as primary semantic recall — `OllamaClient.embed()` is already wired in `src/background/ollama.ts:390`; (3) hybrid lexical+semantic fusion deferred until quality data demands it.

The `Finding` interface in `src/shared/agent_types.ts:154` already pre-declares `embedding?: number[] | null`. Scaffolding is in place; the index path and read-side API are not.

**Privacy posture.** Embedding is local (mxbai on Ollama). Cross-task index lives in IndexedDB. The default search path (SearXNG → DDG) routes through the user's Linux box or a privacy-respecting public engine; no query leaves the box unless the user opts into a cloud engine.

---

## Feature 1 — Multi-engine search with fallback

**Recommendation:** **SearXNG self-hosted as primary**, DDG HTML (current) as fallback, Brave API as opt-in third tier. SearXNG aggregates Google/Bing/DDG/Brave/Wikipedia and returns deduplicated, ranked JSON (`{url, title, content, engine}`) — broader coverage than any single source and a stable contract. Adding `searxng/searxng:latest` next to Ollama is one container.

**Why not DDG-as-default forever:** noscript markup is one Cloudflare config change from breaking; aggregator JSON beats string-parsing brittleness; coverage is higher (DDG ~15 results, SearXNG 30–50).

**Alternatives:** Tavily — cloud, LLM-tuned, trial-tier; pluggable. SerpAPI / Bing — paid. Kagi — paid; pluggable for Kagi users. Common Crawl — months-stale; sleep-time only.

**Integration.** Refactor `searchTool` in `src/agent/tools/browser/search.ts` to delegate to a new `MultiEngineSearch` orchestrator. The existing `parseDuckDuckGoResults` becomes the DDG adapter's parser. Tool args grow `engine?: 'auto' | 'searxng' | 'ddg' | 'brave'` (default `'auto'`). Settings panel: SearXNG URL, optional Brave API key, preferred order.

**Dependencies.** None new at runtime; settings UI work; SearXNG image must run with `formats: [json]` in `settings.yml` and reachable CORS — document in `README.md` as we did for `OLLAMA_ORIGINS`.

**Risks.** SearXNG misconfig (default image is HTML-only); ship a `docker-compose.yml`. Adapter drift on DDG markup — schedule a CI canary as M5 polish. Aggregator silent degradation when Google flags the user's IP — `MultiEngineSearch` falls through to DDG.

**Open questions.** Does SearXNG on the same Linux box as Ollama (different ports) hit MV3 CORS pain we haven't seen? Probably not, but verify on the Linux box.

---

## Feature 2 — Reranking

**Recommendation:** **Embedding-cosine reranker using `mxbai-embed-large`**, not a cross-encoder. Embed query and each `title + " " + snippet`, compute cosine, return top-K (default K=3 from N=10).

**Why cosine, not a cross-encoder:** a 110 M-param cross-encoder (e.g., `bge-reranker-base`) needs N forward passes on the hot path — 1–3 s per search on the P2200, on top of every DDG/SearXNG call. It's also another model competing for 5 GB VRAM with `qwen3.5:4b` and `mxbai-embed-large`. mxbai is already loaded; 11 embeddings batched in one `client.embed` call is ~150–250 ms wall on the Linux box. The quality gap (cross-encoders typically win 3–8 nDCG points on MS-MARCO) doesn't move "did the model open the right 3 of 10," which is what matters here.

**LLM-as-reranker (qwen3.5:4b decides which 3 to open) rejected:** even thinking-OFF, 10 candidate strings + a "pick the best 3" prompt is 1–2 K input tokens and ~5–10 s wall on the Executor's hot path. Self-defeating — we rerank precisely to keep Executor turns small.

**Algorithm:** see "Reranking algorithm sketch" below.

**Integration.** New `src/agent/retrieval/rerank.ts` exporting `rerankByEmbedding(client, query, results, opts)`. `searchTool` flag `rerank?: boolean` (default `true`). The orchestrator's existing `OllamaClient` reaches the tool via `ToolContext` — extend the context interface (currently `{taskId, stepId}` in `registry.ts:17`) to optionally include `client`.

**Dependencies.** None new.

**Risks.** mxbai not pulled — detect at first call, fall back to engine order, surface a one-time warning in Settings. VRAM contention — mxbai is ~670 MB, qwen3.5:4b ~2.5 GB; both fit on 5 GB but `keep_alive: '10m'` must be set on `embed()` calls (the chat path already does this).

**Open questions.** Should the Planner see absolute scores? Risk: the model may treat them as semantic anchors when they're only relative. Probably emit only when the agent explicitly asks for them.

---

## Feature 3 — Embedding-based archival retrieval

**Recommendation:** **Lazy embedding on compaction**, not on every `appendFinding()`. Vectors live in a separate IDB store, not on the `findings` row. New tool `archival.search`. Pattern is the MemGPT/Letta one (Letta's `letta/services/agent_manager.py` ships `archival_memory_search` and `archival_memory_insert` against the same shape).

**Three design choices:**

1. **When to embed: on compaction.** The compactor already runs as a non-hot-path role. Embed right after `appendFinding()` so the embedding write is in the same transactional unit. Avoids embedding draft scratchpad noise that gets thrown away.
2. **What to index: `key + ": " + value` joined.** The `key` carries the symbolic "what" (`amazon_price_acme_widget`), the `value` carries the dense fact ("$24.99 in stock as of 2026-05-23"). Embedding the join captures lexical and semantic signal both. Keep `evidence` *out* of the embedding — URLs pull the vector toward URL-shape, not meaning.
3. **Schema: separate `findingEmbeddings` store keyed by `findingId`.** Inlining the 1024-d float32 vector (~4 KB JSON-stringified) on the `Finding` row blows up `findingsByRecency()` cost ~50× because every read pays full deserialization. Separate store is cheap to JOIN at retrieval time and free for the hot path. The existing `embedding?` field on `Finding` stays as legacy `null` for forward compatibility.

**Alternatives.** Embed on write — wastes ~50 ms × N draft entries that compactor discards. HNSW (`hnswlib-wasm`) — overkill; linear scan over 10⁴ × 1024-d in JS is ~10 ms of dot products, plenty fast for personal scale. SQLite-vec via `wa-sqlite` — adds a 600 KB WASM blob and a SQL surface we don't need. Cloud vector DB — violates privacy posture.

**Retrieval API.** `archivalSearch(query, { taskId?, topK?, minScore? })` — embed query, load `findingEmbeddings` filtered by `taskId` (if scoped) via `getAll`, cosine-rank, fetch top-K finding rows. Cross-task by omitting `taskId`.

**Integration.** New module `src/agent/retrieval/archival.ts`. New tool `archival.search` registered in `src/agent/tools/index.ts`. Compactor's flush path (`src/agent/roles/compactor.ts`) extended: after `appendFinding()`, call `embedAndIndex(finding)` (best-effort; failure logs but doesn't break compaction). Admin function `rebuildIndex(taskId?)` for schema-bump migrations.

**Dependencies.** None new.

**Risks.** Cold-task latency: at 10 K vectors `getAll` + parse is ~200 ms, cosine ~100 ms — inside our 1 s headroom. At 100 K we revisit HNSW. `chrome.storage.local` 10 MB cap — vectors live in IDB, not local — but the optional hot-task index (see schema sketch) must stay disciplined. Embedding-model drift: `schemaVer` field plus `rebuildIndex()` migration covers a model upgrade.

**Open questions.** Cross-task search default ON or OFF? Privacy posture says OFF, utility argues ON. Per-finding TTL? `cosine * exp(-age_days / 30)` is a 30-day half-life knob worth piloting.

---

## Feature 4 — History-aware ranking

**Recommendation:** Use `chrome.history.search()` to weight results, but show the boost silently. Multiply cosine score by `(1 + log1p(visitCount) * 0.1)` capped at 1.5× when the URL was visited in the last 30 days. Calls are <5 ms.

**Why silent.** Comet shows "Visited yesterday" pills — pleasant but a privacy-leak surface. Polaris's differentiator is privacy-as-default. Effect-first; surface a "★ visited" icon behind a Settings toggle.

**Alternatives.** Embedding visited-page contents — already covered by archival findings. `chrome.bookmarks` — worth a small boost (×1.2); add to the same hook. Pure popularity boost — rewards SEO-spam; reject.

**Integration.** `src/agent/retrieval/history_boost.ts` exports `applyHistoryBoost(results)`. Plugged in `searchTool.execute` after rerank, behind setting `searchHistoryBoost: boolean` (default true). Manifest needs `"history"` permission added.

**Dependencies.** `"history"` in `src/manifest.ts`.

**Risks.** Permission scare at install ("Polaris wants to read your browsing history"). Mitigate with clear copy in Settings about local-only use. Privacy boundary: history data must never leave the box; the boost is computed locally and SearchResult objects don't carry history fields after.

**Open questions.** Default ON or OFF? Local-first default suggests ON — users opt out, not in.

---

## Feature 5 — Site-search via the page's own search box

**Recommendation:** Build it as a separate `site.search` tool, not as a flag on `search`. Distinct semantics, distinct failure modes. Tool takes `{ url, query }`, navigates (`tab.open`), `aria.extract`, locates the search input by ARIA role `searchbox` (or by placeholder/aria-label match), types the query, submits, re-extracts. **Blocked on Stream 2** delivering CDP `type` and `keyPress` tools first.

**When site-search beats web search.** Long-tail products (obscure SKUs on McMaster-Carr); authenticated content (internal docs, GitHub issues you're logged into); live availability (Ticketmaster, OpenTable); faceted catalogs ("Best Buy laptops 16GB under $800").

**When web search wins.** Comparison across multiple sites (the original Polaris use case); discovery (you don't know which site); reviews/forums.

**`findSearchInput` precedence.** `role=searchbox` first; then `textbox|combobox` whose `name`/`aria-label`/`placeholder` matches `/search|find|look up/i`; then the first `combobox` with a magnifier-icon child. Same pattern Browser-use uses.

**Integration.** New tool `src/agent/tools/browser/site_search.ts`. Composes existing `tab.open`, `aria.extract`, plus Stream 2's pending `type` and `keyPress`.

**Risks.** No-search-box fallback (some sites bury search behind a nav button) — throw `{fatal: false}`, agent falls back to web. CAPTCHA on submit — pause for user (M5 polish). Anti-bot blocks reduced (not eliminated) by Stream 2's CDP-real-events approach.

**Open questions.** How does the agent decide web-vs-site? Heuristic in the Planner prompt: if goal mentions a site by name, prefer site-search; if comparison-shaped, prefer web.

---

## Feature 6 — News / academic / image verticals

**Recommendation:** Add `arxiv.search` and `scholar.search` (Semantic Scholar). Skip news and image verticals for Phase 1.

**Why these two.** arXiv: clean Atom XML at `export.arxiv.org/api/query`, no key, decades-stable, returns title+abstract+authors+URL in one round-trip. Semantic Scholar: free 100 req/5min, returns citation counts and abstracts.

**Why skip the others.** Google Scholar — scrape-only, hCaptcha-gated, rate-limit hell. NewsAPI — 100/day free but cloud and key-gated; SearXNG's `categories=news` covers it for free. Image search — vision pipeline isn't ready to consume.

**Integration.** `src/agent/tools/research/arxiv.ts` and `.../scholar.ts`. Each is a thin `fetch + parse` tool. Cite-able outputs match the synthesis pattern below.

**Dependencies.** None new at runtime. arXiv returns Atom XML — write a 30-line regex parser like the DDG one rather than pulling `fast-xml-parser`.

**Risks.** Broad arXiv queries balloon — cap result count at 10, abstract at 800 chars.

**Open questions.** Is news a Phase-1 need? Shopping-deals doesn't need it. Defer.

---

## Feature 7 — Search-query reformulation

**Recommendation:** **Multi-query decomposition by the Planner**, not the Executor. The Planner has thinking ON, runs rarely, and tolerates higher latency. It emits `searchPlan: { queries: string[], rationale }` (1–4 queries) when the goal needs search. The Executor then runs each through `search` and aggregates by URL dedup → rerank.

**Why on the Planner.** Thinking ON lets it reason about which facets need separate queries. The Executor's 6 K hot-path budget can't tolerate an extra LLM call per search. Putting decomposition in the plan means queries survive replan as a debuggable artifact.

**Alternatives.** Self-Ask (the 2022 paper) — verbose, doesn't fit a 4B Executor. Chain-of-Verification (CoVe) — 2× the latency on the hot path. HyDE (Hypothetical Document Embeddings) — marginal on web search where titles+snippets are already query-shaped; worth experimenting on archival, not web.

**What works on a 4B model.** It's *good* at decomposition when the prompt enumerates "produce queries that cover X, Y, Z aspects" with 1–2 examples. It is *bad* at deciding whether to decompose unprompted. Recommend: always emit `queries[]` (length 1 if no decomposition), always run all, dedupe.

**Integration.** Extend `src/agent/prompts/planner.ts` with a search-eligibility heuristic and a `searchPlan` schema field; `roles/planner.ts` validates with Zod. Executor prompt injects `Suggested queries: [...]` when present and runs each.

**Dependencies.** None new.

**Risks.** Three queries × 10 results × ~500 ms each is 1.5 s before rerank. Cap at 3. Over-decomposition ("Apple Watch Ultra 2 deals" → "Apple Watch", "Ultra 2", "deals") — mitigate via prompt examples and a "only decompose if queries cover *different* aspects" floor.

**Open questions.** Should the Executor be allowed follow-up queries beyond the Planner's list? Yes, via the existing `search` tool, bounded by turn budget — Planner's queries are opening moves, not the only moves.

---

## Feature 8 — Cross-source synthesis

**Recommendation:** **Map-reduce in the Evaluator.** Executor opens 3 result pages → Compactor folds each into 2–5 atomic findings keyed `source_<n>_<topic>` with the URL in the `evidence` field → Evaluator (8 K budget, thinking ON) synthesizes the answer with `[N]`-style citations tied to evidence URLs. This is the LangChain `MapReduceDocumentsChain` pattern; Letta's `letta/agent.py` archival recall uses the same shape.

**Why not in the Executor.** 3 pages × ~1 K compacted tokens + question + scaffolding ≈ 4 K — fits inside 6 K but leaves only ~2 K for output. Evaluator's 8 K is more comfortable for thoughtful synthesis. The Evaluator already runs on the periodic verdict cycle; layering "and write the synthesis" into that call is one prompt change.

**Token economy for 3 sources.** 3 × `aria.extract` raw = 12 K (transient, never co-resident); Compactor reduces to ~560 tokens; +query +instructions +citation scaffolding ≈ 1 500 prompt tokens; output 600–1 200. 6+ sources need hierarchical merging (Compactor → mid-summary → Evaluator), same pattern recursively, deferred.

**Citation contract.** `Finding.evidence` (already exists in `agent_types.ts:152`) holds the URL. Evaluator prompt instructs `[N]`-style markers. Side-panel renders `[N]` as clickable links to evidence URLs. Post-validation pass: every emitted `[N]` must resolve to a finding's `evidence`; orphan markers are stripped (the claim stays).

**Integration.** `src/agent/prompts/evaluator.ts` gains a synthesis branch when `verdict='done'` and ≥ 2 evidence-bearing findings exist. Schema becomes `finalAnswer: { text, citations: [{n, url}] }`. Side-panel renders.

**Dependencies.** None new.

**Risks.** Hallucinated citations — covered by the post-validation pass. 10+ sources blow Evaluator budget — hierarchical merging (M5+).

**Open questions.** Should the user be able to ask "expand on [3]"? Implies the citation list is interactive with the agent loop, not just the UI. Defer to M5.

---

## Feature 9 — Caching / dedup

**Recommendation:** IDB-backed cache keyed on `(engine, normalizedQuery)`, TTL 1 h general / 5 min news / infinite for academic. New IDB store `searchCache` (DB_VERSION 1 → 2 alongside `findingEmbeddings`). `MultiEngineSearch` checks the cache before any network call.

**Schema.** See "Indexing schema sketch" below.

**Normalization.** `query.toLowerCase().trim().replace(/\s+/g, ' ')`. Lowercase + collapse — no stemming or stopword removal, those over-collapse and hurt recall.

**Eviction.** Every Nth write, scan `by-fetched` index, delete entries past `fetchedAt + ttlMs`. Hard cap 500 entries via LRU. Single pass.

**Alternatives.** No cache — wasteful and disrespectful to upstream engines. `chrome.storage.local` cache — fast but eats the 10 MB state budget; IDB is right. Cache the `queryEmbedding` alongside results — saves the 50 ms reembed on a hit; add once cosine rerank is stable.

**Integration.** `src/agent/retrieval/search_cache.ts`. Wraps `MultiEngineSearch`. Miss → query → store. Hit → return with `cached: true` flag.

**Dependencies.** None new (existing `idb` package).

**Risks.** Stale results — TTL 1 h is a guess; live prices stale at 1 min, Wikipedia at days. Tool args could carry `freshness?: 'live' | 'normal' | 'archival'` hints. Privacy — a persistent search-query log; local-only, but disclose with a "Clear search cache" Settings button.

**Open questions.** Per-task or global cache? Global is more useful (same product question across tasks). Default global.

---

## Indexing schema sketch

The retrieval layer touches both substrates we already use plus a small hot-index.

### IDB stores (DB_VERSION 1 → 2)

```ts
// src/agent/idb.ts
export interface PolarisDB extends DBSchema {
  // existing: scratchpad, findings, memory, events ...

  findingEmbeddings: {
    key: string;                  // findingId (ULID)
    value: {
      findingId: string;
      taskId: string;
      vec: number[];              // 1024-d float32 (~4 KB JSONified)
      indexedAt: number;
      schemaVer: 1;
      text: string;               // exact text embedded; ≤ 384 chars
    };
    indexes: {
      'by-task': string;
      'by-indexedAt': number;     // for re-index ordering
    };
  };

  searchCache: {
    key: string;                  // `${engine}:${sha1(normalizedQuery)}`
    value: {
      engine: string;
      query: string;
      normalizedQuery: string;
      results: SearchResult[];
      fetchedAt: number;
      ttlMs: number;
      bytes: number;
      queryEmbedding?: number[];  // optional, populated after first rerank hit
    };
    indexes: { 'by-fetched': number };
  };
}
```

Migration: forward-only on `upgrade(db, 1, 2)` — create both stores plus indexes. Existing findings keep `embedding: null` and are lazily indexed on first archival query for their task.

### chrome.storage.local hot index (optional, opt-in)

```ts
polaris.archival.hot = {
  schemaVer: 1,
  byTask: {
    [taskId: string]: {
      keyPrefixes: string[];      // 8-char prefixes of `key` field, deduped
      lastIndexedAt: number;
    };
  };
}
```

A coarse "what is this task about" gate so cross-task queries skip irrelevant tasks before any IDB work. Total ≤ 100 KB across all tasks.

**Why not vectors in `chrome.storage.local`.** A single 1024-d float32 array is ~4 KB JSON. 100 findings × 50 tasks = 20 MB — past the 10 MB practical cap. IDB has no cap that matters at this scale.

---

## Reranking algorithm sketch

End-to-end, as it would land in `src/agent/retrieval/rerank.ts`:

```ts
import type { SearchResult } from '../tools/browser/search';
import type { OllamaClient } from '../../background/ollama';

export interface RerankOptions {
  topK?: number;             // default 3
  embedModel?: string;       // default 'mxbai-embed-large'
  minScore?: number;         // default 0
}

export async function rerankByEmbedding(
  client: OllamaClient,
  query: string,
  results: SearchResult[],
  opts: RerankOptions = {},
): Promise<(SearchResult & { score: number })[]> {
  const { topK = 3, embedModel = 'mxbai-embed-large', minScore = 0 } = opts;
  if (results.length === 0) return [];
  const texts = [
    query,
    ...results.map((r) => `${r.title}. ${r.snippet ?? ''}`.slice(0, 384)),
  ];
  const embs = await client.embed(embedModel, texts);
  if (embs.length !== texts.length) {
    return results.slice(0, topK).map((r) => ({ ...r, score: 0 }));
  }
  const q = embs[0];
  const scored = results.map((r, i) => ({ ...r, score: cosine(q, embs[i + 1]) }));
  return scored.filter((r) => r.score >= minScore).sort((a, b) => b.score - a.score).slice(0, topK);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
```

**Cost per rerank (10 candidates):** one batched `client.embed` with 11 strings; ~150–250 ms on the Linux box. Cosine pass is microseconds.

**Quality estimate:** 1024-d cosine reranking over 10 web-search candidates typically lifts top-3 recall 10–20 % vs engine-native order; lift is at the high end on shopping-deal queries because product names are token-dense and discriminative. Cross-encoders (bge-reranker-base) lift another 3–8 % — not worth the VRAM contention against qwen3.5:4b for Phase 1.

**Failure mode:** `client.embed` returns nothing (Ollama down, model unavailable) → fall back to first-N engine order. Logged once per session; surfaces in Settings as "embeddings unavailable."

---

## Implementation order

1. **Search-engine triad** (Feature 1) — SearXNG adapter + multi-engine fallback. 2–3 days. Closes the "DDG breaks, no backup" risk first.
2. **Reranking** (Feature 2) — one module, one tool flag, one test. 1 day. Depends on (1) only structurally.
3. **Cache** (Feature 9) — trivial layer over the engine adapter. 1 day. Eliminates duplicate network calls for everything below.
4. **Archival retrieval** (Feature 3) — IDB schema bump, embed-on-compaction, `archival.search` tool. 3–4 days. Depends on (2) for cosine reuse.
5. **Query reformulation** (Feature 7) — Planner prompt + Executor consumes `searchPlan`. 1–2 days.
6. **Cross-source synthesis** (Feature 8) — Evaluator prompt branch + side-panel citation rendering. 2 days.
7. **History-aware ranking** (Feature 4) — manifest perm + boost layer. 1 day.
8. **arXiv + Semantic Scholar** (Feature 6) — two thin tools. 1–2 days each.
9. **Site-search** (Feature 5) — blocked on Stream 2's CDP `type` / `keyPress`.

Rationale: build search infrastructure (engines, cache, rerank), then durable retrieval (archival), then the smarts that depend on them (reformulation, synthesis), then conveniences (history, verticals), then page-action-dependent (site-search).

---

## Open questions for the user

1. **Will the user run SearXNG on the Linux box?** Recommended primary, but adds operational dependency. If "no, keep DDG," re-rank Feature 1 priority and lean harder on the cache to soak rate-limit risk.
2. **Manifest `"history"` permission — Phase 1 or defer?** Adds an install-time scare-screen.
3. **mxbai-embed-large keep-alive policy.** With qwen3.5:4b + mxbai both on Ollama, does VRAM contention cause swaps? Probe data shows mxbai loads in 2.9 s; sustained co-residence is untested.
4. **Cross-task archival search default:** ON or OFF?
5. **Evaluator citation contract:** hard-fail on hallucinated `[N]` (strip) or soft-fail (`[unverified]`)?
6. **Side-panel UX for cached results:** "from cache 5 min ago" badge or silent default?
7. **`chrome.history` and incognito.** Incognito doesn't record history, so the boost is multiplicative-zero — not a wrong answer but worth confirming the user's mental model.
8. **Archival horizon.** If most tasks are single-session shopping deals, archival may be over-engineered for Phase 1. If "remind me what I found about that printer last week" is a real flow, it's load-bearing. The MemGPT-pattern in `docs/research-notes.md` commits us to it; sanity-check the assumption.
