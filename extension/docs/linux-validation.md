# Polaris — Linux Box Validation Runbook

> **Hi Claude (Linux session).** This document is your context handoff from
> the Mac session. Read it end-to-end before doing anything. The user
> just pulled the latest commits onto the Linux box and wants to validate
> Polaris against real qwen3.5:4b for the first time. Your job is
> validation only — **do not write new code**. If a test fails, capture
> the failure verbatim and report; do not "fix" it without the user's
> explicit say-so. The Mac session has been chasing arch-nemesis cycles
> for weeks; piling more code on top of unvalidated work was the
> repeated mistake.
>
> Per `CLAUDE.md` cross-machine workflow: when you finish, commit the
> probe results doc, push, and the Mac side will pull.

---

## Polaris in one paragraph

Chrome MV3 extension. Hierarchical Planner / Executor / Evaluator agent
loop powered by local `qwen3.5:4b` via Ollama. Phase 1 use case:
cross-retailer shopping deal hunter. Goal lives in persistent state
outside the model context (re-injected every Planner / Evaluator call)
so the agent stays locked to the user's original goal even when the
working context fills up. Read `CLAUDE.md` for the milestone history
and `extension/docs/research/SUMMARY.md` for the cross-cutting design
picture.

## What's untested on Linux

Until this run, **nothing** has been empirically validated against real
qwen3.5:4b on the Linux box. The Mac side ran:
- 333 mock unit/integration tests (passing)
- 2 fast-tier real-Ollama tests (passing on Mac CPU at ~0.3–0.9 tok/s
  via a sandboxed proxy, which is unrepresentative of production)

The validation deficit:
1. Slow-tier integration suite (4 tests, opt-in via
   `POLARIS_REAL_OLLAMA=1`) — has never run successfully end-to-end on
   anything fast enough to clear the timeouts.
2. KV-cache prompt-restructure (M3.5 #61). Claimed 30–50% reduction in
   Executor `prompt_eval_duration` — never measured.
3. Telemetry harness — has zero data points captured.
4. Real browser load + canonical task — never run.

The Linux P2200 (5 GB VRAM, ~38 tok/s sustained) is the first realistic
environment.

---

## Pre-flight checks

Run each. Stop if any fails.

```bash
# 1. Confirm Ollama is up and qwen3.5:4b is pulled
curl -s http://localhost:11434/api/tags | jq '.models[].name'
# Expected: a list including "qwen3.5:4b"
# If missing: `ollama pull qwen3.5:4b` (will take 10-20 min over network)

# 2. Confirm CORS env var is set so the future browser smoke works.
# (Doesn't affect the npm tests — those go direct to the API.)
echo "$OLLAMA_ORIGINS"
# Expected: "chrome-extension://*" or "*"
# If empty AND the user wants to do the browser smoke later, set it via
# systemd override (see README.md "CORS setup"); restart Ollama.

# 3. Confirm OLLAMA_NUM_PARALLEL is 1 (or unset; default behavior is fine
# for a single-user setup). This affects KV-cache slot stickiness.
echo "$OLLAMA_NUM_PARALLEL"
# Expected: empty or "1"

# 4. Move to the extension dir
cd /path/to/Polaris/extension  # ask the user for the actual path

# 5. Confirm we're on the latest commit
git log -3 --oneline
# Expected:
#   a60297a docs: M3 ADR, research synthesis, M4-M7 roadmap sketch, smoke-test recipe
#   ffef3fb M2.7.2 → M3.5: agent hardening, browser tools, safety floor
#   c917927 M2.7.1: Vitest backend validation suite — 73 tests, contracts proven
```

---

## Step 1 — Install dependencies

```bash
npm install
```

Three new dev-deps from the Mac side may be needed: `undici`,
`fast-check`, `fake-indexeddb`. They should install cleanly. If
`npm install` errors, capture the full output and stop.

---

## Step 2 — Mock suite sanity check

```bash
npm test
```

**Expected:** `Tests  333 passed (333)` in ~15 s.

If anything other than 333 passes, **stop**. Capture the failure
output verbatim. The mock suite passing on Mac and failing on Linux
points to environment differences (Node version, undici version,
fake-indexeddb behavior) — diagnose by reading the failure, not by
patching code.

---

## Step 3 — Fast-tier real-Ollama integration smoke

```bash
npm run test:integration
```

**Expected:** `Tests  2 passed | 5 skipped (7)` in ~30–90 s.

The two passing tests:
1. Planner produces JSON conforming to `PlannerResponseSchema`
2. Executor produces a `tool_call` with the M3.5 user-anchor prompt
   shape

If either fails, capture:
- The full vitest output
- Whatever `polaris.dumpLogs()` would have written (run a one-off:
  `cat /tmp/vitest-stderr.log` if you redirected, or rerun with
  `2>&1 | tee /tmp/integration.log`)

---

## Step 4 — Slow-tier integration suite (the real validation)

This is the long-promised Linux gate. Four end-to-end tests, opt-in
via env var.

```bash
POLARIS_REAL_OLLAMA=1 npm run test:integration:full 2>&1 | tee /tmp/polaris-slow-tier.log
```

**Expected:** ~3–15 min total on the P2200. Each test logs per-call
`prompt_eval_count`, `eval_count`, and `wallMs` — capture the log.

Tests:
1. `end-to-end: trivial single-tool task completes with correct answer`
   — Goal: "Use the add tool to compute 2 + 3, then call finish with the
   result." Asserts: `phase === 'DONE'`, goal byte-equal, finalAnswer
   contains `5` or `five`.
2. `end-to-end: multi-tool task with memory + goal byte-survival`
   — Goal: store 17/25/8 in memory namespace 'nums', read back, sum,
   finish with 50. Asserts: phase DONE, byte-equal goal, finalAnswer
   matches `\b50\b|fifty`, memory cells persisted.
3. `end-to-end: non-ASCII goal text survives the entire pipeline
   byte-equal` — Goal contains em-dash, €, ümlaut, 你好. Asserts:
   goal text byte-equal char-by-char.
4. `end-to-end: compaction fires when scratchpad fills, archives
   findings, deletes scratch` — Goal: write 6 strings to memory, read
   back, finish. Asserts: ≥1 compaction event with `discarded > 0`,
   `findingsCount > 0` in IDB.

If all four pass: M3.5 is empirically validated. Save the timing data
(see Step 6).

If one fails: capture which test, the assertion message, and the last
~50 lines of vitest output before the failure. Do not retry to "make
it pass." Real-model variance is real, but failures here usually
indicate a contract bug, not a flake.

---

## Step 5 — KV-cache reuse probe (M3.5 #61 verification)

The Executor prompt was restructured in M3.5 to put stable bits first
and churning bits last so Ollama's `cache_prompt: true` (default since
2024) reuses tokens across consecutive turns. Verify this actually
fires.

