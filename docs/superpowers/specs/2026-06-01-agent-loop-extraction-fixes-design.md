# Agent-Loop Extraction Fixes — Cache Staleness, Durable Tab Context, DOM-Settle

- **Date:** 2026-06-01
- **Status:** Design — APPROVED (brainstorming complete); ready for `writing-plans`
- **Author:** Claude (Opus 4.8, 1M) on Mac, with Saikrishna
- **Baseline:** `main` @ `038a3b5`, clean tree, **399 mock tests + 2 fast-tier integration green** (15.7s)
- **Origin:** `docs/post-mortem-2026-06-01-agent-loop-amazon.md` (Linux run: 30+ Executor turns, 3 replans, 0 products extracted, ~$3 DeepSeek). This spec **re-roots** that post-mortem against the code — confirming two root causes, correcting two, and deferring the Amazon-specific verification to Linux.

## 1. Problem

A real run of *"Go to amazon.com, search 'wireless mouse', list the first 3 names + prices"* never extracted a single product across 30+ turns. The post-mortem named 4 root causes; reading the code confirms the symptoms but relocates the causes.

**Confirmed (code-verified):**

1. **Stale element cache — but broader than the post-mortem saw.** `elementCache: Map<tabId,…>` (`aria_types.ts:84`) is populated by `aria.extract` (`aria.ts:416`) and **only ever cleared on `tab.close`** (`tab.ts:453`) — never on navigation. After the search submits and the page navigates, two consumers serve homepage-era data:
   - `page.extract` serializes the stale homepage tree (`extract.ts:49-53`) → "no products". *(The post-mortem's RC#1.)*
   - **Index-based `tab.click`/`tab.type` read the same stale cache** via `getCachedBBox` (`actions.ts:122,249`) → click/type land on homepage coordinates on the new page. *(The post-mortem missed this consumer entirely.)*

   Root cause: **the cache has no invalidation**, not "page.extract reads the cache." Fixing only `page.extract` leaves the action staleness.

2. **Hallucinated `tabId:1` — but the cause is missing context, not a missing error hint.** The Executor prompt has **no field for the current tab/URL** (`prompts/executor.ts:33-40`); the real `tabId` lives only in the last-5, 80-char-truncated scratch tail (`roles/executor.ts:54`). It scrolls out after ~5 turns **and** the Compactor deletes the entire scratchpad (`orchestrator.ts:947-948`), preserving only goal-relevant findings (never the mechanical `tabId`). The run log's `compactor fires` → `aria.extract(tabId=1)` is exactly this: context gone, model guesses the schema minimum (`tabId:{minimum:1}`). *(The post-mortem's RC#2; a better error message helps recovery but does not address the cause.)*

**Corrected:**

3. **"`simplifyAxTree` drops product content" is imprecise.** The simplifier drops only roleless/nameless wrappers and **splices their children up** (`aria.ts:198`); named nodes (product-title links, price text) survive. The genuine RC#3 risks are (a) the **lazy-load race** — `tab.wait_loaded` polls `readyState:'complete'` (`tab.ts`), which fires before Amazon's JS renders the cards, and there is no DOM-settle step; and (b) the **8000-char output cap** (`aria_types.ts:77`, stacked with `extract.ts:64`'s own 8000 slice) clipping a long results page.

4. **Vision-as-extraction (post-mortem RC#4) collides with a locked convention.** Convention #5: *"vision is verification-only, not primary extraction."* Out of scope here (see §3, §8).

**Bonus bug found while reading:** `searchNavigateTool.execute(args)` takes no `ctx` and calls `chrome.tabs.create` directly (`search.ts:342-365`) — the tab is never registered as owned, so it is invisible to `tab.list` and never auto-closed.

**Constraint:** this Mac's sandbox blocks web egress, so **nothing Amazon-specific (RC#3) can be validated here** — only unit-level wiring. Live validation is a Linux gate.

## 2. Goals / Non-goals

**Goals:** Make the agent's view of *what page am I on / what's on it* stay synchronized with reality. Specifically: (1) cache never serves data from a different page; (2) the owned `tabId`(s) are always present in the Executor's context, independent of scratch/compaction; (3) give the loop a way to wait out lazy-loaded content; (4) keep ARIA the primary extraction channel by making it reliable, not by falling back to vision.

**Non-goals (explicitly deferred):** changing Convention #5 / vision-as-extraction (§8); SoM↔AXTree fusion; event-driven cache invalidation (A2 — rejected, see §4 Stream A); persisting bboxes across SW restart (bboxes are inherently ephemeral); a circuit-breaker pattern for repeated tab-not-found (the durable-context fix in Stream B removes the trigger, so the breaker tie-in the post-mortem proposed is unnecessary).

## 3. Locked decisions (from brainstorming)

| # | Decision |
|---|---|
| Approach | **Fix root causes**, not the post-mortem's literal symptom-patches. |
| Cache invalidation | **A1 — URL-stamp + staleness-aware reads** (not A2 event-driven). `page.extract` stops reading the cache (always fresh). |
| Tab context | **Surface owned tabs (`{tabId,url,title}`) durably in the Executor prompt every turn** — the RC#2 root-cause fix. Error-hint + `search.navigate` ownership are cheap complements. |
| RC#3 dynamic content | **Build `tab.dom_settle` now** (wiring unit-tested on Mac; settle semantics + cap tuning validated on Linux). |
| Vision / Conv. #5 | **No change.** Vision stays verification-only. |
| Verification | Mac: TDD unit tests + full mock suite green per commit. Linux: `browser_smoke_hybrid.py` + real Amazon run with `amazon.com` set to `full-action`. |

## 4. Design

### Stream A — Cache staleness (URL-stamp + always-fresh `page.extract`)

**A1. `aria_types.ts` — stamp the cache with the source URL.**
- Cache value becomes `{ nodes, tree, url }`. `cacheElements(tabId, tree, url)` records `url`.
- `getCachedBBox(tabId, index, currentUrl?)` and `getCachedNode(tabId, index, currentUrl?)` return `undefined` when `currentUrl` is provided **and** differs from the stamped `url` (staleness = miss). When `currentUrl` is omitted, behavior is unchanged (back-compat).
- `getCachedElements` becomes unused once `page.extract` stops calling it — remove it (and its `nodes`-only return) to avoid leaving a stale-data footgun, or keep solely if a test needs it. Default: **remove**.

**A2. `aria.ts` — stamp on write.** In `runExtraction`, after a successful simplify, resolve the tab's current URL (`chrome.tabs.get(tabId).url`, best-effort; empty string on failure) and pass it to `cacheElements(tabId, simplified, url)`.

**A3. `extract.ts` — `page.extract` always re-extracts.** Delete the `getCachedElements` branch; always call `ariaExtractTool.execute({tabId}, …)` and serialize `result.tree`. This is the existing `else` branch (`extract.ts:54-57`) — already correct — promoted to the only path; it keeps passing the synthetic `{taskId:'',stepId:''}` ctx (`aria.extract` ignores `ctx`, so no signature change is needed). Side benefit: it re-stamps the cache for subsequent index actions.

**A4. `actions.ts` — pass current URL to bbox lookups.** `tab.click` and `tab.type` already fetch `tab = chrome.tabs.get(tabId)` for the `assertCanAct` tier check (`actions.ts:113,239`). Pass `tab.url` into `getCachedBBox(tabId, index, tab.url)`. On a stale miss, return the existing non-fatal shape with a clearer message: `element [N] is stale (the page changed since aria.extract) — call aria.extract again`.

**Why A1 over A2 (event-driven `clear` on `tabs.onUpdated`/`webNavigation`):** A1 compares the *actual current URL*, so it also catches SPA soft-navigations (history.pushState) that don't reliably fire `onUpdated`; it adds no global SW listeners (which are fragile when the SW is asleep); and its read-side cost is zero on the action path (the URL is already in hand). A2 is simpler conceptually but misses SPA nav and the precise Amazon failure is the only case both handle equally.

### Stream B — Durable tab context (RC#2 root cause + complements)

**B1. Executor prompt — new `OPEN TABS` section.** `ExecutorPromptInput` gains `openTabs: { tabId: number; url: string; title: string }[]`. Render, placed **immediately before `PLAN`** (it churns at roughly plan cadence — a few times per task — so it sits with the other task-state churn, preserving the stable goal/tools/rules prefix for KV-cache):
```
<untrusted_page_content kind="open_tabs">
OPEN TABS (owned by this task — pass these exact tabIds to tab/aria/page tools):
  - tabId 1146041647 — https://www.amazon.com/s?k=wireless+mouse — "Amazon.com : wireless mouse"
</untrusted_page_content>
```
When empty: `(no tabs open yet — use tab.open or search.navigate to start)`. Wrapped in `<untrusted_page_content>` because `url`/`title` are page-influenced (consistent with the existing Greshake defense in this prompt). A short RULE is added: *"Never invent a tabId. Use a tabId from OPEN TABS; if it's empty, open a tab first."*

**B2. `roles/executor.ts` — feed owned tabs each turn.** Build `openTabs` from a new exported `getOwnedTabsDetailed(taskId): Promise<{tabId,url,title}[]>` in `tab.ts` — extracted from the body of `tabListTool.execute` (hydrate ownership from hot state → `chrome.tabs.get` each → drop vanished), so the prompt and `tab.list` share one source of truth. Guard for the no-`chrome` test env (return `[]`). Never throws into prompt assembly.

**B3. Error-hint on tab-not-found (cheap recovery aid).** Where a CDP/`chrome.tabs` call fails with "No tab with given id", append `— call tab.list() to discover active tabs` to the returned/thrown message: `aria.extract` (`aria.ts` catch), and the `tab.*` / action tools' existing "tab not found" branches.

**B4. `search.navigate` ownership (bonus bug).** `searchNavigateTool.execute(args, ctx)` accepts `ctx` and registers the created tab via a newly exported `registerOwnedTab(taskId, tabId)` (thin wrapper over the existing private `addOwned`) so the tab appears in `tab.list`, in `OPEN TABS`, and is auto-closed at terminal phase.

### Stream C — Dynamic content (RC#3 — build now, validate on Linux)

**C1. New tool `tab.dom_settle`** (new file `tools/browser/settle.ts`, registered in `tools/index.ts`). Args `{ tabId, quietMs?=500, timeoutMs?=5000 }`. Attaches the debugger and runs one `Runtime.evaluate({ awaitPromise:true, returnByValue:true })` whose expression installs a `MutationObserver` on `document.documentElement` (`subtree, childList, characterData`), resets a `quietMs` timer on every mutation, and resolves `{settled:true, waitedMs}` when the timer elapses or `{settled:false, waitedMs}` at `timeoutMs`. Non-fatal on error. The Executor prompt's page-interaction RULE gains: *"After a navigation or search submit, call `tab.dom_settle` before `aria.extract`/`page.extract` so lazy-loaded content has rendered."*

**Honesty about testability:** Mac unit tests cover the **wiring** — arg schema, attach→evaluate(expression present + well-formed)→detach order, timeout/`tab-not-found` handling. The **settle semantics** (does it actually wait out Amazon's card render?) and the `quietMs`/`timeoutMs` tuning are a **Linux gate** — they cannot be exercised without a real lazy-loading page.

**C2. Configurable ARIA cap for extraction intent.** Parameterize the 8000-char cap: `simplifyAxTree(tree, viewport?, maxChars=ARIA_OUTPUT_CHAR_CAP)` and an optional `maxChars` on `ariaExtractTool`. The **global default stays 8000** (Executor turns are bound by the ≤6K-token budget — Convention #3). **`page.extract` ships at `maxChars=16000`** and lifts its own `extract.ts:64` `slice(0,8000)` to match: it is a standalone one-off model call (`think:false`, 30s timeout), not an Executor turn, so ~16000 chars ≈ 4–6K tokens is safe within the latency curve (≈14.5s at 4K tokens on the P2200). 16000 is a reasoned default, **confirmed/tuned on Linux** — Mac cannot measure it.

### Stream D — Vision / Convention #5

**No code change.** Vision stays verification-only. Streams A–C are expected to make ARIA extraction reliable; if Linux proves otherwise, re-open Convention #5 as a separate, explicitly-flagged decision — not silently here.

### Stream E — Verification

- **Mac (now):** TDD per Stream (§6); full mock suite green per commit (baseline 399 → grows); fast-tier unchanged (2).
- **Linux (next session / user):** `cd extension && npm run build && python3 ../scripts/browser_smoke_hybrid.py`; then the real Amazon agent run **with `amazon.com` pre-set to `full-action`** (default is `read-only`, so `tab.type` is otherwise correctly refused — the post-mortem run only succeeded because actions were ungated; `domain_tiers.ts:35`, `actions.ts:243`). Success: products extracted with prices; ≤15 Executor turns; no "no products" / `tabId:1` loops. Tune `quietMs`/`timeoutMs` + the extraction cap here.

## 5. Error handling

- **Stale-cache read** → non-fatal miss with "call aria.extract again" (model re-extracts; never abort).
- **`tab.dom_settle` timeout** → `{settled:false, waitedMs}` (non-fatal); the model proceeds to extract regardless.
- **`OPEN TABS` build failure** (no `chrome`, `tabs.get` throws, vanished tab) → that tab is dropped / the list is empty; prompt assembly never throws.
- **Stamp-URL resolution failure** in `aria.extract` → stamp empty string; a later read with a real `currentUrl` then misses (safe — re-extract), rather than serving unstamped data as fresh.

## 6. Testing (TDD; `npm test` green per commit; baseline 399)

- `aria_types` (or `aria.test.ts`): stamped cache; `getCachedBBox`/`getCachedNode` return a hit when `currentUrl` matches, **miss when it differs**, hit when `currentUrl` omitted (back-compat).
- `extract.test.ts`: `page.extract` **never reads the cache** — always invokes `aria.extract` (spy) even when a (now-removed) cache would have been warm.
- `aria.test.ts`: `runExtraction` calls `cacheElements` with the resolved URL; `maxChars` override respected by `simplifyAxTree`.
- `actions.test.ts`: stale bbox (cached URL ≠ current `tab.url`) → non-fatal "stale … call aria.extract again"; fresh URL still clicks/types. (Existing 19 still pass.)
- `executor` prompt test: `OPEN TABS` rendered from `openTabs`; empty-state copy; section sits before `PLAN`; stable prefix (goal/tools/rules) byte-equal when only `openTabs`/scratch differ.
- `roles/executor` test: `getOwnedTabsDetailed` (mocked) flows into the prompt; no-`chrome` env yields `[]` and no throw.
- error-hint tests: "No tab with given id" → message contains `tab.list()`.
- `search.navigate` test: registers ownership (appears in `getOwnedTabs`/`tab.list`).
- `tab.dom_settle` test: arg schema; attach→`Runtime.evaluate`(expression installs MutationObserver)→detach order; timeout & tab-not-found non-fatal.

## 7. Risks — only a real-browser (Linux) run can settle

- Does `tab.dom_settle`'s quiet-window actually bracket Amazon's card render, or does it return too early / hang to timeout? (tuning)
- After settle + a larger cap, does the simplified tree actually contain product **names and prices with accessible names**? (the corrected RC#3 assumption — if Amazon's cards lack AX names, ARIA alone may still be insufficient and §8's vision question re-opens.)
- Coordinate-staleness fix correctness across a real full navigation (stamped-URL compare vs. actual `chrome.tabs.get` timing right after submit).

## 8. Out of scope / follow-ups

Vision-as-primary-extraction (Convention #5 holds — re-open only if Linux proves ARIA insufficient); SoM↔AXTree fusion; event-driven cache invalidation (A2, rejected); persisting bboxes across SW restart; raising the global default ARIA cap (extraction-only bump instead); a breaker pattern for repeated tab-not-found (obviated by durable `OPEN TABS`).

## 9. Next step

Invoke `writing-plans` to produce the TDD implementation plan (Streams A → B → C → tests), each task red→green with `npm test` green per commit. Linux validation tracked as the terminal, out-of-band gate.
