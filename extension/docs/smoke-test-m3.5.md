# Polaris M3.5 smoke test — runnable recipe

> Validates M2 agent loop + M3 backend tools + M3.5 (manifest perms, KV cache, PII, content tagging, domain tiers, breaker, telemetry) in one Chrome session on Mac. ~30 minutes including Ollama warmup.
>
> This is the validation that's been missing since M2 closed. Run it before any further code lands.

---

## Pre-flight

```bash
# 1. Confirm Ollama is running with qwen3.5:4b
curl -s http://localhost:11434/api/tags | jq '.models[].name'
# Expect: qwen3.5:4b at minimum

# 2. CORS allow for chrome-extension origin (one-time)
launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
# (then restart Ollama if it was already running — quit menu-bar app + relaunch)

# 3. Build extension
cd ~/Documents/Spike/Personal/Browser/Polaris/extension
npm install   # if not already
npm run build
# Should produce: dist/ — service-worker bundle ~162 KB, panel ~158 KB
```

## Load + first paint

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. **Remove any prior Polaris install** (there may be one from earlier sessions)
4. **Load unpacked** → select `extension/dist/`
5. Click the **★ Polaris** toolbar icon → side panel opens
6. **Open SW DevTools**: from `chrome://extensions`, find Polaris → click "Inspect views: service worker"

> **First-paint failures to watch:**
> - **Manifest error red banner on extension card** → manifest is malformed; check `dist/manifest.json` has `tabs`, `debugger`, `activeTab` permissions and the `content_security_policy` block.
> - **Side panel blank** → check SW DevTools console for any thrown error before the `[polaris] state + tools primitives → globalThis.polaris` log line.
> - **No `polaris.metrics` on globalThis** → telemetry didn't wire; check SW console for an import error.

## Sanity checks in SW console

Paste each line; expected output:

```js
typeof polaris.metrics.summary
// "function"

await polaris.metrics.summary('any-task')
// []  (no metrics yet — empty array, not throw)

await chrome.permissions.contains({ permissions: ['tabs', 'debugger', 'activeTab'] })
// true  (M3.5 manifest fix)

(await chrome.storage.local.get(null))
// {} or { 'polaris.agent.hot': null }  (no leftover state)
```

If any of those throws or returns wrong, **stop here** and capture the error — it means M3.5 didn't actually land in the build.

## Connection test

In the side panel:

1. Click ⚙ gear → set Ollama URL to `http://localhost:11434`
2. **Test connection** → green ✓ + model list (should show `qwen3.5:4b`)
3. Pick **qwen3.5:4b** as model
4. Close settings drawer

> **Failures here:**
> - Red ✗ + 403 → CORS env var didn't take; relaunch Ollama after step 2 of pre-flight.
> - Red ✗ + timeout → Ollama not running.
> - Green ✓ but no models → Ollama is up but qwen3.5:4b isn't pulled (`ollama pull qwen3.5:4b`).

## The canonical task

In the side panel goal field, type **verbatim** (the byte-survival contract):

```
Use memory.write to store 17 under key 'a' in namespace 'nums', 25 under key 'b', and 8 under key 'c'. Then use memory.read to verify each. Use the sum tool to add 17, 25, 8, and finish with the total.
```

Click **Run**.

## What to watch in the side panel

Expected sequence in the timeline (~2-5 minutes on Mac CPU):

1. **Phase: PLANNING** appears.
2. **Planner role_end** appears with `ok=true`. Plan tree renders 3-6 root steps.
3. **Phase: EXECUTING**.
4. **Tool calls in sequence**: `memory.write` (×3), `memory.read` (×3), `sum`, `finish`. Each followed by a `tool_result` row.
5. **Step advancement** rows (`step_advance: explicit, fromStep → toStep`). At least 2-3 of these.
6. **Compaction** event row at some point (M2.7.4 + UX agent surfaced this; should show `archived N entries → M findings` + token cost). **This is the M3.5 UX agent's biggest win — verify it actually renders.**
7. **Evaluator role_end** with verdict.
8. **Phase: DONE** + final answer containing **50** or **fifty**.