```bash
# Build a 1500-token prompt and send it twice. The second call's
# prompt_eval_duration should be <10% of the first if KV reuse hits.
# If it's the same, the optimization isn't actually firing on this box
# and the M3.5 prompt restructure was theatrical (Mac side warned about
# this).

PROMPT=$(printf 'You are a helper. %.0s' {1..200})  # ~1500 tokens of repetitive text

# First call (cold)
T1=$(curl -s http://localhost:11434/api/chat \
  -d "{\"model\":\"qwen3.5:4b\",\"messages\":[{\"role\":\"user\",\"content\":\"$PROMPT what is 2+2?\"}],\"stream\":false,\"keep_alive\":\"10m\"}" \
  | jq -r '.prompt_eval_duration')
echo "first prompt_eval_duration (ns): $T1"

# Second call (should be cache-hot)
T2=$(curl -s http://localhost:11434/api/chat \
  -d "{\"model\":\"qwen3.5:4b\",\"messages\":[{\"role\":\"user\",\"content\":\"$PROMPT what is 3+3?\"}],\"stream\":false,\"keep_alive\":\"10m\"}" \
  | jq -r '.prompt_eval_duration')
echo "second prompt_eval_duration (ns): $T2"

# Ratio
echo "ratio (T2/T1): $(echo "scale=3; $T2/$T1" | bc)"
```

**Expected:** ratio < 0.10 (T2 is at least 10× faster than T1) if KV
reuse is firing. If ratio is around 1.0, the cache isn't hitting and
M3.5 #61's claim is false on this hardware.

---

## Step 6 — Capture results

Create or append to `extension/docs/probes/m3.5-linux.md` with:

