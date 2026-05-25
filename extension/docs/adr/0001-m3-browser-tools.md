# ADR 0001 — M3 Browser Tools

- **Status:** Proposed (becomes Accepted when M3 ships)
- **Date:** 2026-05-24

## Context

The agent currently runs against mock tools only — `echo`, `add`, `sum`, `delay`, `next_step`, `finish`, and the `memory.*` family — exercised through 116 mock tests plus 2 fast-tier integration tests against a real Ollama on the Linux box. M3 wires real browser capabilities: open a tab, extract a page, search the web, and screenshot for vision verification. The architectural tension: Chrome's `chrome.debugger` API is the only path that gives us the accessibility tree, but it is session-scoped, requires explicit `attach`/`detach`, and a stale session blocks subsequent attempts on the same tab. The model also needs simplified inputs — raw HTML blows the 6 K Executor budget on the first product listing — and the failure modes are richer than mock tools: tab crash, navigation hung past the watchdog, permission denied (extension unpinned on the active page), debugger session conflict (DevTools open), retailer 4xx/5xx. The decisions below shape how the Executor and the tool layer cope with those modes without leaking complexity into role prompts.

## Decisions

1. **Tool error categorization.** Browser tools throw `BrowserToolError(msg, { fatal: bool })`. Recoverable errors (transient network, brief navigation timeout, transient debugger conflict) surface to the model as a tool result so it can retry with different args; fatal errors (permission denied, tab crashed, malformed URL) abort the task via the existing breaker path. Already implemented at `src/agent/tools/browser/lifecycle.ts`.
2. **ARIA tree as primary extraction channel.** Per the vision-is-verification-only convention, page extraction prefers `Accessibility.getFullAXTree` over the debugger DOM domain. The raw tree is simplified (drop ignored nodes, collapse whitespace, retain role/name/value/href) and token-capped at 4 000 chars before serialization. Raw HTML is never passed to the model.
3. **Tab ownership.** Tabs the agent opens are tracked per-task in an in-memory `Set<tabId>` keyed by `taskId`. On task `ABORTED` or `DONE`, all owned tabs are closed and any active debugger session detached. The user's pre-existing tabs are never touched.
4. **Adapter precedence.** Retailer-specific adapters (Amazon, Walmart, Best Buy, Target — landing in M4) take precedence over the generic ARIA extractor on known domains. Adapters return a structured `ProductRecord` directly, bypassing the simplified-tree layer; on adapter throw, the tool falls back to ARIA so a stale adapter doesn't block the task.
5. **Vision is verification-only.** The vision tool takes a screenshot path *and* a textual claim; it answers `{ ok: bool, reason: string }`. It does not extract structured data. This matches the probe finding that <50 KB images hallucinate, and it keeps vision off the hot extraction path.
6. **Tool registration is centralized.** All browser tools register through `createDefaultRegistry()` in `src/agent/tools/index.ts`. There are no per-task registries. The Executor sees one consistent tool list per session; capability gating happens via permission checks inside the tool, not via registry surgery.
7. **No new persistent state for M3 tools.** Owned-tab IDs and live debugger handles live in the orchestrator instance only. On service-worker restart they are abandoned; the `resume()` path detaches stale debugger sessions defensively (`chrome.debugger.detach` on every tab in the previous session, ignoring "not attached" errors) before any new tool runs.

## Alternatives considered

- **Raw HTML to the model.** Rejected — token cost (10×–50× ARIA), and brittleness to layout churn.
- **`chrome.scripting.executeScript` instead of `chrome.debugger`.** Rejected — limited DOM access, no AX tree, and no protocol-level control over navigation events.
- **Vision-as-primary-extraction.** Rejected — probe data shows hallucinations on <50 KB images, and even at 1600 px the latency is ~3 s per page versus <100 ms for an ARIA dump.
- **Per-domain Playwright-style page object models.** Rejected — too heavy for M3. Adapters stay minimal: a function from URL to `ProductRecord`, with a fallback to ARIA.

## Open questions

- **CAPTCHA on retailer pages.** Probably skip and tell the user. Detection heuristic and surface text are TBD.
- **Detach-on-disconnect.** If the side panel disconnects mid-extract, do we orphan the debugger session? Current design says the orchestrator owns the session and panel disconnect is irrelevant, but this needs a real test.
- **Adapter staleness.** Retailer markup changes silently. Telemetry on extraction failures (drop in `ProductRecord` field count vs. baseline) is the proposed signal, but we have no baseline yet.
- **Search rate-limiting.** DuckDuckGo HTML scraping is the M3 default; expect 429 under load. Backoff strategy and a Google Shopping fallback are open.
- **Multiple tabs in flight.** Phase 1 design assumes one active tab per task; concurrent retailer queries are out of scope until M4 measures the latency impact.
