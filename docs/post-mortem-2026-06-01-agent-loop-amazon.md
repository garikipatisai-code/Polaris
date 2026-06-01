# Post-Mortem: Agent Loop Fails on Amazon "wireless mouse" Search

> Written 2026-06-01 on the Linux P2200 after burning ~$3 of DeepSeek credits
> watching the same 4 bugs cycle. Read this before touching the agent loop,
> the page extractor, or the Amazon adapter. This is a handoff document for
> the Mac Claude session — the Linux session stops here to avoid wasting
> more cloud API budget.

---

## What Happened

**Goal:** `Go to amazon.com, search for 'wireless mouse', and list the names and prices of the first 3 results`

The agent ran for 30+ Executor turns across 3 replans and NEVER successfully
extracted a product name or price. It burned ~$3 in DeepSeek API costs on
repeating the same failed patterns. The Evaluator correctly saw the data was
missing each time and told it to continue/replan — but the fixes never
addressed the root causes, so each replan just re-ran the same broken sequence.

---

## Root Cause #1: Stale ARIA Cache in `page.extract` (THE HEADLINE BUG)

**File:** `extension/src/agent/tools/browser/extract.ts` lines 48-58

```typescript
const cached = getCachedElements(args.tabId);
if (cached && cached.length > 0) {
  pageDescription = JSON.stringify(cached.slice(0, 50));  // ← USES STALE CACHE
} else {
  // Fall back to extracting the ARIA tree directly
  ...
}
```

**The bug:** After `tab.type({selector:"#twotabsearchtextbox", submit:true})`
submits the search, the page navigates from the Amazon homepage to the
search-results page. But the element cache (`Map<tabId, SimplifiedNode[]>`)
still holds the **homepage tree**. Since the cache is non-empty,
`page.extract` serializes the cached homepage tree and asks the model
for product listings — which don't exist on the homepage. The model
correctly replies "I cannot find product listings."

**The fix:** `page.extract` SHOULD NOT use the element cache at all. The
cache exists for `tab.click`/`tab.type` (where element indices and bounding
boxes must stay stable). For `page.extract`, always do a fresh
`aria.extract` call:

```typescript
execute: async (args) => {
  const { ariaExtractTool } = await import('./aria');
  const result = await ariaExtractTool.execute({ tabId: args.tabId }, { taskId: '', stepId: '' });
  const pageDescription = JSON.stringify(result.tree ?? '');
  // ...send to model...
};
```

Or, if you want to be smarter: compare the current tab URL against the URL
at cache-population time, and only use the cache if they match.

---

## Root Cause #2: `aria.extract` Uses Stale Tab ID `1`

**Observed in the log:**
```
tool aria.extract({"tabId":1})
→ ✗ aria.extract threw: aria.extract failed: No tab with given id 1.
```

After a replan, the Executor called `aria.extract` with `tabId: 1` — a tab
ID that no longer exists (previous tabs were closed or the replan reset the
ownership). The model hallucinated this ID from its training data or from
the tool description examples.

This happened **6 times** in the run, each wasting a DeepSeek call.

**Fixes needed:**
1. The Executor prompt should tell the model to call `tab.list()` first if
   it doesn't know the tab ID, instead of guessing.
2. `aria.extract`'s error message should suggest calling `tab.list()`:
   `"tab not found — call tab.list() to discover active tabs"`
3. The circuit breaker should detect repeated `tabId: 1` failures as a
   pattern and force a `tab.list()` call before the next extraction.

---

## Root Cause #3: Amazon's Dynamic Content Not in Simplified ARIA Tree

Even when the agent WAS on the correct search-results page (after
`tab.open` → `tab.type("wireless mouse")` + Enter), the ARIA tree
extraction didn't contain product data. Two sub-problems:

### 3a. Amazon lazy-loads product cards

Amazon's search results page loads a skeleton DOM first, then JavaScript
fetches product data and renders the listing cards. The `tab.wait_loaded`
(polling `document.readyState === 'complete'`) fires before the product
cards render. There's no `domSettle` step — a common pattern from
reference projects (see Reference Repos below).

**Fix:** Add a `tab.dom_settle` tool or at minimum a `tab.settle(timeoutMs)`
that waits for the DOM to stop mutating (watch for `childList` mutations
going idle for 500ms).

### 3b. `simplifyAxTree` drops product card content

Amazon's product cards are deeply nested `<div>` trees. The
`simplifyAxTree` pass drops "generic" containers and nodes without
accessible names. This strips the product data from the tree before
it reaches the model.

**Fix:** Add a phase to `simplifyAxTree` that detects product-card-like
patterns and preserves their text content even when the ARIA role is
"generic". Or use `page.extract` with the un-simplified tree for
data-extraction queries. Or use vision as the primary extraction channel
for dynamic pages.

### 3c. The ARIA output cap (8000 chars) may clip product listings

Amazon search results can have 16+ products, each with complex ARIA
nodes. At 8000 chars, the first N products may be present but clipped
by the `[truncated]` marker.

---

## Root Cause #4: No Vision Fallback for Extraction Failure

The Executor has `tab.screenshot` and `vision.ground` available, but
NEVER used them. Every extraction attempt went through `page.extract` →
ARIA tree → model, which failed every time.

The Executor prompt RULES say vision is verification-only. For dynamic
pages like Amazon search results where the ARIA tree is unreliable,
vision should be the PRIMARY extraction channel.

