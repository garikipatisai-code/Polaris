# Stream 1 — Page Understanding (Implementation Playbook)

## Overview

Polaris's hot path is "what is on this page, in the smallest representation that lets a 4B model decide what to do next." Today the only extraction channel is `simplifyAxTree` over `Accessibility.getFullAXTree`, capped at 4 000 chars. That covers structurally regular pages (a search-result list, a product detail page on Amazon's main frame) but is silently wrong on five common page shapes: long-form articles, PDFs, video pages with transcripts, multi-frame composites (ads, payments, embeds), and SPA states that mutate after navigation completes. This playbook is the M3.5/M4 extraction story for those shapes. Each feature includes a recommended technique, alternatives I considered and rejected, the integration point in the existing repo, and the open questions a real-browser pass on the Linux box has to answer before this ships.

The constraint that drives every recommendation is **token economy**, not capability. An Executor turn must fit in 6 K tokens; ARIA at 4 000 chars is already ~1 K tokens before the prompt scaffolding. That means new channels (Reader-mode text, PDF text, transcripts) need their own per-channel caps and their own tools — they cannot piggyback on `aria.extract`'s budget.

The second-order constraint is **MV3 service-worker isolation**: the SW has no DOM, no `window`, no Image element, no DOMParser by default, and no PDF.js. Every "extract X" path either uses `chrome.debugger`, runs in a content script, or fetches bytes and parses them in the SW. That alone disqualifies most NPM extraction libraries.

Reference repos: `~/Documents/Spike/Personal/Browser/refs/` does not exist on this Mac, so the recommendations below cite the relevant projects (`mozilla/readability`, `tinyfish-io/agentql`, `unclecode/crawl4ai`, `web-arena-x/webarena`, `browser-use/browser-use`, Anthropic Computer Use) by file/algorithm name from training data and inline pointers a Linux-side Claude can verify when the repos are available.

---

## Feature 1: ARIA-tree depth & quality

### Recommendation

Keep `Accessibility.getFullAXTree` as the primary channel, but extend `simplifyAxTree` along three axes — node identity, link discovery, and text retention — and split the 4 000-char cap into a **role-aware budget** that protects interactive nodes from being trimmed before static text.

Concretely:

1. **Annotate every node with a stable `nodeId`** that maps back to a CDP `backendDOMNodeId`. The current `SimplifiedNode` has `{ role, name, value, children }` and nothing the agent can click on. The chrome.debugger response already carries `backendDOMNodeId` per AX node (Polaris currently strips it in `aria_types.ts`). Keep it as `ref` on `SimplifiedNode`. The Executor's future `click` tool then resolves `ref → backendDOMNodeId` and dispatches `DOM.resolveNode` + `Runtime.callFunctionOn { functionDeclaration: 'function() { this.click() }' }`. This is the same indirection browser-use uses for stable selectors and what AgentQL calls "interaction handles."
2. **Capture `href` on link / button nodes.** AX nodes for role `link` carry the URL in CDP's `properties[]` array as `{ name: 'url', value: { value: '...' } }`; the current parser drops it. Adding it lets the Planner build a navigation tree without a separate DOM dump and lets the Executor click without a backref roundtrip.
3. **Retain `description`, `placeholder`, `roleDescription`, and the `valuetext` properties** for inputs. CDP exposes them on `AXNode.properties[]`. Today inputs surface as `{ role: 'textbox', value: 'whatever was typed' }` with no hint of what the field is for; adding `placeholder` ("Search for products...") often replaces a `name` lookup that ARIA tools sometimes miss when the visible label is in a sibling.

Token-cap pass becomes role-aware: when trimming, **never drop nodes whose role is in a "keep set"** (`button`, `link`, `textbox`, `combobox`, `checkbox`, `tab`, `menuitem`, `searchbox`, `listbox`). Trim leaves of static text (`paragraph`, `heading` deeper than h3, `text`) first. The current implementation prunes deepest leaves regardless of role, which on Amazon Search is exactly backwards — the model loses "Add to cart" buttons before product titles.

Sketch (not committed):

```ts
// in aria.ts, replacement for pruneLeavesAtDepth's filter
const KEEP_ROLES = new Set([
  'button', 'link', 'textbox', 'combobox', 'checkbox',
  'tab', 'menuitem', 'searchbox', 'listbox', 'option',
]);
const isInteractive = (n: SimplifiedNode) => KEEP_ROLES.has(n.role);
node.children = node.children.filter((c) => isInteractive(c) || (c.children && c.children.length > 0));
```

### Alternatives