> **What "broken" looks like:**
> - No timeline events at all → port disconnect. Reload the panel.
> - Stuck in PLANNING > 3 minutes → first Planner call slow on Mac (cold model load); be patient.
> - `executor returned no tool call after retry` → qwen3.5 didn't tool-call; the M2.7.3 retry pattern handles 80% but 20% slip through. Run again.
> - Phase ABORTED with "exceeded 3 replans" → Evaluator is rejecting valid finishes. Capture `polaris.state.loadHot().breaker.trips` and report.
> - Phase DONE with empty finalAnswer → M2.5.1 contract violation; should NOT happen because of the override. If it does, that's a real regression.

## After the run completes — capture this in SW console

```js
// 1. Final state
const final = await polaris.state.loadHot();
console.log({
  phase: final.phase,
  finalAnswer: final.finalAnswer,
  goal: final.goal.text,
  goalIsByteEqual: final.goal.text ===
    "Use memory.write to store 17 under key 'a' in namespace 'nums', 25 under key 'b', and 8 under key 'c'. Then use memory.read to verify each. Use the sum tool to add 17, 25, 8, and finish with the total.",
  totalTokens: final.budgets.totalTokens,
  ownedTabs: final.ownedTabs,
  trips: final.breaker.trips,
});

// 2. Per-op latency summary (M3.5 telemetry — first time we have real numbers)
await polaris.metrics.summary(final.taskId);
// Expect a sorted array; planner_initial likely highest mean, executor_turn lowest.

// 3. Findings persisted (Compactor output)
const findings = await polaris.state.findingsByRecency(final.taskId, 30);
console.log(findings.map(f => ({ key: f.key, value: f.value, source: f.source })));

// 4. Memory cells survived (cross-task primitive working)
await polaris.state.memoryRead(final.taskId, 'nums', 'a');  // expect { value: '17', ... }
await polaris.state.memoryRead(final.taskId, 'nums', 'b');  // expect { value: '25', ... }
await polaris.state.memoryRead(final.taskId, 'nums', 'c');  // expect { value: '8', ... }

// 5. Compaction actually fired (M3.5 UX surfacing test)
const events = await polaris.state.eventsSince(final.taskId, 0);
const compactions = events.filter(e => e.type === 'compaction');
console.log(`compactions: ${compactions.length}, total events: ${events.length}`);
// Expect compactions ≥ 1.

// 6. Domain tier defaults are read-only (M3.5 safety floor)
const { getDomainTier } = polaris.tools;  // (or import from agent/domain_tiers if not re-exported)
// If not re-exported, run:
await chrome.storage.local.get('polaris.domain_tiers');
// Expect: {} or { 'polaris.domain_tiers': {} } — no domains pre-trusted.
```

## PII filter explicit test

```js
// After the canonical task succeeds, manually exercise the PII filter:
const taskId = (await polaris.state.loadHot())?.taskId;
const f = await polaris.state.appendFinding({
  taskId,
  source: 'compactor',
  stepId: null,
  kind: 'fact',
  key: 'pii_smoke',
  value: 'Ship to 123 Main Street, contact jane@x.com, card 4111-1111-1111-1111',
});
console.log(f.value);
// Expect: "Ship to [ADDRESS], contact [EMAIL], card [CC]"
```

## What success looks like

| Check | Expected |
|---|---|
| Manifest loads, all permissions granted | ✓ |
| Side panel renders, settings work | ✓ |
| Connection test green | ✓ |
| Plan tree renders with steps | ✓ |
| Tool calls + results visible in timeline | ✓ |
| Step advancement rows visible | ≥ 2 |
| Compaction events visible (icon + token cost) | ≥ 1 |
| Final answer contains "50" or "fifty" | ✓ |
| `final.phase === 'DONE'` | ✓ |
| Goal text byte-equal to original | ✓ |
| `polaris.metrics.summary` returns ≥ 4 ops | ✓ |
| Memory cells round-trip | ✓ |
| Findings ≥ 1 in IDB | ✓ |
| Domain tier defaults `read-only` | ✓ |
| PII filter redacts on `appendFinding` | ✓ |

## What to send back

If any check fails, capture:

1. The screen state (panel screenshot if possible)
2. SW console output up to the failure (`polaris.dumpLogs()` for the full ring buffer)
3. `polaris.state.loadHot()` snapshot
4. `polaris.metrics.summary(taskId)` if any metrics landed

If the run succeeds end-to-end, M3.5 is empirically validated and we can: (a) run the same against the Linux box for the calibration probe, or (b) start M4 with confidence.
