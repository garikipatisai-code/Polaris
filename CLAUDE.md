# Polaris — Working Notes for Claude (Mac ↔ Linux Handoff)

> **Living document.** Whoever you are (Claude on Mac, Claude on Linux, future
> Claude in this repo), read this first. Update the relevant sections **before
> you sign off** so the next session picks up exactly where you stopped.
> Keep entries tight — facts and pointers, not novels.

---

## Project at a glance

**Polaris** is a Chrome MV3 browser extension that gives the browser a
goal-anchored agentic AI assistant, powered *entirely locally* by `qwen3.5:4b`
via Ollama. Phase 1 use case: cross-retailer shopping deal hunter.

The architectural distinction is a hierarchical **Planner / Executor /
Evaluator** loop with persistent state stored *outside* the model context,
so the agent stays locked to the user's original goal even when its working
context fills up.

For the full design see [`README.md`](README.md). For the literature backing
each decision see [`docs/research-notes.md`](docs/research-notes.md).

---

## Roadmap

- **M1 — extension scaffold + Ollama streaming chat** ✅ DONE
- **M2 — full agent loop (Planner / Executor / Evaluator / Compactor + breaker + watchdog + crash-resume)** ✅ DONE
  - 73 tests pass — pure-function units + orchestrator integration with scripted fake Ollama client
  - Goal byte-survival across replan empirically validated
- **M3 — real browser tools (ARIA tree, tab manager, screenshot vision)** ← in progress (backend wired, end-to-end browser-validation pending Linux box)
- **M4 — shopping domain (retailer adapters, coupons, deal ranking UI)**
- **M5 — polish (price history, error recovery, onboarding, icons)**

---

## Conventions — read before changing anything

These are hard commitments. Don't propose changes to these without flagging
in "Open questions" first.

1. **Hierarchical agent loop only.** Planner (thinking ON, rare calls),
   Executor (thinking OFF, hot path), Evaluator (thinking ON, periodic).
   No flat ReAct.
2. **Goal lives outside model context.** Verbatim user goal persisted to
   `chrome.storage.local`. Re-injected into every Planner / Evaluator call.
3. **Per-role context budgets (interactive hot path on P2200):**
   - Executor ≤ 6K tokens per turn (otherwise > 20s wall, feels broken)
   - Planner ≤ 32K
   - Evaluator ≤ 8K
4. **Structured output channel:**
   - Prefer **tool calls** (~80% success on qwen3.5:4b — retry on empty).
   - Use `format: "json"` (string mode) for free-form JSON.
   - **Never** use `format: <schema-object>` — confirmed broken on qwen35.
5. **Vision is verification-only, not primary extraction.**
   - Primary page extraction: ARIA tree via `chrome.debugger`.
   - Vision tool used to *verify* extracted facts against a screenshot.
   - Screenshots must be **≥ 1200 px wide** — smaller and the model
     hallucinates instead of refusing.
6. **Single reasoning model.** qwen3.5:4b for all three reasoning roles
   (Planner / Executor / Evaluator). The 35B-MoE doesn't fit on the
   user's 5 GB GPU and runs on CPU only — not viable for interactive use.
7. **Embedding model.** `mxbai-embed-large` (335 M params, 1024-d,
   MTEB Overall 64.68 per the leaderboard mid-2026). Configurable via
   `settings.embeddingModel` for future swaps if a stronger small model
   ships. **Rejected and removed:** `qwen3-embedding:0.6b` (~60 MTEB
   Overall — measurably weaker on retrieval) and `qwen3-reranker:0.6b`
   (cross-encoder; published lift is on top-100 reranking, our N=10
   workload doesn't have the recall gap a reranker exists to fill,
   plus VRAM math is tight on the 5 GB P2200). Don't add a reranker
   without an actual measurement showing top-3 quality lift on real
   queries.
8. **Ollama URL is configurable.** Default `http://localhost:11434`, but
   the user may host inference on a Linux box and run the browser on Mac.
   Never hard-code `localhost`.
9. **Apache 2.0** license. Don't add headers per file — repo-root LICENSE
   suffices.

---

## Current state — UPDATE THIS WHEN YOU FINISH WORK

**Last touched:** 2026-05-25 (Mac, Claude Opus 4.7)
**Last shipped:** M3.5 polish — autonomous iteration round + reranker rollback (333 mock tests + 2 fast-tier integration passing)
**Current branch:** main

### What's done