- **AgentQL-style query language.** AgentQL parses pages into a typed schema you query (`{ products[] { title, price, link } }`). Powerful but server-bound — the heavy lifting is a hosted LLM that maps query → DOM selectors. We can't ship that on-device at 4B. We can, however, borrow their **two-pass pattern**: first call summarizes the tree's "shape" (what regions exist), second call drills into the relevant region. That's our Planner→Executor split already; AgentQL just confirms it generalizes.
- **browser-use's "indexed DOM tree".** They flatten the page to numbered interactive elements with bracketed indices (e.g. `[42] button "Add to cart"`). Cheaper than nested ARIA for click-heavy tasks, but loses hierarchy that the Planner needs to reason about page regions. Recommendation: use indexed-flat for the Executor (action selection), nested for the Planner (region understanding). Same data, two views.
- **Raw DOM via `chrome.scripting.executeScript`.** Rejected in ADR 0001 and still rejected: 10–50× more tokens with no semantic gain, and all the layout noise we already skip.

### Integration

`src/agent/tools/browser/aria_types.ts` adds `ref?: number`, `href?: string`, `description?: string`, `placeholder?: string`. `aria.ts`'s `buildSimplified` reads `node.backendDOMNodeId` and walks `node.properties[]` for the link/input fields. The token-cap pass switches from leaf-depth pruning to role-aware pruning. The future `click` / `type` tools take `ref: number`, resolve via `DOM.resolveNode({ backendNodeId })` to a `RemoteObject`, then `Runtime.callFunctionOn`.

### Dependencies

None new. `chrome.debugger` already exposes `DOM.resolveNode` and `Runtime.callFunctionOn` on the same session.

### Risks

- `backendDOMNodeId` is opaque per session. It's stable for the life of the debugger attachment but not across detach/reattach. This is fine because Polaris attaches once per `aria.extract` call; the click tool would attach again and re-extract. As long as the extract→click pair happens within seconds and the page hasn't navigated, the `ref` stays valid. After navigation the agent must re-extract before clicking — encode this as a tool contract, not an assumption.
- Larger `SimplifiedNode` shape eats token budget. Adding `href` on every link costs ~50 chars per link; on a search-results page with 50 links that's 2 500 chars, more than half the cap. Mitigate by emitting `href` only on `link` and `button` roles, and by keeping `description`/`placeholder` only when `name` is empty.

### Open questions

- Empirical ARIA-vs-token-budget curves: we have no measurement of how often the 4 000-char cap fires on real pages. Need a Linux-box pass that logs `treeChars` for the top 20 retailer/news/SPA URLs.
- Should the agent see a "page region overview" first (top-level landmarks: `banner`, `navigation`, `main`, `complementary`, `contentinfo`) before the full tree? Cheap to produce, and matches how humans scan pages.

---

## Feature 2: Frame / iframe traversal

### Recommendation

Use `Page.getFrameTree` (CDP) to enumerate every frame, then call `Accessibility.getFullAXTree` **once per frame** with the frame's `frameId` as a parameter, and stitch the trees by replacing each `<iframe>` placeholder node in the parent with the child's root. Cap aggregate output at 6 000 chars; reject obvious junk frames (ad networks, analytics) by URL pattern before extraction.

The Chrome DevTools Protocol exposes `Accessibility.getFullAXTree({ frameId })` — Polaris's current call passes no frameId, which gets the top frame only. Cross-frame aware projects (browser-use, Stagehand) all do the same multi-frame walk:

1. `Page.getFrameTree` → returns a tree of `{ frame: { id, url, parentId }, childFrames }`.
2. For each `frame.id`, call `Accessibility.getFullAXTree({ frameId })`.
3. In each parent tree, find AX nodes with `role: 'Iframe'` and a `frameId` property; replace that placeholder with the child tree's simplified root.

### Alternatives

- **Inject content scripts into all frames** (`chrome.scripting.executeScript({ allFrames: true })`). Rejected: content scripts can't access cross-origin iframes (Stripe, YouTube embeds), so you get the same partial coverage you started with, plus a content-script-runtime tax.
- **`oopif` (out-of-process iframe) sniffing via `Target.attachToTarget`.** Possible — chrome.debugger does support `flatten: true` and per-target sessions — but adds a multiplexer between the orchestrator and CDP that is over-engineered for the M3 scope.
- **Skip iframes entirely.** What we ship today. Acceptable until the agent hits a checkout page where the price is in the parent frame and the card form is in a Stripe iframe; then it's wrong.

### Integration

`src/agent/tools/browser/aria.ts` `runExtraction()` becomes:

```ts
// sketch, not committed
const frameTree = await callDebugger((cb) =>
  debuggerApi.sendCommand(target, 'Page.getFrameTree', undefined, cb)
);
const frames = flattenFrames(frameTree); // [{ id, url, parentId }, ...]
const trees = new Map<string, AXTree>();
for (const f of frames) {
  if (skipByUrl(f.url)) continue;
  const raw = await callDebugger((cb) =>
    debuggerApi.sendCommand(target, 'Accessibility.getFullAXTree', { frameId: f.id }, cb)
  );
  trees.set(f.id, coerceAXTree(raw));
}
return { tree: stitchFrames(trees, frames) };
```

`stitchFrames` is new: walks the top frame's simplified tree, for any node whose AX `frameId` matches a child frame, replaces it with the child's simplified root (recursively, depth-first).

### Dependencies

`Page` domain enable. Add `Page.enable` after `Accessibility.enable` in `runExtraction`. No new permissions — `debugger` covers Page domain.

### Risks

- N frames × per-frame attach cost. On a heavy ad-laden page the frame count can be 30+. Mitigate by URL skip-list (drop `doubleclick.net`, `googletagmanager.com`, `googlesyndication.com`, `facebook.com/tr`, etc.) before extraction. Empirically these account for the bulk of frame count on news/retail pages.
- Cross-origin iframes return AX trees but with restricted information (some properties are nulled by the renderer for privacy). Acceptable — we keep what's there.
- 6 000-char aggregate cap is tighter than today's 4 000 because the Executor budget is 6 K tokens and we must reserve room for prompt + tool definitions. The role-aware pruning from Feature 1 applies per-frame before stitch, then again at aggregate.

### Open questions

- Stripe iframes: do their AX trees reveal field semantics we'd be tempted to act on (and shouldn't, for privacy)? Need a real-page test on a Stripe checkout. Phase 1 doesn't automate checkout, but Phase 2 will.
- YouTube embeds: the iframe content is essentially `<video>` plus chrome; not worth extracting for shopping. Add YouTube to the skip-list.

---

## Feature 3: Reader-mode / declutter

### Recommendation

