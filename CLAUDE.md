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
- **M3 — real browser tools (ARIA tree, tab manager, screenshot vision)** ← next
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
6. **Single model.** qwen3.5:4b for all three roles. The 35B-MoE doesn't
   fit on the user's 5 GB GPU and runs on CPU only — not viable for
   interactive use.
7. **Ollama URL is configurable.** Default `http://localhost:11434`, but
   the user may host inference on a Linux box and run the browser on Mac.
   Never hard-code `localhost`.
8. **Apache 2.0** license. Don't add headers per file — repo-root LICENSE
   suffices.

---

## Current state — UPDATE THIS WHEN YOU FINISH WORK

**Last touched:** 2026-05-24 (Mac, Claude Opus 4.7)
**Last shipped:** M2.7.1 — Vitest backend validation suite (73 tests passing)
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
- `docs/research-notes.md` — literature survey
- `ISSUES.md` — original M1 CORS issues, all resolved

### What's next (M3 work list)

- [ ] **User: smoke-test M2 in Chrome end-to-end** with the canonical task (`store the numbers 17, 25, and 8 in memory namespace 'nums' under keys a b c, read them back, finish with their sum`) — should now show step transitions in the plan tree, ≥1 compaction event mid-run, and a correct sum
- [ ] **ARIA-tree extractor** via `chrome.debugger` — replaces raw HTML for the model
- [ ] **Tab manager** (open / extract / close / screenshot) — service worker controls real tabs
- [ ] **Screenshot vision tool** — calls `qwen3.5:4b` vision with a captured page region; verifier pattern
- [ ] **Retailer adapters:** Amazon, Walmart, Best Buy, Target — page-specific extractors returning structured product JSON
- [ ] **Search tool** — DuckDuckGo HTML scrape or Google Shopping fallback

### Open questions / blockers

- None blocking M3. The agent loop is provably correct on its core invariants (goal survival, replan cap, step advance) via the test suite. M3 work proceeds against a stable foundation.

### Acknowledged debt (Tier C from the arch-nemesis pass)

- Watchdog `setInterval` lastTouch bumper still not added (5-min threshold tolerates this for now).
- Breaker progress signal still uses findings-growth — should be replaced with distinct-action-count over a window.
- Tokenizer accuracy is `chars/4` heuristic; documented as advisory.
- Resume event replay sends N events as N postMessages (should batch).

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
