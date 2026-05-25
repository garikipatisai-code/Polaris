# Stream 2 — Page Action Research & Implementation Playbook

**Status:** Research; nothing in this file ships until reviewed.
**Date:** 2026-05-24
**Scope:** Output side of the agent — the tool layer that lets the model click, type, scroll, and otherwise change page state. Polaris currently has read-only browser tools (`aria.extract`, `tab.*`, `search`, `product.extract`); this stream defines the action surface that closes the gap with Comet.
**Reference repos at `~/Documents/Spike/Personal/Browser/refs/`:** none cloned. Citations below are from training data; file/function names are accurate but a clone is recommended before implementation.

---

## Overview — action layer choice

**Recommendation: Chrome DevTools Protocol (CDP) via `chrome.debugger` for primary actuation, with a small content-script helper for two cases (file-input synthesis, React-controlled-input fallback).**

Reasoning:

1. **Polaris already runs a `chrome.debugger` session** for `aria.extract`. Reusing it for `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `DOM.focus` means one attach per page, not two. The AX `backendDOMNodeId` we already have (currently unused in `aria_types.ts`) becomes the addressing token via `DOM.getBoxModel`. A content-script approach forces a parallel addressing scheme (CSS path, XPath) plus a `chrome.tabs.sendMessage` hop on every action.
2. **CDP events have `isTrusted=true`.** Real bot-detection (PerimeterX, Amazon's add-to-cart, hCaptcha pre-checks) sometimes refuses untrusted clicks. Browser-use, Skyvern, and LaVague all run on CDP-backed Playwright/Patchright/Selenium for this reason.
3. **A 4B model writes shorter, more reliable args.** `axNodeId: "23"` beats `selector: "#nav-cart-button > span:nth-of-type(2)"` (60+ chars, easy to misquote). Skyvern explicitly cites "stop having LLMs generate XPath" as a design principle.
4. **MV3 SW can't see the DOM** — a content-script approach has a hop tax we avoid.

Two carve-outs where we *do* use a content script:
- **File upload** — `<input type="file">` cannot be filled via CDP `Input.dispatch*`. CDP has `DOM.setFileInputFiles` but it requires an absolute OS path; extensions can't construct one. Content-script `DataTransfer` shim is the workaround.
- **React-controlled inputs** — `Input.insertText` works on most React forms; on the few it doesn't, fall back to `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, val) + dispatchEvent('input')`. Browser-use does this in `controller/service.py::_input_text_element_node`.

Trade-offs accepted: CDP shows the "Polaris is debugging this tab" banner (Skyvern hides it via Patchright; we can't, we're an extension). One debugger session per tab; user's open DevTools blocks us — same constraint as `aria.extract`.

---

## Feature 1 — Click element by ARIA name

**Recommendation:** `page.click({ tabId, role, name, nameMatch?: 'exact'|'contains', nth?: number })`.

**How:**
1. Re-fetch (or use cached <2 s) AX tree; filter by role+name to action-eligible roles (`button`, `link`, `menuitem`, `tab`, `checkbox`, `radio`, `option`).
2. AX node carries `backendDOMNodeId` (we add this to `aria_types.ts::AXNode`).
3. `DOM.getBoxModel({ backendNodeId })` → border-quad centroid is the click point.
4. `Page.bringToFront`, `DOM.scrollIntoViewIfNeeded`.
5. `Input.dispatchMouseEvent` thrice: `mouseMoved`, `mousePressed`, `mouseReleased` with `button:'left'`, `clickCount:1`. Three events not one — some pages listen on `mousedown` (Best Buy quick-add).
6. `awaitSettled(tabId)` (cross-cutting), return `{ clicked, navigated, postClickUrl, axNodeId }`.

**Why not content-script `el.click()`:** `isTrusted=false` is rejected by some retailer flows. Reimplementing the mousedown→mouseup→click sequence in a content script is the worst of both worlds.

**Cite:**
- **browser-use** `controller/service.py::_click_element_node` — Playwright `element_handle.click()` routes to CDP `dispatchMouseEvent` under the hood. Their addressing is a custom `highlight_index` integer, computed at extraction with visible-element marking. We use ARIA name+role because our extractor already produces them.
- **Skyvern** `webeye/actions/handler.py::handle_click_action` — primary is XPath from `incremental_element_tree`; falls back to center-of-bbox click. We use Skyvern's *fallback* as primary because our 4B model can't write XPath.
- **WebArena** `browser_env/actions.py::create_id_based_action` — integer-based `click [id]`.

**Integration:**
- Extend `aria_types.ts::AXNode` with `backendDOMNodeId?: number`; have `simplifyAxTree` propagate as `axNodeId: string` on `SimplifiedNode`.
- New file `src/agent/tools/browser/page_actions.ts` for the action family (shared lifecycle, mouse-coord computation, settle).
- Convert per-call `attach`/`detach` (current `aria.extract`) into a refcounted `withDebuggerSession(tabId, fn)` in `lifecycle.ts` so chained actions reuse one session.

**Dependencies:** none new.

**Risks:**
- **AX node staleness** — re-render between extract and click. `getBoxModel` throws "Node not found" → refetch AX once → retry. Surface as non-fatal.
- **Cross-origin iframes** need separate session (`Target.getTargets`); defer to M5.
- **Multiple matches** — when match count >1 and `nth` unset, return non-fatal error listing candidate `axNodeId`s + parent-name context so the model can disambiguate.

**Open questions:** AX-tree cache invalidation key — currently propose "invalidate after every `page.*` action and on `tab.wait_loaded` completion." Mutation-observer signal is overkill for Phase 1.

---

## Feature 2 — Form fill

**Recommendation:** Three tools, not one.
- `page.type({ tabId, role, name, value, clear?, submit?, secret? })` — text inputs, textareas (`textbox`, `searchbox`).
- `page.select({ tabId, role, name, optionValue?, optionLabel? })` — `<select>` and ARIA combobox.
- `page.set_checked({ tabId, role, name, checked })` — checkbox, radio.

A single `page.fill({ fields: [...] })` is appealing for token efficiency but a 4B model gets array shapes wrong ~30% of the time on long lists; three named tools are cheaper to learn. We can add `page.fill_batch` later if we measure batch-array reliability is high (it is for `sum`).

**How — text:** Resolve AX node → `DOM.focus` (essential for React's `onChange`) → if `clear`, `SelectAll` + Delete via `Input.dispatchKeyEvent` → `Input.insertText({ text })` (fires native input events React listens to — the win over `el.value=`) → if `submit`, dispatch Enter (`keyDown` + `keyUp`, `windowsVirtualKeyCode:13`) → `awaitSettled` → reread via `DOM.describeNode`, return `finalValue`.

**How — select:** Native `<select>` has no CDP-clickable popup, so use `Runtime.evaluate('el.value = X; el.dispatchEvent(new Event("change", {bubbles:true}))')`. Combobox-with-listbox: click combobox, click matching option (Feature 1 mechanics). Tool dispatches based on whether the AX node has `option` children.

**How — checked:** Read current state from AX node properties. If matches, return `{ already: true }` (idempotency saves a model turn). Otherwise click.

**React-controlled fallback:** When `Input.insertText` doesn't update visibly (heuristic: post-action `value` doesn't match), inject a content script:

```ts
// sketch, not committed
function setReactValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
```

Browser-use does this for *every* input; we try CDP first because non-React sites hit fewer bot heuristics that way.

**Cite:** browser-use `_input_text_element_node`; Skyvern `handle_input_text_action` (also has a "type one char with random delay" mode for paste-detection sites).

**Integration:** All three in `page_actions.ts`. Shared `resolveByRoleName(tabId, role, name, opts)` helper.

**Dependencies:** none new.

**Risks:**
- **Date pickers** — `<input type="date">` is locale-dependent for `insertText`; the safer path is the React-setter workaround. Calendar widgets need click-open + click-day, which is Feature 1 + Feature 1.
- **Autocomplete dropdowns** — `submit:true` should NOT press Enter while a listbox is visible (peek AX tree), or it selects highlighted suggestion when user wanted form submit.

**Open questions:** Should `page.type` `secret:true` redact value from logs/events? Yes — at log layer only (CDP still gets the real value).

---

## Feature 3 — Scroll

**Recommendation:** Two tools.
- `page.scroll_to({ tabId, role, name })` — scrolls until named element is in viewport (`DOM.scrollIntoViewIfNeeded`).
- `page.scroll_by({ tabId, dx?, dy })` — relative pixels via `Runtime.evaluate('window.scrollBy(dx,dy)')`.

For infinite-scroll, the loop is *Executor-level*: model calls `scroll_by`, then `aria.extract`, decides if more is needed, repeats. We do not provide a `scroll_until_text_appears` — that hides reasoning the agent should be doing.

**Mechanical safeguards in `scroll_by`:**
- Read `scrollHeight` and `scrollTop+clientHeight` post-scroll. If at bottom (within 4 px), return `{ atBottom: true }`.
- Hard cap at 20 scroll calls per Executor run (enforce in circuit breaker, not tool).

**Cite:** browser-use `browser_use/browser/browser.py::scroll_down`; WebArena `scroll [up|down]` granularity (one viewport per call).

**Integration:** `page_actions.ts`. Reuse `resolveByRoleName` for `scroll_to`; `scroll_by` is a thin `Runtime.evaluate` wrapper.

**Dependencies:** none.

**Risks:**
- **Virtualized lists** (react-window) — `scrollIntoViewIfNeeded` can't materialize the node. Defer to M5 (note in docstring).
- **Sticky headers** obscure target after scroll — accepted minor overlap.

---

## Feature 4 — Navigation race conditions

**Recommendation:** Every action that *might* navigate calls `awaitSettled(tabId)` before returning. Settled = **all of**:
- `chrome.tabs.get(tabId).status === 'complete'`, AND
- CDP `Page.lifecycleEvent === 'networkAlmostIdle'` (≤2 in-flight requests for 500 ms) OR 3 s wall-clock fallback, AND
- AX-tree mutation-stable for 250 ms (refetch tree twice 250 ms apart, JSON-equal-after-trim).

`awaitSettled` is internal — not a tool. The model's mental model: "click returns when the click is done."

**Why this set:**
- `tabs.status` only fires on full navigations, not SPA route changes.
- `networkAlmostIdle` catches XHR-driven UI updates.
- AX-tree-stable is the safety net for long-poll connections (Slack-style) where `networkAlmostIdle` never fires. Two reads ~50 ms each on simplified output.

**Cite:**
- **browser-use** `_wait_for_page_load` — Playwright's `wait_for_load_state('networkidle')` + 1 s settle.
- **Skyvern** `webeye/scraper/scraper.py::wait_for_page_to_load` — `domcontentloaded` + `networkidle0` + MutationObserver-based stability. Closest to our recommendation.
- **Playwright internals** — `_locator.click()` does an "actionability" wait including stable bbox across 2 animation frames. We could emulate with `getBoxModel` double-read; not Phase 1.

**Failure modes:**
- Modal dialog after click → no nav, AX-tree-stable still fires once modal renders. Fine.
- Click triggered nothing → AX-tree-stable fires immediately, `navigated:false`. Fine; we don't try to detect "no-op click."
- Click triggered download → out-of-band, handled in Feature 7.
- Settled timeout (10 s) → return `{ navigated: 'maybe', settled: false }`, non-fatal.

**Integration:** `awaitSettled` lives in new `src/agent/tools/browser/page_settle.ts`. Hooks `Page.enable` once per session.

**Dependencies:** none beyond CDP.

**Open questions:** Total budget — 10 s feels right within Executor budget; pages with continuous polling won't quiet down. May need per-domain override.

---

## Feature 5 — Back / forward / reload

**Recommendation:** Three thin tools, all `awaitSettled` after.
- `page.back({ tabId })` → `chrome.tabs.goBack(tabId)`
- `page.forward({ tabId })` → `chrome.tabs.goForward(tabId)`
- `page.reload({ tabId, hard? })` → `chrome.tabs.reload(tabId, { bypassCache: hard })`

**Why `chrome.tabs.*` not `tabs.update({ url })`:** `tabs.update` is a fresh nav — loses session-replay state (form-fill, scroll position, JS state). For "back" we want the actual history entry.

**Failure modes:**
- **No history entry** → `goBack` no-ops, listener never fires. Wall-clock timer expires, return `{ moved: false }`.
- **Login wall after back** — settled fires on the login page; the goal-anchored loop surfaces "I need to log in" naturally. Fine.
- **Cached page with stale data** — model can `reload({ hard: true })`.

**Cite:** browser-use has `go_back` + a `wait` action; forward folded into URL nav. WebArena has both as first-class.

**Integration:** `page_actions.ts`. Wraps `chrome.tabs.*` with `awaitSettled`.

**Dependencies:** none.

**Risks:** minimal — `tabs` API is stable.

---

## Feature 6 — File upload

**Recommendation:** `page.upload_file({ tabId, role, name, dataUri })`. Tool synthesizes a `File` and assigns to the input via content-script `DataTransfer` shim.

**How — three options ranked:**
1. **Content-script `DataTransfer` shim (recommended).** Inject script that decodes the base64 `dataUri` → `File` → `new DataTransfer()` → `dataTransfer.items.add(file)` → `inputEl.files = dataTransfer.files` → dispatch `change`. Sidesteps CDP's secure path; some banks/government sites gate uploads on `change`-trusted, real retailers don't.
2. **`DOM.setFileInputFiles` with OPFS temp file.** Doesn't help — CDP needs an OS path; OPFS isn't visible to it.
3. **`chrome.fileSystem` API.** Apps-only, not extensions.

So option 1 wins. Content script `upload_helper.js` ~30 lines, registered `world: 'MAIN'` via `chrome.scripting.executeScript`.

**Cite:** browser-use has no first-class file upload (TODO in their tracker). Skyvern's `handle_upload_to_s3_action` uploads files *they* stored in S3 via Playwright `set_input_files` — different problem shape. Puppeteer's `ElementHandle.uploadFile` uses `setInputFiles`; the no-Puppeteer fallback documented widely is the `DataTransfer` shim.

**Integration:** `src/agent/tools/browser/upload_helper.ts` (content-script source) + `page_actions.ts` registration. AX node → CSS selector mapping (one extra `DOM.describeNode` call) so the content script can find the input.

**Dependencies:** add `scripting` permission to manifest if not already present.

**Risks:**
- **Drag-and-drop uploads** (no `<input type="file">`) — out of scope for Phase 1; surface "not supported" message.
- **Multi-file uploads** — extend to `dataUris: string[]`. Easy.
- **Large files** — base64 inflates 33%; cap at 20 MB to avoid thrashing the message channel.

**Open questions:** Where does the model get `dataUri` from? Phase 1 (shopping) basically zero file uploads — defer source-of-blob design until M5.

---

## Feature 7 — File download

**Recommendation:** `page.download({ tabId, role, name, expectMime?, expectFilenamePattern? })`. Click trigger, monitor `chrome.downloads.onChanged`, return path + MIME on complete.

**How:**
1. Subscribe to `chrome.downloads.onCreated` *before* the click (filter by `DownloadItem.tabId`).
2. Click trigger.
3. Await `onChanged` with `state.current === 'complete'` for matching `id`. Timeout 30 s.
4. `chrome.downloads.search({ id })` for `filename`, `mime`, `byteSize`.
5. Validate against `expectMime`/`expectFilenamePattern`; mismatch returns non-fatal `{ ok:false, error: 'unexpected file type' }`.

**Where files go:** Chrome's normal Downloads folder. Agent doesn't move them. Matches user expectations.

**Cite:** browser-use `download_file` wraps Playwright's `download` event — same shape. `chrome.downloads` API has `onDeterminingFilename` for "save to this path"; not needed Phase 1.

**Integration:** `page_actions.ts`. Lazy `chrome.downloads.onCreated` listener on first call.

**Dependencies:** add `downloads` permission.

**Risks:**
- **Auto-download via meta-refresh** — tool can't see, no click happened. We don't expose "watch for any download"; only "click and watch."
- **"Always ask" save dialog** — `onCreated` fires but `onChanged` never reaches `complete`. Hint in returned error.

---

## Feature 8 — Multi-window orchestration

**Recommendation:** Stick with multi-tab for Phase 1. Do not add `window.create` yet.

**Reasoning:** Multi-window is appropriate when you want parallelism on the user's *screen* (side-by-side visual review), not for parallel reasoning. The model is one queue — two tabs running concurrently means we extract from one while the other loads. Phase 1 deliverable is summarized findings in the side panel; the user doesn't need both tabs visible.

When to revisit: if M4 telemetry shows >10% of Executor turns spent on tab-switching boilerplate, fix is better tab-state caching (internal), not multi-window.

**Integration:** none. Existing `tab.*` is sufficient.

---

## Feature 9 — Sensitive-action confirmation gates

**Recommendation:** Tool throws `ConfirmationRequired` → orchestrator catches → side panel shows yes/no → user clicks → orchestrator re-dispatches with one-shot `__userApproved: true` flag.

**Sensitive triggers:**
- `page.click` when resolved AX node's name matches a configurable pattern list (`/place order/i`, `/buy now/i`, `/delete account/i`, `/confirm purchase/i`, `/send/i` on email composers).
- `page.type` into a `type="password"` input (Phase 1: no managed credential store).
- Any future explicit-purchase tool.

**Architecture:**

```ts
// sketch, not committed — src/agent/tools/browser/safety.ts
export class ConfirmationRequired extends Error {
  constructor(public readonly question: string,
              public readonly action: { tool: string; args: unknown }) {
    super(`confirmation required: ${question}`);
    this.name = 'ConfirmationRequired';
  }
}
```

In `dispatchTool`:
1. Tool throws `ConfirmationRequired` → orchestrator transitions to new phase `AWAITING_CONFIRM`.
2. Persist pending action `{ tool, args, question }` to hot state.
3. Emit `agent.confirm_request` event; UI renders "Polaris wants to: X. [Approve] [Deny]".
4. **Approve** → re-dispatch with `__userApproved: true` (Zod schema accepts it, tool skips its safety check).
5. **Deny** → returns `{ ok:false, error: 'user denied' }` to model; goal-anchored loop reasons about it.
6. **5-min timeout** → ABORTED with `confirm_timeout`.

**UX:** Side panel shows action description + resolved target (role+name) + bbox screenshot crop (`Page.captureScreenshot` with `clip` from `getBoxModel`). User sees "Polaris wants to click 'Place Order' at this position" with thumbnail.

**Cite:**
- browser-use `human_in_the_loop` hook (off by default, all-or-nothing).
- Skyvern `requires_human_review` per-action flag in workflow definitions.
- OpenAI Operator (closed but documented) — confirms before every "money or messaging" action.
- Anthropic Computer Use docs explicitly recommend confirmation for irreversible actions.

**Integration:**
- New phase `AWAITING_CONFIRM` in `agent_types.ts`.
- New `safety.ts` with `ConfirmationRequired` + `markAsSensitive(handler, isSensitive)` decorator.
- `App.tsx` event-timeline interceptor for `confirm_request` events.
- Pattern list in settings; default ships hardcoded shopping-focused list.

**Dependencies:** none new — state-store mutex already supports the read-modify-write.

**Risks:**
- **Latency** — extra click on legitimate flows. Mitigation: optional "trust for next N min" expiring bypass; default off.
- **Pattern false positives** — extra confirm click; acceptable.
- **False negatives** — new retailer uses "Complete Purchase" not in list; user encounters unconfirmed purchase. Mitigation: conservative default list, expand per retailer adapter.

**Open questions:** Should confirmation cover credit-card fields by `autocomplete="cc-number"` detection? Yes — explicit `autocomplete` token list.

---

## Feature 10 — Selector stability

**Recommendation:** Hybrid — ARIA name+role primary; on resolver failure, anchor-based fallback; visual fallback last-resort (deferred until vision verifier lands).

**Three-tier fallback:**
1. **Anchor-based** (Phase 1): if model said "click 'Add to Cart'" but page is in Portuguese (`Adicionar ao Carrinho`), walk the AX tree from the *price* node (universally numeric) and find the nearest `button` child. Skyvern's anchor strategy, generalized.
2. **Element fingerprinting** (M5): record per actionable element `(role, parent role, sibling roles, text-length bucket, near-by image)`. On re-extract, fingerprint matches even when name changes.
3. **Visual fallback** (post-vision): screenshot + ask vision model "where is button to add to cart?" → bbox → click. ~3 s, last resort.

For Phase 1, only tier 1 ships — anchor fallback in `page.click`'s resolver. Anchors hardcoded per retailer adapter; generic anchors (price node, search box, etc.) for unknown sites.

**Cite:**
- **Skyvern** `LLMElementSelector` — screenshot+caption+DOM-context with a small model; explicitly rejects "give me an XPath." Selector cache *is* a fingerprint.
- **LaVague** `WebActionEngine` — embedding-based grounder; model emits NL description, ANN-search picks closest DOM node by semantic similarity. Great for name changes, expensive.
- **browser-use** sticks with index-based addressing; re-extracts every turn. Cheap but high token cost.

**What we adopt:**
- Re-extract every turn before action (already default).
- Anchor-based fallback for cart/checkout/search input. Hardcoded per retailer adapter for Phase 1.
- Vision verifier as last-resort, gated behind setting (latency).

**Integration:** `page.click` and `page.type` get `fallback?: 'anchor'|'vision'|'none'` arg, default `'anchor'`. Anchor logic in `page_actions.ts`, consults retailer adapters when URL matches.

**Dependencies:** vision tool (M3 deferred) for tier 3.

**Risks:**
- **Anchor mis-selection** — "cheapest button near price" could be "remove from cart" on a wishlist row. Mitigation: filter candidates by name regex (`/add|cart|buy/i`); per-locale lists (M5).

**Open questions:** Per-locale name patterns shipped with adapters? Yes for top 5 locales, M5.

---

## Cross-cutting: page-stability detection

Already in Feature 4. Recap of helper:

```ts
// sketch, not committed — src/agent/tools/browser/page_settle.ts
export interface SettleOpts {
  totalBudgetMs?: number;   // default 10_000
  quietWindowMs?: number;   // default 250 (AX-tree stability)
  networkIdleMs?: number;   // default 500 (CDP networkAlmostIdle)
}
export async function awaitSettled(tabId: number, opts?: SettleOpts):
  Promise<{ settled: boolean; navigated: boolean; finalUrl?: string }>;