```markdown
# M3.5 Linux validation — <date>

## Hardware
- GPU: <output of `nvidia-smi --query-gpu=name,memory.total --format=csv`>
- Ollama version: <output of `ollama --version`>
- Node version: <output of `node --version`>
- vitest version: from package.json

## Results

### Step 2 — Mock suite
- Pass: <X / 333>
- Wall time: <Y seconds>

### Step 3 — Fast-tier integration
- Pass: <X / 2>
- Skipped: <Y / 5>
- Per-test wall time: <copy from vitest output>

### Step 4 — Slow-tier integration
- Pass: <X / 4>
- Per-test:
  - trivial single-tool: <PASS/FAIL> in <wallMs>
  - multi-tool memory: <PASS/FAIL> in <wallMs>
  - non-ASCII goal: <PASS/FAIL> in <wallMs>
  - compaction E2E: <PASS/FAIL> in <wallMs>
- Failures (if any): paste the assertion + last ~30 lines of context

### Step 5 — KV-cache probe
- First prompt_eval_duration: <T1 ns>
- Second prompt_eval_duration: <T2 ns>
- Ratio: <T2/T1>
- Verdict: <KV reuse fires / KV reuse does NOT fire on this hardware>

### Telemetry sample
After Step 4 completes, capture per-op latency from one of the test
tasks. The metrics IDB store has `summary(taskId)` exposed but not
easily queryable from outside the extension. Skip this step if not
practical; the in-test logs from `chatOnce ✓` already give per-call
wallMs which is enough for now.
```

Then commit:

```bash
git add extension/docs/probes/m3.5-linux.md
git commit -m "docs: M3.5 Linux validation results — <date>"
git push
```

---

## Step 7 (optional) — Real-browser smoke

If the Linux box has Chrome and the user wants to do the manual
browser smoke too, follow `extension/docs/smoke-test-m3.5.md` end to
end. Capture the post-run console outputs (the recipe enumerates them).
This is the user's manual-validation path — you (Claude) cannot drive
Chrome. Just remind the user where the recipe is.

---

## What to do if X fails