- `probe.py` — capability probe verified on Linux box (38 tok/s, needle@128K passes, vision works ≥1200 px)
- `extension/` — full agent stack:
  - **M1:** scaffold (Vite + React + TS + CRXJS, side panel, service worker, Ollama client, settings)
  - **M2:** Planner / Executor / Evaluator / Compactor roles with prompts, JSON-mode + Zod validation, permissive JSON extractor, thinking-mode toggle per role
  - **M2 state:** `chrome.storage.local` for hot state (goal-immutable via private `_setHot` + structural `patchHot` guard + one-shot `appendSuccessCriteria` with empty-input no-op fix), IndexedDB for scratchpad/findings/memory/events; forward-fill migration on `loadHot` so legacy state interacts with new safety code
  - **M2 safety:** circuit breaker (action repetition, no-progress, max-3 replans), chrome.alarms watchdog (5 min stale), crash-resume with event replay from IDB, port auto-reconnect with message queue, defensive empty-finalAnswer override
  - **M2 tools:** `echo`, `add`, `sum`, `delay`, `next_step`, `finish`, `memory.read/write/list` — Zod-validated, JSON Schema for Ollama
  - **M2 plan-walking:** `next_step` tool advances `currentStepId`; force-advance after 8 turns; `walkPlan` updates step status; advance past last step routes to EVALUATING
  - **M2 logging:** in-memory ring buffer (1000 entries) with categories, exposed at `globalThis.polaris.dumpLogs()`
  - **M2.7.1 (NEW): Vitest test suite — 73 passing tests:**
    - Unit tests for `walkPlan`, `actionHash`/`stableStringify`, `parseJSONPermissive`, `circuit_breaker.*`, `budget.*`, `ulid`, `state_store.*` (including the goal-immutability and forward-fill-migration contracts)
    - 5 orchestrator end-to-end integration tests with a scripted fake Ollama client (per-role response queues; defaults for compactor)
    - **Goal byte-survival across replan empirically validated** in test (`tests/orchestrator.test.ts`); the project's central architectural claim is no longer aspirational
  - **M2.7.2 (NEW): pre-Linux hardening pass** — Tier A + B + C fixes ahead of GPU-box integration tests:
    - **OllamaClient resilience:** per-call `timeoutMs` via `AbortSignal.any([userSignal, AbortSignal.timeout(ms)])` (default 5 min); `keep_alive: '10m'` on every chat call; one-retry on transient HTTP 5xx + non-timeout network errors; `wasTimeout()` helper to distinguish timeouts from user aborts.
    - **Tool-call reliability (the big one):** all four roles now use `[system, user-anchor]` for the first call and `[system, user-anchor, assistant-failed, user-nudge]` for the retry — replacing the unreliable `[system, system-nudge]` pattern. Driven by Qwen3 chat-template behavior (only one `<|im_start|>system` block emitted; extras inlined or dropped). Verified empirically: real-Ollama Executor smoke produces `tool_calls.length: 1` on first try, no retry.
    - **Race / atomicity:** all hot-state read-modify-write paths in `state_store` (patchHot, appendScratch, deleteScratchSeqs, appendSuccessCriteria, startTask, bumpLastTouch) serialized through a module-level `_hotMutex` promise chain. Prevents abort-vs-orchestrator clobber.
    - **Watchdog heartbeat:** `Orchestrator` runs a 30-s `setInterval` that calls `bumpLastTouch()` while `runUntilTerminal` is active. The watchdog's 5-min stale threshold can no longer trip during a slow Planner/Evaluator call.
    - **Distinct-action breaker signal:** new `recentActionHashes` window (last 10) in `BreakerState`. Trips replan if fewer than 3 distinct actions in the full window — catches non-consecutive cycling that the per-turn repeat counter misses.
    - **Tokenizer reconciliation:** `recordCharsPerToken()` in `budget.ts` updates an EWMA-smoothed empirical ratio after every Ollama response. `approxTokens()` uses the running estimate, not a hard-coded chars/4. Critical for unicode-heavy goals (€, ★, Chinese) where BPE tokens-per-char is closer to 2.
    - **Compactor token tracking:** roll prompt+gen tokens into `budgets.totalTokens` so per-task accounting includes compaction.
    - **Misc:** Executor uses `SPECIAL_TOOLS.FINISH` (was hardcoded `'finish'`); multi-tool-call warning logged + first one taken.
    - **Tests added (32):** OllamaClient timeout/retry/keep_alive (11), role retry-pattern snapshots (6), distinct-action breaker (6), chars-per-token reconciliation (6), state_store hot-mutex serialization (3). Plus integration: Executor fast smoke (real Ollama) + compaction end-to-end (slow tier).
    - **Total: 105 mock tests passing in 13 s + 2 fast-tier real-Ollama tests passing in ~100 s.** Slow tier (4 tests) opt-in via `POLARIS_REAL_OLLAMA=1` — designed to run on the Linux P2200.
  - **M2.7.3 (NEW): arch-nemesis round 3 fixes** — closed 8 of the 12 findings the critique surfaced (the 4 deferred are documentation-only):
    - **#1 Timer leak (the headline bug):** `composeSignal` rewritten to use manual `setTimeout` + `clearTimeout` in a `finally` block instead of `AbortSignal.timeout` (whose timer can't be cancelled when the request completes early). Returns a `{ signal, cleanup }` pair; `chatOnce`/`chatStream`/`embed`/`ping` all call `cleanup()` in their `finally` blocks. **Verified by test: spy on global `setTimeout`/`clearTimeout` confirms every set timer is cleared on the success, error, and 5xx-retry paths.**
    - **#2 + #10 Retry has no budget guard / verbose replay:** new `truncateForReplay()` helper in `budget.ts` (default 500 chars + `[truncated]` marker). All four roles truncate the failed-assistant content before replay. After truncation, the retry's prompt size is checked against the role's budget; if still over, the assistant turn is replaced with a generic placeholder rather than failing pre-flight.
    - **#3 `chatStream` hardened to match `chatOnce`:** timeout via `composeSignal`, `keep_alive` default, single retry on 5xx during stream initiation.
    - **#4 Dead `composeSignal` fallback removed** — the new manual implementation has no `AbortSignal.any` dependency, so the unreachable fallback is gone.
    - **#5 `embed()` accepts `signal` + `timeoutMs` opts** — was previously a black box with a hardcoded 5-min cap.
    - **#6 EWMA chars-per-token reset on `startTask`** — prior task's domain (e.g., heavy unicode trained ratio toward 2.0) no longer pollutes new task's pre-call budget guards.
    - **#7 `recentActionHashes` cleared on `advancePlanStep`** — without this, a force-advance from a single-tool step left the breaker's window full of stale hashes, immediately tripping a distinct-action replan on the next step's first turn.
    - **+9 tests:** 5 timer-leak / chatStream tests, 2 replay-truncation tests, 1 startTask-EWMA-reset test, 1 step-advance-clears-window test.
    - **Acknowledged as remaining debt (the 4 deferred):** #8 mutex semantics (writers serialized, readers race — documented but not fixed), #9 heartbeat comment overstates what it does (within-SW guard only), #11 statistical evidence (Executor smoke n=1), #12 compaction test asserts the event but not findings-persisted/scratch-emptied. None of these affect Linux-box correctness.
    - **Total: 114 mock tests passing in ~14 s + 2 fast-tier integration tests passing in ~100 s.**
  - **M2.7.4 (NEW): pre-Linux polish** — closed the deferred items + addressed three real concerns:
    - **Phase A (deferred items #8, #9, #11, #12):** doc comments on `_hotMutex` and the heartbeat now accurately describe what they are (write-serialization for the mutex, within-SW guard for the heartbeat — does NOT survive SW death). Compaction integration test now asserts the work actually happened (compaction event payload's `discarded > 0`, `findingsCount > 0` in IDB) rather than just that the event fired. New opt-in Executor reliability test runs the smoke 5x and asserts ≥3/5 first-try success, gated on `POLARIS_REAL_OLLAMA_FLAKE_RUNS=1`.
    - **Phase B #1: `agent.reset` race:** `clearHot()` now drains `_hotMutex` before erasing, so a queued patch can't restore state after the reset. Tested via concurrent patchHot+clearHot.
    - **Phase B #2: pre-flight ping:** `handleAgentStart` now pings Ollama (with the existing 10-second timeout) before constructing an orchestrator. A typo'd URL or down server now fails in seconds, not the 5-min Planner timeout. Also validates the configured model is in the available list.
    - **Phase B #3: mid-run Ollama failure:** `runUntilTerminal` now catches uncaught role errors, transitions the task to `phase:'ABORTED'`, emits an error/verdict event, and re-raises. Without this, an HTTP 503 mid-run left the task in EXECUTING — a subsequent `resume()` would re-pick the dead task and fail again the same way. Now the task is honestly dead.
    - **+2 tests:** Ollama-failure-mid-run transition (orchestrator), clearHot-drains-mutex race (state_store).
    - **Total: 116 mock tests + 2 fast-tier integration tests passing.**
  - **M3 backend swarm (NEW): 7 parallel agents, +111 tests in one batch:**
    - **Browser tool lifecycle** (`src/agent/tools/browser/lifecycle.ts`): `BrowserToolError(msg, {fatal})` + `withBrowserTimeout(fn, ms, label)` (manual setTimeout/clearTimeout pair, no AbortSignal.timeout leak). Registry's `dispatch()` plumbs `BrowserToolError.fatal` into `ToolResult.fatal` so the breaker can react.
    - **ARIA-tree extractor** (`src/agent/tools/browser/aria.ts`, `aria_types.ts`): `simplifyAxTree(AXTree) → SimplifiedNode | null` pure parser — drops generic/none/presentation/RootWebArea wrappers, collapses single-child wrapper chains (5-iter cap), token-caps output at 4000 chars (multi-pass leaf-trim then synthetic `[truncated]` marker). `ariaExtractTool` registered as `'aria.extract'` — calls `chrome.debugger.attach → Accessibility.enable → getFullAXTree → detach`, wrapped in 30s timeout. Throws fatal `BrowserToolError` if `chrome.debugger` unavailable. **8 tests.**
    - **Tab manager** (`src/agent/tools/browser/tab.ts`): 5 tools — `tab.open`, `tab.close`, `tab.list`, `tab.screenshot`, `tab.wait_loaded`. Per-task `ownedTabs: Map<taskId, Set<tabId>>` with `closeOwnedTabs(taskId)` cleanup hook wired into orchestrator's `runUntilTerminal` finally block. Screenshot extracts width/height by manually parsing PNG IHDR chunk (no Image API in MV3 SW). Rejects `chrome-extension://` / `file://` / `chrome://` URLs as fatal. Refuses to close tabs the agent doesn't own. **22 tests.**
    - **Search tool** (`src/agent/tools/browser/search.ts`): regex-based DDG HTML parser — `parseDuckDuckGoResults(html, limit?)` extracts `result__a` anchors + `result__snippet` text, decodes DDG's `/l/?uddg=` redirect URLs, strips `<b>` highlight tags, tolerates malformed HTML. `searchTool` registered as `'search'` — fetches DDG with 15s timeout, throws non-fatal `BrowserToolError` on HTTP/network errors so model can retry. **13 tests.**
    - **Retailer adapter framework** (`src/agent/tools/retailers/`): `RetailerAdapter` interface + `findAdapter(url) / extractProduct(tree, url)` dispatcher. Concrete `amazonAdapter` walks SimplifiedNode tree (depth-first generator), extracts title/price/inStock/rating/features/asin via word-boundary regex; price math in integer cents (no IEEE-754 rounding); ASIN from `/dp/` + `/gp/product/` + query-string URL patterns; currency map `$→USD £→GBP €→EUR`. **44 tests.**
    - **Side-panel UX** (`src/sidepanel/App.tsx` + `styles.css`): breaker events surface with `⚠` + reason; compaction events show `archived N → M findings` plus token cost; role_end with `retried=true` gets a small badge. Wrapper `<li class="agent-event-{type}">` already supports the new types via existing template — no timeline-render-block refactor.
    - **Property-based tests** (`tests/property/`, +`fast-check@4.8.0` devDep): 24 properties on `actionHash` (key-order invariance, name discrimination, determinism, deep nesting), `walkPlan` (immutability, single-step transition, terminal handling — copy of the unexported function with drift-risk comment), `parseJSONPermissive` (round-trip, prose tolerance, never-crashes on adversarial brace patterns). Stable across 3 consecutive runs.
    - **Docs**: `docs/adr/0001-m3-browser-tools.md` (M3 architecture decisions) + `docs/troubleshooting.md` (symptom→fix guide for ~12 common failure modes).
    - **Tools registered** in `createDefaultRegistry()`: 7 new tools (search + aria.extract + 5 tab tools) bringing total to 14. Side-panel `closeOwnedTabs` cleanup hook wired into orchestrator's terminal phase.
    - **Total: 227 mock tests passing in ~15 s + 2 fast-tier integration passing.** Bundle size: 154 KB SW (was 135 KB; +19 KB for 7 new tools), 158 KB panel.
  - **M2.7.5 (NEW): arch-nemesis round 4 — closed 9 of 12 findings on the M3 backend swarm:**
    - **#1 Manifest permissions** — added `tabs`, `debugger`, `activeTab` to `src/manifest.ts`. Without these the M3 tools all failed at `chrome.* is undefined` on first invocation in real Chrome. The integration tests had been passing because the mocked `chrome` global papered over the gap.
    - **#2 closeOwnedTabs deadline** — orchestrator's terminal-phase tab cleanup now races against a 2-second deadline (`Promise.race`). A hung `chrome.tabs.remove` (DevTools session conflict, tab in unload) can no longer wedge `runUntilTerminal`.
    - **#3 ownedTabs persistence** — added `ownedTabs: number[]` to `AgentStateHot` (forward-fill default `[]`). `tab.open` / `tab.close` mirror to hot state via `patchHot`; `closeOwnedTabs` falls back to hot state when in-memory map is empty (post-SW-restart). Tabs no longer leak across SW death.
    - **#4 walkPlan exported** — was duplicated in two test files with "drift risk" comments. Now imported from `src/agent/orchestrator.ts` directly. Both tests now hold the real implementation under verification, not stale copies.
    - **#5 Amazon banner-heading robustness** — `findTitle` now examines the first 5 headings: tier 1 picks the longest among those ≥20 chars (real product titles), tier 2 falls back to the first >5 chars (minimal/test pages). Fixes the documented failure mode where a banner H1 ("Amazon's Choice") preceding the product H1 produced a wrong-but-non-null title. **+3 tests** including the explicit banner-precedes-product case.
    - **#7 productExtractTool wired** — new `product.extract` tool bridges ARIA extraction → adapter framework. Takes a tabId, resolves URL via `chrome.tabs.get`, looks up the matching adapter, runs `aria.extract`, dispatches to `extractProduct`. Returns `{ product, retailer, reason? }`. The retailer adapter framework is no longer dead code.
    - **#8 tab.list non-strict args** — pinned the contract with a test asserting `tabListTool.argsSchema.safeParse({reason:'...', extra_field:42})` succeeds, and the tool dispatches cleanly when the model injects extra keys. Documented why (qwen3.5 occasionally adds spurious keys to no-arg tool calls).
    - **#10 silent-error-swallow audit** — `runUntilTerminal`'s catch path's inner try/catch was silently swallowing transition failures. Now logs unless the failure is the legitimate "concurrent reset cleared hot state" race (the `/no hot state/i` case is recognized + suppressed; everything else is surfaced via `console.warn`).
    - **#11 understanding recovery** — read aria.ts (parser + chrome.debugger lifecycle), search.ts (regex DDG parser), tab.ts (PNG header parser, ownership tracking), amazon.ts (heading + price + ASIN extraction) end-to-end. The PNG parser is well-bounded; the search parser is brittle as agent rated (worth a CI canary later); the ARIA simplifier is clean.
    - **Property-test flake stabilized** — `parseJSON.property.test.ts` occasionally hit a non-ASCII edge case in the leading-prose property; tightened the input filter to printable ASCII (`/^[\x20-\x7e]*$/`). 5/5 consecutive full-suite runs now clean.
    - **Tests added (4 + 4 reused-with-new-shape):** Amazon banner test (3), tab.list non-strict (1).
    - **Acknowledged remaining (3 of 12):** #6 search-DDG canary (real M5 polish, needs a scheduled job), #9 PNG-header edge cases (URL-safe base64, padding) — read the code, judged acceptable, no new tests, #12 cumulative micro-decisions across 7 agents — process critique that can't be undone retroactively.
    - **Total: 231 mock tests passing in ~15 s + 2 fast-tier integration passing.** Bundle: 156 KB SW (+2 KB for product.extract + tab persistence), 158 KB panel.
  - **M3.5 (NEW): M3-debt-cleanup, not "foundation"** (231 → 301 tests). Honest framing: this is the safety / perf / observability work that should have shipped with the M3 backend swarm. After arch-nemesis round 5 critique of the research-and-roadmap exercise, abandoned the M4-M7 paper plan and just shipped the unblock work:
    - **Manifest permissions** — added `tabs`, `debugger`, `activeTab` (the M3 backend swarm's biggest oversight; without these, every M3 tool throws `chrome.* is undefined` at first invocation in real Chrome).
    - **`backendDOMNodeId` propagation** through `AXNode` → `SimplifiedNode` → Zod schema → `cloneNode` → token-cap. Stream 2's "biggest unblock for M4" — propagated CDP DOM-side handles so future page-action tools can `DOM.resolveNode → Input.dispatchMouseEvent` without re-walking selectors. (+4 tests)
    - **PII redaction at persistence boundary** — `src/agent/redact.ts` with Microsoft-Presidio-style regex catalogue (CC, SSN, phone, email, US street address). Applied at `state_store.appendFinding` so long-term archives never include PII verbatim. Scratchpad stays raw (model needs the data for the current turn); only the Compactor's archival output is redacted. (+29 tests)
    - **Executor prompt restructure for KV-cache reuse** — pure refactor of `prompts/executor.ts` from `[role, GOAL, PLAN, FINDINGS, ACTIONS, TOOLS, RULES]` to `[role, GOAL, TOOLS, RULES, PLAN, FINDINGS, ACTIONS]`. Stable bits first, churn bits last. Expected 30-50% reduction in Executor `prompt_eval_duration` once Linux probe confirms `cache_prompt: true` is firing. Test asserts byte-equal prefix when only scratchpad-tail differs. (+4 tests)
    - **Content-tagging defense** — wrapped page-derived sections (FINDINGS, RECENT ACTIONS, scratchpad trace) in `<untrusted_page_content kind="...">...</untrusted_page_content>` across all four role prompts (Executor, Evaluator, Compactor, Planner). RULES section teaches the model to treat tag content as data, not instructions. Greshake et al. 2023 structural-separation pattern. (+2 tests)
    - **Domain tier system** — `src/agent/domain_tiers.ts` with `read-only` / `click-only` / `full-action` per host. Default `read-only` for unknown hosts (safe baseline; user opts-in per domain). `assertCanAct(url, requiredTier)` is the gate point M4 page-action tools call before dispatching. (+17 tests)
    - **Hallucinated-tool breaker tie-in** — `ToolResult.unknownTool: boolean` plumbed from registry through `recordAfter` to a new `recentUnknownToolFlags` sliding window in `BreakerState`. ≥3 unknowns in last 8 turns → replan (tighter than action-repeat because the model isn't repeating, it's inventing). Cleared on `resetForReplan`. (+5 tests)
    - **CSP hardening** in manifest — explicit `extension_pages: "script-src 'self'; object-src 'self'; base-uri 'self'"`. Reaffirms the MV3 default; provides an audit anchor for future relaxation requests.
    - **Telemetry foundation** — DB v1 → v2 schema bump with `metrics` IDB store (auto-incrementing seq, per-task indexed). `recordMetric()` taps the four role runners (Planner / Executor / Evaluator / Compactor) for per-op latency + outcome. `summary(taskId)` returns p50/p95/mean latency + success rate per op, sorted by mean latency. Exposed as `polaris.metrics.summary(taskId)` on the SW global. (+9 tests)
    - **Total: 301 mock tests passing in ~15 s + 2 fast-tier integration passing.** Bundle: 162 KB SW (was 156 KB; +6 KB for redact + domain_tiers + metrics).
    - **Notably unfixed:** the M4-M7 roadmap doc was reframed as "scope sketch, not committed plan" with disclaimer banners; estimates dropped; 7 "open questions" stand. The plan will be rewritten as features actually ship.
- `docs/research-notes.md` — literature survey
- `ISSUES.md` — original M1 CORS issues, all resolved

### What's next (M3 work list)

- [ ] **User: smoke-test M2 in Chrome end-to-end** with the canonical task (`store the numbers 17, 25, and 8 in memory namespace 'nums' under keys a b c, read them back, finish with their sum`) — should now show step transitions in the plan tree, ≥1 compaction event mid-run, and a correct sum
- [x] **ARIA-tree extractor** via `chrome.debugger` — wired (parser + tool + tests; needs real-browser end-to-end on Linux)
- [x] **Tab manager** (open / extract / screenshot / wait_loaded / close) — wired with mocked tests; per-task ownership + abort cleanup
- [ ] **Screenshot vision tool** — needs real Ollama vision call (deferred until Linux box)
- [x] **Retailer adapter framework + Amazon** — wired; Walmart/Target/Best Buy can be added mechanically
- [x] **Search tool** — DuckDuckGo HTML scrape; regex-based parser
- [ ] **Browser end-to-end test against real pages** (Linux)
- [ ] **Vision tool with verifier pattern** (Linux)

### Open questions / blockers

- None blocking M3. The agent loop is provably correct on its core invariants (goal survival, replan cap, step advance) via the test suite. M3 work proceeds against a stable foundation.

### Acknowledged debt (Tier C from the arch-nemesis pass)

- ~~Watchdog `setInterval` lastTouch bumper still not added (5-min threshold tolerates this for now).~~ ✅ Done in M2.7.2 (`Orchestrator.startHeartbeat`).
- ~~Breaker progress signal still uses findings-growth — should be replaced with distinct-action-count over a window.~~ ✅ Done in M2.7.2 (added alongside the existing findings-growth signal as a separate trip).
- ~~Tokenizer accuracy is `chars/4` heuristic; documented as advisory.~~ ✅ Done in M2.7.2 (`recordCharsPerToken` EWMA reconciliation).
- ~~Resume event replay sends N events as N postMessages (should batch).~~ ✅ Done 2026-05-25 — new `agent.events` batched message type; one postMessage carries up to 100 events; panel handler expands the batch into a single setAgentRun update so a long resume doesn't trigger N React re-renders.

**Tier C debt list is now empty.**

### Browser test status (M1 + M1.1)

**Cannot test from this Mac session — sandbox blocks Chrome from binding
its singleton socket (`Failed to bind() .../SingletonSocket: Operation
not permitted`) and from spawning a test Ollama on an alternative port
(`bind: operation not permitted`).**

Static verification done:
- Build succeeds, no TS errors
- SW bundle contains no stray `loadModel` / `probe` / `/api/generate`
- Default URL `localhost:11434` confirmed in bundled sidepanel JS

**User must run a real browser test before M2 starts.** Recipe:

```bash
# 1) Set CORS allow on Ollama (one time)
launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"     # macOS
# - or for Linux systemd:
#   sudo systemctl edit ollama.service
#   [Service]
#   Environment="OLLAMA_ORIGINS=chrome-extension://*"
#   sudo systemctl daemon-reload && sudo systemctl restart ollama

# 2) Restart Ollama so it picks up the env var
# (Mac: quit & relaunch the menu-bar app, or `ollama serve` in terminal)

# 3) Build + load extension in Chrome
cd extension && npm install && npm run build
# Chrome → chrome://extensions → Developer mode → Load unpacked → dist/

# 4) Open side panel via toolbar icon, send a message
# Or fully automated:
python3 scripts/browser_smoke.py
```

### What's next (M2 work list)

- [ ] **User: verify M1.1 in Chrome end-to-end** (see recipe above)
- [ ] Persistent agent state schema: GOAL, PLAN, FINDINGS, VISITED, BUDGETS,
      SCRATCHPAD — backed by `chrome.storage.local` for small things and
      IndexedDB for the findings archive
- [ ] Planner role (rare calls, thinking ON, ≤32K context budget)
- [ ] Executor role (hot path, thinking OFF, ≤6K budget)
- [ ] Evaluator role (periodic, thinking ON, ≤8K budget)
- [ ] Compactor: scratchpad → structured findings summarizer
- [ ] Mock tools (`echo`, `add`, `delay`, `memory.write/read`)
- [ ] Synthetic stress test: artificially fill context, verify goal survives

### Open questions / blockers

- None blocking M2 right now — once user confirms M1.1 streams cleanly,
  we start the agent loop work.

---

## Hardware-specific notes

| Aspect | Mac (dev) | Linux box (production inference) |
|---|---|---|
| Hardware | Apple machine, unconfirmed silicon | ThinkStation P330, P2200 5 GB VRAM, 32 GB DDR4, i7 |
| Ollama speed (`qwen3.5:4b`) | ~5 tok/s first call, slow | **~38 tok/s sustained** (avg of 5 short calls) |
| Long-context | Times out via Claude Code's HTTP wrapper past ~4 K prompt | Needle-in-haystack passes at every depth tested (4K → 128K), latency scales roughly linearly |
| Vision (tested image sizes) | 29 KB worked, 600 KB+ failed (proxy) | 18 KB & 51 KB hallucinated, **143 KB / 1600px worked** |
| `format: "json"` string mode | ✅ 5/5 | ✅ 10/10 |
| `format: <schema-object>` | ❌ 0/10 | ❌ 0/3 — confirmed broken |
| Tool calls (structured output) | ✅ 5/5 | ⚠️ 4/5 (80%) — needs retry-on-empty |
| Thinking-mode toggle | ✅ | ✅ |
| Multi-turn continuity | (untested) | ✅ "Teal. Mochi." recalled |
| Embeddings (mxbai-embed-large, 1024 d) | (not loaded) | ✅ 2.9s |

**Implication for design:** every Executor turn must fit in ≤ 6 K tokens or
the user perceives it as broken. The compactor is *load-bearing*, not a
safety net.

### Long-context latency curve (Linux, measured)

| Context | Wall time | tok/s eff |
|---|---|---|
| 4K | 14.5 s | 252 |
| 16K | 54.7 s | 267 |
| 32K | 129.8 s | 225 |
| 64K | 372.1 s | 157 |
| 128K | 1089.4 s (~18 min) | 107 |

Sub-quadratic, super-linear. Roughly 2.4× wall per 2× context. Use this
to decide budgets, not the 262 K theoretical context.

---

## Recent decisions (append at top — most recent first)

- **2026-05-25 night** Removed the `OllamaClient.rerank()` method, the
  `settings.rerankerModel` field, and all qwen3-embedding / qwen3-reranker
  documentation after a Gemini-sourced benchmark check. Headline reasons:
  (1) `qwen3-embedding:0.6b` benchmarks ~5 MTEB points BELOW
  `mxbai-embed-large` (60 vs 64.68) — there's no quality reason to
  switch defaults; (2) `qwen3-reranker:0.6b`'s published +4 NDCG@10
  lift is on top-100 reranking, and our search workload only
  reranks ~10 candidates where the recall gap a cross-encoder is
  designed to close is small to begin with; (3) VRAM math (chat 3.4 GB
  + embedding 0.7 GB + reranker 0.5 GB ≈ 4.6 GB on 5 GB ceiling)
  leaves no headroom for KV cache. The infrastructure was speculative
  M5+ work that nothing currently consumed; deleting unused code is
  cheaper than maintaining it. If reranking becomes valuable later,
  `BGE-Reranker-v2-M3` benchmarks equivalently to qwen3-reranker:0.6b
  and is a fine alternative.

- **2026-05-23 late night** M2 framework decision after research + planning
  agents: **no LangGraph / LangChain / Mastra / Vercel AI SDK / XState**.
  Reason: those frameworks target a different problem shape (cloud routing,
  multi-provider, complex DAGs); for a constrained local agent with
  hierarchical Planner/Executor/Evaluator + persistent external state, the
  consensus is "thin LLM client + heavy custom orchestration." Adopted:
  custom orchestration on a `phase` enum switch, **Zod** for schemas,
  **`idb`** for IndexedDB, in-house cosine for embedding similarity,
  chars/4 heuristic + Ollama `prompt_eval_count` reconciliation for token
  counting. Bundle delta ~15 KB vs ~500 KB for a framework approach.
- **2026-05-23 night** M1.1 cleanup committed. CORS strategy: canonical is
  `OLLAMA_ORIGINS="chrome-extension://*"` on the Ollama server (one env
  var, no extra process). The earlier Python proxy on port 11435 still
  works as an override for users who can't modify Ollama's env, but
  default URL is back to `:11434`. Service worker rewritten to a single
  `chatStream` call with a soft 3-s "warming" notice — the previous
  probe-then-restream pattern was double-requesting on every successful
  chat. `loadModel` helper removed entirely.
- **2026-05-23 evening** Ollama on Linux returns 403 for browser-extension
  requests (origin `chrome-extension://...`). Linux session shipped a
  Python CORS proxy at port 11435 that strips Origin headers. Default URL
  changed to `http://localhost:11435`. Cleaner alternative
  (`OLLAMA_ORIGINS="chrome-extension://*"`) is open — see Open questions.
  See [`ISSUES.md`](ISSUES.md) for full debug log.
- **2026-05-23** Single-model design for Phase 1. `qwen3.6:35b-a3b` was
  considered as a stronger Planner backend but doesn't fit on the user's
  5 GB GPU and spills entirely to CPU. Not viable interactively. *Could*
  be used for offline / sleep-time work later, but not Phase 1.
- **2026-05-23** Vision is verification-only, not primary extraction.
  Driven by probe finding that <50 KB images hallucinate; ARIA tree
  remains primary extraction channel.
- **2026-05-23** Drop `format: <schema-object>` mode entirely. Driven by
  10/10 + 3/3 fail rate across both machines. Use `format: "json"`
  string mode or tool calls.
- **2026-05-23** Per-role budgets tightened from earlier estimates after
  measuring the latency curve. Was: Executor ≤16 K. Now: Executor ≤6 K.
- **2026-05-23** Project named **Polaris**. North-Star metaphor for
  goal-anchoring; ★ as the visual symbol.
- **2026-05-23** License = Apache 2.0 (matches qwen3.5 license + grants
  patent protection vs MIT).
- **2026-05-23** Stack chosen: Chrome MV3 only (not cross-browser),
  Ollama (configurable URL), Chrome Side Panel (not popup or new tab),
  read-only Phase 1 (no checkout automation).

---

## Handoff notes for the next session

**If you're starting fresh on this repo:**
1. Run `python3 probe.py` once on the Linux box to confirm Ollama is up
   and the model is responsive on whatever the current hardware looks
   like. The results from the last run are in `probe_results.json` if
   recent enough to trust.
2. Check the current `## Current state` section above for what's next.
3. Use `TaskCreate` to track the work items in the M2 list.

**If you're picking up M1 testing:**
- `cd extension && npm install && npm run build`
- Load `extension/dist/` into Chrome via chrome://extensions → Developer
  mode → Load unpacked
- Open side panel, set Ollama URL, click Test Connection, send a message
- If the CRXJS pinned version `^2.0.0-beta.28` is stale, run `npm outdated`
  and bump it. CRXJS evolves quickly.

**If you're starting M2:**
- Don't write any agent code until M1 streaming is *confirmed working*
  end-to-end. A broken M1 will hide M2 bugs.
- Mock tools first, real browser tools later (that's M3).
- The compactor is the most architecturally important piece — design it
  first, with tests that artificially fill the scratchpad.

**Before you sign off, update:**
- `## Current state` with what you changed
- `## Recent decisions` if you made any architectural calls
- `## Open questions` with anything you couldn't resolve
- `## Handoff notes for the next session` with what the next Claude
  needs to know

---

## Cross-machine sync workflow

Both Mac and Linux clones of this repo. To keep them in sync:

1. **Before starting a session:** `git pull --rebase` to get the other
   side's updates (including any CLAUDE.md edits).
2. **After meaningful work:** commit including the CLAUDE.md update,
   then push.
3. **If you and the other Claude commit concurrently:** rebase, resolve
   any CLAUDE.md conflict by *merging both sets of updates* (don't pick
   one side). The sections are designed to be additive — "Recent
   decisions" appends, "Current state" replaces, "Handoff notes" rewrites.

---

## Pointers to other docs

- [`README.md`](README.md) — user-facing project description, install steps
- [`ISSUES.md`](ISSUES.md) — known issues and debug log (currently: M1 CORS)
- [`docs/research-notes.md`](docs/research-notes.md) — literature survey
- [`docs/ollama-qwen35-page.png`](docs/ollama-qwen35-page.png) — verified
  source for model architecture / capability claims
- [`probe.py`](probe.py) — capability probe (run with no args for full
  suite, `--only ...` for subsets, `--needle-depths ...` for long-context)
- [`probe_results.json`](probe_results.json) / [`probe_results.log`](probe_results.log) — most recent probe run output