**Fix:** Update the Executor prompt rule about vision to include a
fallback path: "If aria.extract or page.extract returns no useful data,
use tab.screenshot + vision.ground to visually extract the page content."

---

## What the Run Looked Like (condensed)

```
T1  tab.open("https://www.amazon.com")           → OK tabId=1146041647
T2  aria.extract(tabId=1146041647)               → OK (homepage tree)
T3  tab.type(selector="#twotabsearchtextbox")     → OK, search submitted
T4  page.extract("list products")                → "no products found" ← STALE CACHE BUG
... evaluator: continue ...
T5  aria.extract(tabId=1146041647)               → OK (homepage tree again??)
...
    evaluator: continue
    compactor fires
T6  aria.extract(tabId=1)                        → ERROR: no tab 1 ← STALE TAB ID
T7  tab.list() → discovers tabId=1146041647 still exists
T8  page.extract("list products")                → "no products" ← STALE CACHE BUG AGAIN
... evaluator: replan ...
    planner: new plan
T9  tab.type(index=1, ...)                       → cache miss, index unknown
T10 tab.open("https://www.amazon.com")           → OK, new tabId=1146041653
T11 aria.extract(tabId=1146041653)               → OK (homepage)
T12 finish("I couldn't find products")           → FAILED
    evaluator: replan
```

~$3 of DeepSeek API calls, zero useful output.

---

## Reference Repos — What They Do Differently

These were studied during the design phase. Key lessons for this bug set:

### [browser-use](https://github.com/browser-use/browser-use)

- **DomService** processes the full DOM tree, not just ARIA. Gets text
  content of elements even when they're generic `<div>` wrappers.
- Uses Playwright's `page.get_by_role()` and `page.locator()` for
  element targeting — CSS/XPath, not ARIA indices.
- Has explicit `wait_for_page_to_load()` and `wait_for_stable_dom()`
  between navigation and extraction.
- **Relevant here:** They don't use ARIA tree at all — they extract the
  full DOM text content with `outerHTML` truncation at 200K chars.

### [Stagehand](https://github.com/browserbase/stagehand)

- Uses "domSettle" — watches for `childList` mutation observer to go
  idle for 500ms before declaring the page ready.
- Has an `act()` function that chains: observe → decide → execute.
- Their CDP layer is production-grade (used by Browserbase).
- **Relevant here:** The `domSettle` pattern would fix the
  "page loaded but products not rendered" race.

### [browserllama](https://github.com/richard-xx/browserllama) (inactive)

- Uses XML representation of the interactive page elements.
- Extracts ALL text content, not just ARIA-labelled nodes.
- Simpler approach — less reliable but easier to debug.

### [Playwright's `page.fill()`](https://playwright.dev)

- Uses `Input.insertText` (which we just adopted — correct fix).
- Clears fields via `element.select()` + `delete` before typing.
- **Relevant here:** The `element.select()` approach is more reliable
  than `el.value = ''` for some input types.

---

## Specifc Code Changes Needed

### Fix 1: `page.extract` — always do fresh extraction

**File:** `extension/src/agent/tools/browser/extract.ts`

Remove the cache-read path. Always call `aria.extract` fresh:

```typescript
execute: async (args) => {
  const { ariaExtractTool } = await import('./aria');
  const result = await ariaExtractTool.execute(
    { tabId: args.tabId },
    { taskId: '', stepId: '' }
  );
  const pageDescription = JSON.stringify(result.tree ?? '');
  // ...rest unchanged...
};
```

### Fix 2: Stale tab ID detection

**File:** `extension/src/agent/tools/browser/aria.ts`

When `chrome.debugger.attach` fails with "No tab with given id", return
a structured error instead of throwing, and include a hint:

```typescript
error: `aria.extract: tab ${tabId} not found — call tab.list() to discover active tabs`
```

**File:** `extension/src/agent/tools/browser/tab.ts` — same for tab tools.

### Fix 3: Executor prompt — vision fallback for data extraction

**File:** `extension/src/agent/prompts/executor.ts`

Add a rule:
```
- If page.extract or aria.extract returns no useful data (empty results,
  "no products found"), take a screenshot with tab.screenshot then use
  vision.ground to visually extract the information.
```

### Fix 4: DOM settle between navigation and extraction

**Create:** `extension/src/agent/tools/browser/settle.ts`

A tool that watches a tab's DOM mutations and resolves when mutations
have been idle for 500ms (or timeout). Register as `tab.dom_settle` in
the tool registry.

### Fix 5: Tab ID recovery in circuit breaker

**File:** `extension/src/agent/circuit_breaker.ts`

Add a pattern: if 3+ consecutive errors contain "No tab with given id"
or "not found", inject a synthetic `tab.list` call before the next
executor turn.

---

## Testing Checklist

After the fixes:

1. **Unit test:** `page.extract` uses fresh extraction, not cache
2. **Unit test:** stale tab ID error message includes `tab.list()` hint
3. **Browser smoke:** `python3 scripts/browser_smoke_hybrid.py` — 5/5 PASS
4. **Real agent run** on the Linux P2200:
   ```
   Goal: "Go to amazon.com, search for 'wireless mouse', and list the
   names and prices of the first 3 results"
   ```
   Expected: agent navigates → searches → waits for settle → extracts
   → lists 3 products with prices. No "no products found" errors.
5. **Cost check:** Should complete in ≤15 Executor turns, not 30+.