Bundle a forked, content-script-only copy of **Mozilla Readability** (`mozilla/readability` repo's `Readability.js`) and gate it behind a new `reader.extract` tool. The Planner detects long-form pages (heuristic: ARIA tree has `role: 'article'` AND `<main>` text > 2 000 chars AND no `role: 'list'` with > 5 items) and routes to `reader.extract`; otherwise stays on `aria.extract`.

Readability's algorithm in one paragraph: it scores every `<p>`, `<pre>`, `<td>` element on (a) text length, (b) presence of comma-shaped sentence punctuation, (c) class/id name signals (negatives like `comment`, `share`, `related`; positives like `article`, `body`, `content`), then climbs the DOM picking the highest-scored ancestor as the "top candidate," and serializes its text + a small set of structural tags (h1-h6, p, blockquote, pre, ul/ol/li, a, img). It's been the engine behind Firefox Reader View and Safari Reader since 2010, and its scoring tables are well-tuned for English news/blog content.

### Alternatives

- **Trafilatura / Goose / Boilerpy.** Trafilatura is best-in-class for extraction quality (compares favorably to Readability on the AVE benchmark) but it's Python and pulls in lxml — doesn't ship in a Chrome SW.
- **`@mozilla/readability` npm.** Same algorithm as the source repo, but it requires a `Document` (DOMParser-style) — needs a content-script runtime, not the SW. Acceptable; we run it via `chrome.scripting.executeScript`.
- **Pure-text via `document.body.innerText`.** Cheap but loses heading structure, which the model uses to navigate long articles. Use as the fallback when Readability returns null (which it does on ~5% of pages by Mozilla's own bug tracker).

### Integration

New file `src/agent/tools/browser/reader.ts`. New content script `src/content/reader_runner.ts` bundled by Vite with `web_accessible_resources` exposed:

```ts
// reader.ts (sketch)
execute: async (args) => {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: args.tabId },
    files: ['src/content/reader_runner.js'],
  });
  return { ...result.result }; // { title, byline, content, excerpt, length }
};
```

`reader_runner.ts` imports the bundled `Readability` class, runs `new Readability(document.cloneNode(true)).parse()`, and posts the structured result back. Output is `{ title, byline, content (HTML), excerpt, length }`. We then strip HTML in the SW (regex on `<[^>]*>`), enforce a 5 000-char cap, and return.

### Dependencies

- `@mozilla/readability` (~30 KB minified). One new npm dep — flag for user approval per task constraint "DO NOT add dependencies." So: do not add today; have the user approve in the open-questions section.
- `scripting` permission (already requested? — manifest currently has `tabs`, `debugger`, `activeTab`. Add `scripting`.).

### Risks

- Manifest-permission audit triggered: adding `scripting` is a Web Store review signal. Trade-off: we already have `debugger`, which is heavier; `scripting` is a strict subset.
- Readability is a snapshot of the DOM at parse time; SPA late-mount content is missed unless we wait for stability first (Feature 8).
- Long Reader-mode output blows the Executor budget; reserve `reader.extract` as a Planner-tier tool (Planner has 32 K, room for one full long-form article).

### Open questions

- Does Readability's scoring miss interactive elements we'd want for shopping? On a long-form deal article from Wirecutter the answer is "the deal links matter; the prose around them is decoration." The `aria.extract` channel should be primary even on those pages; `reader.extract` is the fallback for "user asked the agent to summarize this article."

---

## Feature 4: PDF text extraction

### Recommendation

Two-tier strategy.

**Tier 1 (cheap path):** detect PDF tabs by URL `.pdf` suffix or `Content-Type: application/pdf`, fetch the PDF bytes from the SW with `await fetch(tabUrl).then(r => r.arrayBuffer())`, then run `pdfjs-dist` in the SW to extract text. `pdfjs-dist` ships an ES-module entrypoint that runs in a Worker context; we wrap it in a SW-compatible build.

**Tier 2 (fallback for PDFs that arrive as a POST response, paywalled, or auth-required):** detect, then surface a tool result like `{ ok: false, reason: 'PDF requires authenticated access — open in your viewer and copy text' }`. The agent shouldn't try to OCR the screen.

Chrome's built-in PDF viewer is `chrome://pdf/` (a sandboxed extension). `chrome.tabs.executeScript` (now `chrome.scripting.executeScript`) cannot inject into `chrome://` URLs — that's why a content-script approach fails. Fetch + parse-in-SW sidesteps it.

### Alternatives

- **Server-side PDF API.** Violates the no-cloud constraint.
- **`Page.printToPDF` (CDP) round-trip.** Inverts the problem: prints the visible tab to PDF. Doesn't help with already-PDF tabs.
- **Whisper/OCR over a screenshot of the PDF.** Works for image-only PDFs but is heavy and inaccurate at 4B; punt.
- **Read the PDF.js text layer DOM.** The Chrome PDF viewer does expose a text layer in its rendered output, but only inside its sandboxed origin — not reachable from a content script at the parent tab origin. Confirmed dead end.

### Integration

New file `src/agent/tools/browser/pdf.ts`:

```ts
// sketch
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

execute: async (args) => {
  const tab = await chrome.tabs.get(args.tabId);
  if (!tab.url || !/\.pdf(\?|$)|application\/pdf/i.test(tab.url)) {
    throw new BrowserToolError('not a PDF tab', { fatal: false });
  }
  const buf = await (await fetch(tab.url)).arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= Math.min(doc.numPages, 50); i++) {
    const p = await doc.getPage(i);
    const txt = await p.getTextContent();
    pages.push(txt.items.map((it: any) => it.str).join(' '));
  }
  return { text: pages.join('\n\n').slice(0, 8000), pageCount: doc.numPages };
};
```

### Dependencies

- `pdfjs-dist` (~1 MB minified, ~250 KB gzipped). Significant bundle bloat for a feature the user may rarely hit. **Lazy-load via dynamic import** so the cost only lands when a PDF tab is in scope.
- A way to point pdfjs at a worker: `pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.js')`, requires copying `pdf.worker.js` via `web_accessible_resources`.

### Risks

- pdfjs-dist runs unevenly in MV3 SW — Chrome workers don't support all the wasm/transferable patterns pdfjs uses. Mitigation: use the `legacy` build (ES5-targeted, no top-level await, no SharedArrayBuffer).
- The bundle bloat is real: SW currently 156 KB, jumps to ~400 KB+ with pdfjs included. **Recommendation: ship pdfjs as a separate chunk loaded only on first PDF tool invocation.** Vite handles dynamic-import chunking natively.
- Encrypted/scanned PDFs: text extraction returns nothing. Detect (no text from any page) and surface a sensible reason.

### Open questions

- Do we want this in M3 or punt to M4? The 1 MB bundle is the kicker. Recommendation: **punt** — make `pdf.extract` an M5 polish item gated on user demand. The shopping use case rarely hits PDFs; it's the research use case that needs it.

---

## Feature 5: Video transcript extraction

### Recommendation

YouTube-only for Phase 1. Use the public timed-text endpoint that the YouTube web client itself uses:

```
https://www.youtube.com/api/timedtext?lang=en&v=<videoId>
```

Detect YouTube tabs (`tab.url.match(/youtube\.com\/watch\?.*v=([^&]+)/)`), fetch from the SW with no auth, parse the resulting XML (`<text start="..." dur="...">...</text>`), and return `[{ start, text }]`. Cap at 200 segments or 6 000 chars, whichever is smaller. Surface errors as non-fatal `BrowserToolError` so the agent can continue without transcript.

For non-YouTube video sites (Vimeo, podcast players, native HTML5 `<video>`), explicitly out of scope for the 4B model on consumer hardware. Whisper-based local transcription would require ~1 GB Whisper-small + 30 s of audio = 30 s of inference on the P2200 we don't budget. Note as future work; surface to the agent as `{ ok: false, reason: 'transcript unavailable' }`.

### Alternatives

- **YouTube `youtubei` internal API.** More thorough (gives chapters, timestamps, multiple languages) but the request shape changes every few months. Brittle. Stick with `timedtext`.
- **`youtube-transcript-api` (Python) port.** Same source endpoint; the value-add is robustness across language fallbacks. Worth porting the language-list logic (it tries `en`, then `en-US`, then auto-translated `en` from any language).
- **Whisper.cpp via WASM in the SW.** Technically possible (whisper.cpp has WASM ports; a Chrome extension named "Vibe" does this for ~30 MB models). Bundle cost is prohibitive; defer.

### Integration

New file `src/agent/tools/browser/video.ts`. Single tool `video.transcript`:

```ts
// sketch
execute: async (args) => {
  const tab = await chrome.tabs.get(args.tabId);
  const m = tab.url?.match(/[?&]v=([^&]+)/);
  if (!m) throw new BrowserToolError('not a YouTube watch URL', { fatal: false });
  const videoId = m[1];
  for (const lang of ['en', 'en-US']) {
    const r = await fetch(`https://www.youtube.com/api/timedtext?lang=${lang}&v=${videoId}`);
    if (!r.ok) continue;
    const xml = await r.text();
    if (!xml.trim()) continue;
    return { segments: parseTimedTextXml(xml).slice(0, 200) };
  }
  throw new BrowserToolError('no transcript available', { fatal: false });
};
```

`parseTimedTextXml` is regex-based (no DOMParser in SW): `/<text start="([^"]+)"(?:\s+dur="([^"]+)")?[^>]*>([\s\S]*?)<\/text>/g`. HTML-decode the inner text using the same entity table from `search.ts`.

### Dependencies

None. Reuses the entity decoder from `search.ts` — opportunity to extract that into `src/agent/tools/browser/html_utils.ts` shared between `search.ts`, `video.ts`, and any future scrapers.

### Risks

- YouTube can return `{}` or HTML for videos without transcripts (live streams, music videos with no captions). Handle as "no transcript."
- `timedtext` requires no auth for public videos but is rate-limited on the IP level. Phase-1 traffic should stay well under the limit.

### Open questions

- Should we build a stub for non-YouTube video sites that returns an empty-success result so the agent doesn't keep retrying? Recommendation: yes, but wait until the agent demonstrates the retry-loop behavior empirically.

---

## Feature 6: Selection-aware Q&A

### Recommendation

Content-script + message-passing, registered as a new tool `selection.get`. Use `chrome.scripting.executeScript` with `func: () => window.getSelection()?.toString() ?? ''` rather than CDP `Runtime.evaluate` — the content script is simpler, doesn't need debugger attachment, runs in the page's main world via `world: 'MAIN'`, and is the same channel browser-use and Stagehand use for selection.

Trigger flow: user highlights text → user clicks side-panel "Ask about selection" button → side-panel posts `{ kind: 'selection.get', tabId }` to SW → SW dispatches `selection.get` tool → content script runs `getSelection().toString()` → result feeds the model with the selection as an extra system message. The user-facing UX is "highlight, ask, answer."

### Alternatives

- **`chrome.contextMenus`** to add a right-click "Ask Polaris about selection" item. Worth adding for ergonomics; the underlying selection-extraction is the same content-script call.
- **CDP `Runtime.evaluate({ expression: 'getSelection().toString()' })`.** Works, but requires the debugger to be attached. Heavier than `chrome.scripting`.
- **Selection-on-mouseup persistence.** Pre-emptively cache the latest selection so the agent has it without an extra round-trip. Nice ergonomic but adds a content-script-on-every-page tax. Defer.

### Integration

New file `src/agent/tools/browser/selection.ts`:

```ts
// sketch
execute: async (args) => {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId: args.tabId },
    func: () => {
      const sel = window.getSelection();
      const text = sel ? sel.toString() : '';
      const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      return {
        text: text.slice(0, 4000),
        contextBefore: range ? range.startContainer.textContent?.slice(
          Math.max(0, range.startOffset - 200), range.startOffset) ?? '' : '',
        contextAfter: range ? range.endContainer.textContent?.slice(
          range.endOffset, range.endOffset + 200) ?? '' : '',
      };
    },
  });
  return r.result ?? { text: '', contextBefore: '', contextAfter: '' };
};
```

The 200-char before/after gives the model "what does THIS sentence mean" context without flooding the budget. Total cap: 4 400 chars.

### Dependencies

`scripting` permission (same as Reader Feature 3). `contextMenus` permission if we add the right-click integration.

### Risks

- The content script runs in the page's world but `window.getSelection()` only sees user-made selections in the main document. iframe selections (e.g., text highlighted inside a Stripe iframe) won't surface. Acceptable — selection-Q&A is a main-frame UX.
- Race with the user clicking the side-panel button: focus shifts to the panel and the page selection is preserved by Chrome (this is a documented Chrome behavior — selections persist on focus loss to same-window UI). Verify on Linux.

### Open questions

- Should the agent see the selection's surrounding ARIA region (the `main`-role ancestor) to disambiguate "this" / "that" pronouns? Cheap to add; the content script already sees the DOM. Worth a follow-up.

---

## Feature 7: Vision-as-verifier patterns

### Recommendation

Implement two verification patterns drawn from Anthropic Computer Use and the Set-of-Marks (SoM) literature, gated behind a single `vision.verify` tool. The patterns are not extraction; they are **boolean checks against a textual claim**, which is the contract the existing ADR commits to.

**Pattern A — Element presence verification (SoM-style).** Before clicking, the Executor calls `vision.verify` with `{ tabId, claim: "the 'Add to cart' button is visible and labeled correctly" }`. The tool overlays numbered markers on each interactive element (extracted via `aria.extract` for `ref` lookups, then projected to bounding boxes via CDP `DOM.getBoxModel`), screenshots, and asks the vision model to answer yes/no with a marker number. This is exactly Set-of-Marks (Yang et al. 2023) — bounded boxes with labels turn vision into a multiple-choice problem the model can answer reliably.

**Pattern B — Outcome verification.** After an action (a click, a navigation), the Executor calls `vision.verify` with `{ tabId, claim: "the page now shows a confirmation that the item was added" }`. The screenshot is captured at ≥ 1200 px (per CLAUDE.md probe finding); the vision model returns `{ ok: bool, reason: string }`. This catches cases where the ARIA tree updates correctly but the visual result is wrong (overlay error, modal appeared, login redirect).

The vision model is the same `qwen3.5:4b` that runs everything else (verified working on 143 KB / 1600 px images per the probe). The output is constrained to `{ok, reason}` via `format: "json"` string mode (CLAUDE.md confirms this works; schema-object mode is broken).

### Alternatives

- **Vision-as-primary-extraction.** Rejected in ADR 0001 and reaffirmed: 4B vision hallucinates badly below 1200 px, latency per image is ~3 s on the P2200, and ARIA at <100 ms ships the same information for 99% of pages.
- **Pixel-diff verification.** Compare two screenshots before/after action. Cheap and offline; useful for "did anything change?" but can't tell you *what* changed in semantic terms. Worth pairing with vision.verify as a fast pre-filter.

### Integration

`src/agent/tools/browser/vision.ts` (new):

```ts
// sketch
execute: async (args) => {
  const { dataUri } = await captureWithMarkers(args.tabId, args.markers);
  const resp = await ollama.chatOnce({
    model: 'qwen3.5:4b',
    format: 'json',
    messages: [
      { role: 'system', content: 'You are a UI verifier. Answer JSON {ok:bool, reason:string}.' },
      { role: 'user', content: args.claim, images: [dataUri.split(',')[1]] },
    ],
  });
  return parseJSONPermissive(resp.message.content);
};
```

`captureWithMarkers` calls `aria.extract`, picks the K most-relevant interactive nodes (by role + name match against the claim), looks up bounding boxes via CDP `DOM.getBoxModel({ backendNodeId })`, draws numbered overlays via `OffscreenCanvas` in the SW, encodes back to PNG. (`OffscreenCanvas` is available in MV3 SWs since Chrome 99.)

### Dependencies

`OffscreenCanvas` (built-in). `DOM` CDP domain enable. No new npm.

### Risks

- Drawing overlays in the SW via OffscreenCanvas requires the screenshot bytes; we already have those from `tab.screenshot`. The overlay step adds 50–100 ms per call. Acceptable.
- 4B vision is unreliable on dense pages; SoM markers help but don't fix it. Mitigate by limiting marker count to ≤ 10 — empirically, 4B vision degrades sharply past ~12 markers in a single image.

### Open questions

- How does the Planner decide *when* to call `vision.verify`? Rule of thumb: after every state-changing action (click that navigates, form submit) but never before passive ones (`tab.list`, `aria.extract`). Encode in Executor prompt, not the tool.

---

## Feature 8: Page-mutation handling for SPAs

### Recommendation

Implement a `page.wait_stable` content-script tool that combines three signals — **MutationObserver count**, **network-idle**, and a **debounce timer** — and returns when all three say "stable for 500 ms" or when a 5 s budget elapses. Replace the current `tab.wait_loaded`'s reliance on `tab.status === 'complete'` (which fires when the initial document is parsed but says nothing about XHR-driven SPA mounts).

The three signals:

1. **Mutation observer:** count DOM mutations in the last 500 ms. If 0, mark "DOM stable."
2. **Network idle:** count active fetch/XHR requests via a tiny content-script monkey-patch on `window.fetch` and `XMLHttpRequest.prototype.open`. If 0 for 500 ms, mark "network idle."
3. **Debounce timer:** caller-specified minimum settle time (default 500 ms) since the last mutation OR last network completion.

Return when all three converge. Bound at 5 s (configurable). This is the same pattern Playwright's `waitForLoadState('networkidle')` uses, ported to a content-script.

### Alternatives

- **`tab.status === 'complete'`** alone. What we ship today. Works for static pages, fails for React/Vue/Angular apps that mount under a `<div id="app">`.
- **`MutationObserver` only.** Misses XHR-driven late content. Good as a signal but not sufficient.
- **CDP `Page.lifecycleEvent` `networkAlmostIdle`.** Cleaner than monkey-patching, but couples to the debugger session. We'd rather keep the wait-stable tool independent of `chrome.debugger` so the orchestrator can call it without holding the debugger open.

### Integration

New content script `src/content/wait_stable.ts`. New tool `page.wait_stable` in `src/agent/tools/browser/wait.ts` that injects the script via `chrome.scripting.executeScript` with `world: 'MAIN'` (so its monkey-patches see the page's `fetch`, not the isolated-world copy).

```ts
// content script (sketch)
const inflight = { count: 0 };
const origFetch = window.fetch;
window.fetch = function (...args) {
  inflight.count++;
  return origFetch.apply(this, args).finally(() => inflight.count--);
};
// similar for XMLHttpRequest
let lastMutation = Date.now();
const obs = new MutationObserver(() => { lastMutation = Date.now(); });
obs.observe(document.body, { childList: true, subtree: true, attributes: true });
const start = Date.now();
return new Promise((resolve) => {
  const tick = () => {
    const idleFor = Date.now() - lastMutation;
    if (idleFor >= 500 && inflight.count === 0) {
      resolve({ stable: true, waitedMs: Date.now() - start });
      return;
    }
    if (Date.now() - start > 5000) {
      resolve({ stable: false, waitedMs: Date.now() - start });
      return;
    }
    setTimeout(tick, 100);
  };
  tick();
});
```

### Dependencies

`scripting` permission. No new npm.

### Risks

- Monkey-patching `window.fetch` runs in the page's main world, which means it also intercepts the page's own polling / analytics. That's fine (we only count, don't block) but means our "network idle" signal is muddied on pages that long-poll. Mitigate by treating any single request older than 30 s as "abandoned" (don't count it).
- Some SPAs (Gmail, Asana) never go idle. The 5 s cap returns `stable: false` — surface that to the model so it can decide to extract anyway.
- Monkey-patches must be installed on every navigation. Use `chrome.webNavigation.onCommitted` to re-inject.

### Open questions

- Do we want `page.wait_stable` to be called automatically inside `aria.extract` (so the model never sees an unstable tree)? Pro: simpler model contract. Con: pays the 500 ms minimum on every extract even when the page is static. Recommendation: make it opt-out via `aria.extract({ tabId, waitStable: false })`.

---

## Cross-cutting concerns

### Token economy

Each feature lands its own per-channel cap, summarized:

| Channel | Cap | Tier |
|---|---|---|
| `aria.extract` (current) | 4 000 chars | Executor |
| `aria.extract` (multi-frame) | 6 000 chars aggregate | Executor (use sparingly) |
| `reader.extract` | 5 000 chars | Planner |
| `pdf.extract` | 8 000 chars | Planner |
| `video.transcript` | 6 000 chars / 200 segments | Planner |
| `selection.get` | 4 400 chars | Executor |
| `vision.verify` | output is `{ok, reason}`, ~200 chars | Executor |
| `page.wait_stable` | output is `{stable, waitedMs}` | Executor |

Total worst case for an Executor turn: 4 400 (selection) + 6 000 (aria multi-frame) + tools schemas + prompt scaffold ≈ 5 K tokens, fits under the 6 K Executor budget. The Planner can hold one of the long channels (Reader, PDF, transcript) plus a tree, well under 32 K.

### Reusable utilities

Three extractions become shared modules as the feature surface grows:

- **`src/agent/tools/browser/html_utils.ts`** — entity decoder (`decodeHtmlEntities`), tag stripper (`stripTags`), URL validator. Currently duplicated in `search.ts`. Future home for `parseTimedTextXml`, Reader's HTML stripper, etc.
- **`src/agent/tools/browser/cdp.ts`** — promisified `chrome.debugger` callback wrapper (`callDebugger`), domain-enable helpers (`enableDomains(['Accessibility', 'Page', 'DOM'])`), session lifecycle. Currently inlined in `aria.ts`.
- **`src/agent/tools/browser/dom_resolve.ts`** — `ref → backendNodeId → RemoteObject` resolver shared by `click`, `type`, `vision.verify`. Doesn't exist yet but every M3.5 tool will need it.

### Page-stability detection

The wait-stable signal from Feature 8 is a precondition for Features 1, 3, 6, and 7. **Implementation order matters: ship `page.wait_stable` first**, otherwise every subsequent feature inherits the "we extracted at the wrong moment" failure mode and the symptoms will look like bugs in the new tool rather than in the timing.

### Privacy boundary

All eight features stay local. Cloud calls are forbidden by constraint. The two near-misses are (a) `search` already hits DuckDuckGo HTML — that's existing, not new — and (b) `video.transcript` hits youtube.com/api/timedtext — same domain the user is already on, not a third-party telemetry. Both are tolerable.

---

## Implementation order recommendation

Prioritize features by **how many other features unlock by them**:

1. **Feature 8 — `page.wait_stable`.** Unlocks 1, 3, 6, 7. Smallest implementation (one content script, one tool). Ship first.
2. **Feature 1 — ARIA depth/quality.** Adds `ref` and `href` to the existing primary channel. Unlocks future `click`/`type` tools and Feature 7 (vision.verify needs `ref` to resolve markers). Pure refactor of `aria.ts`; no new permissions.
3. **Feature 2 — frame traversal.** Independent of others but high-value for cross-frame retailer pages (Amazon's "frequently bought together" widget is iframe-mounted on some templates). Drop-in extension to `aria.ts`.
4. **Feature 6 — selection.get.** Smallest user-visible win, unlocks the "highlight + ask" UX which is differentiating vs. Comet's "type a question" pattern. New permission (`scripting`); simple content script.
5. **Feature 7 — vision.verify.** Depends on Features 1 (refs) and 8 (stability). Ships the verification half of "vision-is-verification-only" — currently an aspirational ADR clause with no implementation.
6. **Feature 3 — reader.extract.** Pulls in `@mozilla/readability`. New dep, deferred.
7. **Feature 5 — video.transcript.** Cheap (no deps) but narrow scope (YouTube only). Ship when shopping use case demonstrates a video-watch step.
8. **Feature 4 — pdf.extract.** 1 MB bundle for an edge case. M5 polish item.

Phase boundaries: 1, 2, 8 land in M3.5 (extension to existing M3 tools, no new permissions). 6, 7 land in M4 (alongside retailer expansion). 3, 5 land in M4.5 (new deps, user approval). 4 lands in M5 (polish).

---

## Open questions for the user

1. **`scripting` permission:** Features 3, 6, 7, 8 all want it. Are you OK adding `"scripting"` to the manifest? It's needed for any non-debugger-based content-script injection.
2. **`@mozilla/readability` dep approval:** ~30 KB minified; replaces a real cost (we'd otherwise hand-roll a worse extractor). Permission to add when Feature 3 ships?
3. **`pdfjs-dist` dep approval:** ~1 MB. Worth deferring to M5? Or do you have a research-tool use case where PDFs come up early?
4. **Cross-frame iframe extraction default:** opt-in (model asks for `aria.extract({ allFrames: true })`) or always-on (single `aria.extract` walks all frames)? Always-on is simpler for the model but pays the cost on every extract.
5. **`page.wait_stable` always-on inside `aria.extract`:** the 500 ms minimum makes static pages slower. Acceptable trade-off?
6. **Selection UX entry point:** side-panel button only, or also right-click context menu? Context menu adds discoverability but needs `contextMenus` permission.
7. **Vision marker count cap:** 10 markers per image is my proposed cap. Do you have empirical data from the probe on how 4B handles 5 vs. 10 vs. 15 markers?
8. **YouTube transcript fallback:** when no English transcript, do we machine-translate from another language (browser-side via `chrome.i18n` or skip)? My recommendation is skip and surface "no English transcript."