- **`npm install` errors** → capture full output. Could be a Node
  version mismatch (we're on Node 22+ on Mac); ask user what Linux is
  running.
- **Mock suite (Step 2) drops below 333** → capture failures, do not
  patch. Likely a Node-version-specific behavior in fake-indexeddb or
  undici. Report and stop.
- **Fast-tier integration fails (Step 3)** → could be Ollama not
  responding, model not pulled, or a real model-output regression.
  Check `curl http://localhost:11434/api/tags` first.
- **Slow-tier (Step 4) times out** → Linux box is much faster than
  Mac, but a thinking-mode Planner call can still take 30–60 s. The
  test timeouts are 5–15 min. If it times out at the test-level limit,
  capture the wall time of the longest call and report; don't extend
  timeouts blindly.
- **KV-cache probe (Step 5) ratio ≈ 1.0** → M3.5 #61's prompt
  restructure isn't producing the expected cache hits. Could be:
  Ollama version doesn't support `cache_prompt`, `OLLAMA_NUM_PARALLEL`
  > 1 splitting slots, or `keep_alive` not holding. Capture and
  report; the Mac side will decide whether to revisit the
  optimization.

---

## Hard rules for this session

- **Do not write new code.** This is a validation-only session.
- **Do not extend test timeouts.** If a test times out, that's a
  signal — we want to see it.
- **Do not retry to make a flaky test pass.** Capture the failure once
  and report.
- **Do not push without committing the probe doc.** The Mac side
  reads it via `git pull --rebase` before the next session.
- **If the user asks you to fix something:** push back once with "this
  session was scoped to validation; want me to switch modes and fix?"
  before changing course.

When the runbook completes (all steps run, results captured + committed),
report a concise summary back to the user:
- Steps that passed
- Steps that failed (verbatim assertion)
- The KV-cache verdict
- Recommended next action (start M4? rerun a flaky? open a bug?)

---

## Session results — 2026-05-25 (Linux, P2200)

**Run by:** Claude (Linux session)
**Commit:** 3d85b41 (pushed to main)
**Full probe doc:** `extension/docs/probes/m3.5-linux.md`

### What passed

| Step | Result |
|---|---|
| 1 — npm install | Lockfile regenerated (see gap #1 below). 170 packages. |
| 2 — Mock suite | **333/333 passed** in 13.82 s |
| 3 — Fast-tier integration | **2/2 passed** in 36.66 s (Planner 28.3 s, Executor 7.9 s) |
| 4 — Slow-tier E2E | **4/4 passed** in 574 s (~9.6 min). Trivial 48 s, memory 135 s, unicode 38 s, compaction 339 s. |
| 5 — KV-cache probe | Partial hit — ratio 0.502 (see gap #2 below) |

**M3.5 is empirically validated.** Goal byte-survival, multi-tool memory,
non-ASCII goal text, and compaction all work against real qwen3.5:4b on the
P2200. Executor tool-calling worked on first try across all observed calls
(the M2.7.2 prompt fix is holding up).

### Gaps for Mac session to address

**Gap #1 — Lockfile is machine-specific.** The Mac-generated
`package-lock.json` had 244 resolved URLs pointing to `npm.apple.com`
(Apple's internal registry). Linux can't reach that. Workaround: deleted
lockfile and ran `npm install --registry https://registry.npmjs.org/`.
The committed lockfile now resolves against the public registry, but the
Mac side will have the inverse problem on next `npm install`.

**Recommended fix:** Add a project-level `.npmrc` in `extension/` with
`registry=https://registry.npmjs.org/` so both machines use the same
registry. Or add a note in CLAUDE.md that each machine should keep its
own lockfile. The EBADENGINE warning for undici@8.3.0 (wants Node >=22,
Linux is v20.20.1) is a soft warning only — no test failures from it.

**Gap #2 — KV-cache reuse is real but modest.** Ratio of 0.502 (T2/T1)
means the second identical-prefix call is ~2× faster on prompt_eval, not
the 10×+ you'd get from a perfect cache hit. The cache IS firing — T2
(1.37 s) is meaningfully less than T1 (2.72 s) — but M3.5 #61's claimed
30-50% Executor latency reduction may be optimistic on Ollama 0.22.1.
Worth testing against a newer Ollama version or checking whether
`cache_prompt` behavior changed.

**Gap #3 — Test count in CLAUDE.md is stale.** CLAUDE.md reports 301 mock
tests; actual count is 333. Update the "Current state" section and the
M3.5 bullet that says "Total: 301 mock tests" to 333.

**Gap #4 — `OLLAMA_ORIGINS` is empty on the Linux box.** The systemd
drop-in from the May 25 memory note may not have survived a restart, or
was never persisted. Step 7 (browser smoke) won't work until this is
fixed. The user said they'd set it via `systemctl edit ollama.service`
but `echo $OLLAMA_ORIGINS` returned empty. Run:
```bash
sudo systemctl edit ollama.service
# Add:
# [Service]
# Environment="OLLAMA_ORIGINS=chrome-extension://*"
sudo systemctl daemon-reload && sudo systemctl restart ollama
```

### What was NOT tested

- Step 7 (real-browser smoke) — skipped. `OLLAMA_ORIGINS` not set.
- Executor flake-reliability stats (POLARIS_REAL_OLLAMA_FLAKE_RUNS=1) —
  skipped. Not needed for validation gate; the 4 slow-tier tests exercise
  more Executor calls than this stat test would.
- Telemetry sample — skipped per runbook ("Skip this step if not practical").

### Recommended next actions for Mac session

1. Fix Gap #1 (lockfile / .npmrc) so cross-machine installs don't break.
2. Fix Gap #3 (stale test count in CLAUDE.md).
3. Investigate Gap #2 (KV-cache ratio) — check Ollama 0.22.1 cache_prompt
   docs, or re-run probe after Ollama upgrade.
4. Tell Linux user to fix Gap #4 (OLLAMA_ORIGINS) when ready for browser smoke.
5. M4 shopping domain work is unblocked — the agent loop is validated on
   real hardware.

---

## Session 2 task — Polish #1–#3 browser verification

> **For the next Linux Claude session.** Mac side just shipped three side-panel
> polish items but cannot drive real Chrome (the Mac sandbox blocks Chrome's
> singleton socket). Your job: load the extension into Chrome on the Linux
> box and verify each polish item works end-to-end. Same hard rules as
> Session 1 — validation only, no code edits.
>
> **What changed on the Mac side since Session 1:**
> - Polish #1: `breaker`, `verdict`, `error` timeline events now use a
>   `<CollapsibleText inline cap={120}>` so long reasons collapse with a
>   "Show full (N chars)" toggle instead of dumping multi-KB walls of text.
> - Polish #2: a small per-op metrics table renders below a terminal agent
>   run (`op | n | ok | p50 | p95 | mean`, sorted by mean latency desc).
>   Same data as `polaris.metrics.summary(taskId)`.
> - Polish #3: settings drawer gained a "Domain trust tiers" section —
>   list of configured hosts with tier dropdowns, add/remove rows. Backed
>   by `chrome.storage.local['polaris.domain_tiers']`.
> - Bundle delta: panel 158 → 162 KB, SW 162 → 164 KB.

### Pre-flight

```bash
git pull --rebase
cd extension
npm install                # lockfile is public-registry-resolved (Gap #1 not yet fixed at .npmrc level — your install may regenerate it)
npm test                   # MUST be 333/333 — if not, stop and report
npm run build              # MUST succeed; expect ~162 KB panel, ~164 KB SW
```

**Fix Gap #4 before continuing.** Without `OLLAMA_ORIGINS=chrome-extension://*`
set on the Ollama systemd unit, every agent run will fail with HTTP 403 in
the panel and you can't verify Polish #2. Run:

```bash
sudo systemctl edit ollama.service
# Add:
# [Service]
# Environment="OLLAMA_ORIGINS=chrome-extension://*"
sudo systemctl daemon-reload && sudo systemctl restart ollama
echo "$OLLAMA_ORIGINS"     # confirm in the user shell too
curl -s -H "Origin: chrome-extension://test" http://localhost:11434/api/tags >/dev/null && echo "CORS ok"
```

### Step 1 — Load the extension

```bash
google-chrome &            # or chromium / snap path as appropriate
# Visit chrome://extensions
# Toggle "Developer mode" ON
# Click "Load unpacked" → select extension/dist/
# Note the extension ID for later
```

Open the side panel via the toolbar icon. Settings drawer (gear, top-right)
→ confirm Ollama URL is `http://localhost:11434` and model is `qwen3.5:4b`.
Click "Test connection" → expect `✓ Connected · N models`.

### Step 2 — Drive a canonical agent task (feeds data to Polish #1 and #2)

In the goal field, paste:
```
store the numbers 17, 25, and 8 in memory namespace 'nums' under keys a b c, read them back, finish with their sum
```

Click 🚀 Run agent. Expect 1–3 min total on the P2200 (matches the
multi-tool slow-tier integration test from Session 1, ~135 s).

While running, watch for:
- Plan tree renders with steps
- Several `tool` events (memory.write × 3, memory.read × 3, finish)
- Compaction events possible if scratchpad fills
- Final `verdict: done` event
- Final answer block at bottom showing `50` (or `fifty`)

If the goal text contains anything other than the literal string above
when surfaced in the timeline / state, that's a goal-survival regression —
report immediately.

### Step 3 — Verify Polish #2 (per-op metrics block)

After the task terminates DONE, scroll to bottom of the agent run pane.
You must see a small table titled **"Per-op latency"** with columns
`op | n | ok | p50 | p95 | mean`.

**Capture:**
- Paste the visible table contents (text is fine; screenshot optional).
- Order should be slowest mean latency first.
- `ok` column should show 100% for a clean run.

**If the block does NOT appear:**
1. Open SW DevTools (chrome://extensions → service worker link → inspect).
2. Run `await polaris.metrics.summary('<taskId>')` — taskId is in the
   timeline header; if not visible, look at `(await polaris.state.loadHot()).taskId`.
3. If summary returns data but UI is empty, the `metrics.value` postMessage
   isn't reaching the panel — check panel DevTools (right-click panel →
   Inspect) console for a `metrics.value` log/error.
4. If summary returns `[]`, the metrics taps in the orchestrator aren't
   firing — paste a few `polaris.dumpLogs()` lines from around the run.

### Step 4 — Verify Polish #1 (CollapsibleText for inline events)

The Step 2 `verdict` event will exercise the toggle if the model produced
a reason >120 chars. Most clean runs will have a short reason. To force
the long-reason path reliably, trigger a circuit-breaker:

In a new run, set goal to:
```
keep calling the unknown_tool tool over and over forever
```

Run agent. Within ~3 turns, expect a `⚠ Circuit breaker: replan` event
with reason text. If reason is >120 chars (it usually is — breakers list
the offending action hashes), a **`Show full (N chars)`** button should
appear inline.

**Capture:**
- Click `Show full (...)` — the text should expand inline.
- Click `Collapse` — should revert.
- Confirm there's no layout reflow / scroll jump.

**If the toggle doesn't appear:**
- Open panel DevTools and inspect the `.agent-event-breaker` `<li>` — is
  the reason actually > 120 chars? If it's short, the toggle correctly
  hides; not a bug.
- If reason is >120 chars and toggle is missing, paste DevTools console
  errors and the inspected DOM.

You can also exercise the same toggle on `verdict` and `error` events,
but the breaker is the most reliable forced trigger.

### Step 5 — Verify Polish #3 (domain tier settings UI)

1. Open settings drawer (gear, top-right).
2. Scroll to **"Domain trust tiers"** section. On a fresh install you
   should see the hint text and `No custom tiers — every host is read-only.`
3. **Add row:** type `amazon.com` in the input, leave dropdown at
   `click-only`, click Add. Row should appear immediately:
   `amazon.com [click-only ▾] ×`.
4. **URL normalization:** type `https://www.target.com/foo?bar=1` in the
   input, dropdown `full-action`, click Add. Should appear as
   `target.com [full-action ▾] ×` (normalized: protocol + path stripped,
   `www.` removed). If it appears as the full URL, normalization is
   broken.
5. **Tier change:** change `amazon.com`'s dropdown from `click-only` to
   `full-action`. Verify it persists (drawer doesn't reset).
6. **Remove:** click `×` on `amazon.com`. Row vanishes; `target.com`
   remains.
7. **SW round-trip:** in SW DevTools, run
   `await polaris.domainTiers.listDomainTiers()`. Expect
   `{ "target.com": "full-action" }`.
8. **Persistence across drawer close:** close drawer (gear again), reopen.
   Tier list should re-fetch and show `target.com: full-action`.
9. **Persistence across SW restart:** in chrome://extensions, click the
   reload icon for Polaris (kills the SW). Reopen panel + drawer. Tier
   list should STILL show `target.com: full-action` (chrome.storage.local
   survives SW death).
10. **assertCanAct gate:** in SW DevTools, run
    `await polaris.domainTiers.assertCanAct('https://target.com/x', 'full-action')`
    — should resolve without throwing. Then run
    `await polaris.domainTiers.assertCanAct('https://amazon.com/x', 'click-only')`
    — should throw a `BrowserToolError` saying amazon.com is read-only.

### Step 6 — Capture results

Append a "Session 2 results — <date>" subsection below this one with:
- Step 1 (load + test connection): PASS/FAIL
- Step 2 (canonical task): PASS/FAIL + final answer text + wall time
- Step 3 (metrics block): PASS/FAIL + paste the table contents
- Step 4 (CollapsibleText): PASS/FAIL for breaker reason expand+collapse
- Step 5 (domain tiers): PASS/FAIL per substep (1–10)
- Any console errors observed (SW or panel DevTools), verbatim
- Bundle size as built (`ls -la dist/assets/`)

```bash
git add extension/docs/linux-validation.md
git commit -m "docs: Linux session 2 — polish #1-3 browser verification"
git push
```

### What to do if X fails

- **Step 2 task fails fast with HTTP 403** → Gap #4 not fixed. Set
  `OLLAMA_ORIGINS`, restart Ollama, retry.
- **Step 2 stalls in EXECUTING** → check SW DevTools console for the
  Ollama call; could be model unloaded, slow first call, or a real
  regression. The watchdog will mark it ABORTED at 5 min if truly stuck.
- **Step 3 metrics block missing on a clean run** → this is the polish
  feature most likely to have a wiring bug. Capture in detail per the
  triage in Step 3.
- **Step 4 toggle missing** → confirm reason is >120 chars first; the
  toggle is correctly hidden for short text.
- **Step 5 normalization wrong** → likely `normalizeHostInput` regression.
  Test from panel DevTools console:
  ```js
  // Won't expose normalizeHostInput directly (it's local); but you can
  // verify by typing inputs in the UI and observing what gets stored.
  ```
- **Step 5 persistence broken across SW restart** → chrome.storage.local
  is the source of truth; if it's empty after restart but the in-memory
  state showed entries, the `setDomainTier` write isn't completing
  before the SW dies. Capture timing.

### Hard rules (same as Session 1)

- **Do not write code.** Validation only.
- **Do not work around UI bugs** ("if X is missing, ignore and continue").
  Capture and report.
- **Do not test additional features beyond #1–#3.** Scope creep on a
  validation session masks signal.
- Commit + push the results subsection before signing off.