```

Every action tool calls this before returning. The action's settle drives `navigated:true` if URL changed. `tab.wait_loaded` stays as an explicit-wait escape hatch.

---

## Cross-cutting: confirmation-gate UX

Already in Feature 9. Recap:
- New phase `AWAITING_CONFIRM` between EXECUTING and tool result.
- Side-panel card with action description + bbox thumbnail + Approve/Deny.
- Tool re-dispatched with `__userApproved:true` skips its safety check.
- 5-min timeout → ABORTED.

---

## Recommended action set — 8 tools (9 with reload)

```ts
// sketch, not committed — names + arg shapes only

page.click({ tabId, role, name, nameMatch?, nth?, __userApproved? })
  → { clicked, navigated, postClickUrl?, axNodeId? }

page.type({ tabId, role, name, value, clear?, submit?, secret? })
  → { typed, finalValue, navigated }

page.select({ tabId, role, name, optionValue?, optionLabel? })
  → { selected, finalValue }

page.set_checked({ tabId, role, name, checked })
  → { changed, finalState }

page.scroll_to({ tabId, role, name }) → { scrolled }
page.scroll_by({ tabId, dx?, dy }) → { atBottom, scrollY }

page.back({ tabId }) → { moved, postUrl? }
page.forward({ tabId }) → { moved, postUrl? }
page.reload({ tabId, hard? }) → { reloaded }

