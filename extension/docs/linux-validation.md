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