// Defer to M4/M5 (Phase 1 doesn't exercise):
//   page.upload_file
//   page.download
```

Total: 9 mainline tools. With existing 14 → 23. Still under the "tool list breaks the model" range (~30 from browser-use's reports).

---

## Implementation order

1. **`withDebuggerSession` refcount refactor** in `lifecycle.ts`. Convert `aria.extract`. No behavior change. (½ day)
2. **`Page.enable` + `Page.lifecycleEvent` plumbing** for `awaitSettled`. (½ day)
3. **`awaitSettled` helper** with tests. (1 day)
4. **`page.click`** — first action; AX-resolve cache included. (1.5 days)
5. **`page.type`** — uses click's resolver; React-controlled-input fallback content script. (1.5 days)
6. **`page.select` + `page.set_checked`** — small once click exists. (1 day combined)
7. **`page.scroll_to` + `page.scroll_by`**. (½ day combined)
8. **`page.back` / `page.forward` / `page.reload`** — thin wrappers. (½ day combined)
9. **Confirmation gate** — phase + UI + replay. **Must land before `page.click` is on by default.** (1.5 days)
10. **Anchor-based fallback resolver** — Phase 1 hardcoded for cart/search; per-retailer expansion. (1 day framework, ongoing for adapters)

Total: **~10 days** for action surface behind an "experimental" flag, then real-browser end-to-end on Linux box.

Dependency graph: 1→2→3 first. 4 unlocks 5–8. 9 must land before 4 ships to users. 10 is incremental.

---

## Open questions for the user

1. **Debugger banner UX.** Ship with the loud "Polaris is debugging" banner, or investigate a per-domain content-script-only fallback for non-bot-detected sites?
2. **Confirmation gate scope.** Default list block `page.type` into a credit-card field? Likely yes, but friction-heavy on first checkout test.
3. **Pre-canned retailer anchor lists.** Plumb anchor hints (price node, search box) into the retailer adapter interface now, or wait until measured anchor failures?
4. **Multi-locale name patterns.** English-only patterns OK for v1?
5. **File upload deferral.** Confirming no Phase-1 user story exercises file upload.
6. **Cloning refs.** Should I clone `browser-use`, `Skyvern-AI/skyvern`, `lavague-ai/LaVague`, `web-arena-x/webarena` to `~/Documents/Spike/Personal/Browser/refs/`? Reading their actual code resolves at least three of the open questions above (especially confirmation-gate UX patterns).
7. **Vision fallback timing.** Tier-3 visual selector needs vision verifier (M3-deferred). Block action stream on vision, or ship without and accept some ARIA-only failures?

---

*End of stream2-page-action.md.*
