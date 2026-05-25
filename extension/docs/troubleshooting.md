# Polaris Troubleshooting Guide

Each entry is **Symptom → Diagnosis → Fix**. Terse and factual. If a recipe references `polaris.*`, run it from the service-worker DevTools console (`chrome://extensions` → Polaris → "service worker"); if it references the panel console, open the side panel and use its DevTools.

## "Test connection" returns 403

**Diagnosis.** Ollama is rejecting the request because the `Origin: chrome-extension://...` header is not on its allow-list. This is a CORS issue, not a network or model problem.
**Fix.** Set `OLLAMA_ORIGINS="chrome-extension://*"` on the Ollama process and restart it. Recipe is in the README "CORS setup" section. On macOS use `launchctl setenv`; on Linux systemd use `systemctl edit ollama.service`. The Python proxy on port 11435 is a fallback if you cannot modify the Ollama env.

## "Test connection" returns timeout

**Diagnosis.** Ollama is not running, the URL is wrong, or a firewall is dropping the request. The default 10-second ping should be more than enough on any healthy instance.
**Fix.** Run `curl http://localhost:11434/api/tags` (or whichever URL is set in Polaris settings). If that fails, Ollama is down — start it. If it succeeds, your Polaris settings have the wrong URL — open the side panel settings and re-paste. On a Mac-talks-to-Linux deployment, also confirm the Linux firewall allows inbound 11434 from your Mac's IP.

## Agent stuck "PLANNING" with no progress

**Diagnosis.** The Planner call is slow on this hardware. Per CLAUDE.md, Mac CPU runs ~0.3–5 tok/s on this model; Linux P2200 sustains ~38 tok/s. A Planner turn at the 32 K budget can legitimately take minutes on Mac.
**Fix.** Open service-worker DevTools and run `polaris.dumpLogs()` to see the most recent `chatOnce` timing. If the call is in flight, wait. If timings consistently exceed the 5-minute timeout, switch the Ollama URL to the Linux box (or a faster machine) — the Mac is not viable for the Planner role.

## Agent terminates with "exceeded 3 replans"

**Diagnosis.** Either the task is unsolvable with the current tool set, or the Evaluator is rejecting good answers, or the breaker is tripping on action repetition / no-progress and forcing replans the Planner cannot satisfy.
**Fix.** Run `polaris.state.loadHot()` and inspect `breaker.trips` and `breaker.recentActionHashes`. If the trips are all `action_repeat`, the Executor is cycling — usually a missing tool. If they are `no_progress`, the Planner's success criteria are unrealistic for the available tools. Edit the goal to be more concrete and try again.

## "executor returned no tool call after retry"

**Diagnosis.** qwen3.5's tool-call success rate is ~80% per the probe. The role retries once with the M2.7.3 stronger pattern (`assistant-failed` + `user-nudge`); if both calls return empty, the Executor errors. Often correlated with non-ASCII goals (€, ★, Chinese), ambiguous plans, or steps with no clear single tool.
**Fix.** Capture the failed prompts via `polaris.dumpLogs()` and check the assistant content from the failed turn — it usually contains prose-only output. If you see this often on the same shape of task, the prompt template likely needs tightening; report with the dump.

## Side panel shows no events but task is running

**Diagnosis.** The chrome.runtime port disconnected during a long call (typical when the panel is closed-then-reopened, or after a tab focus switch). The orchestrator continues in the service worker and writes events to IndexedDB, but the panel is not subscribed to receive live updates.
**Fix.** Reload the side panel. The `agent.resume` flow replays buffered events from IDB into the new port, so the UI state will catch up. The task itself is unaffected.

## `chrome.storage.local` quota exceeded

**Diagnosis.** A long-running task accumulated a huge scratchpad before the compactor ran (or the compactor's discard rule did not match the data shape). The `chrome.storage.local` quota is 10 MB.
**Fix.** Run `polaris.state.resetTask(taskId)` from the service-worker console to wipe a specific task's hot state. The findings archive in IDB is unaffected. If quota exhaustion recurs, the compactor's threshold or discard predicate likely needs tuning.

## Service worker keeps getting killed mid-task

**Diagnosis.** MV3 service workers idle out after ~30 s of no port traffic. The chrome.alarms heartbeat (5-min watchdog) is supposed to keep the SW warm, and the in-SW `setInterval` heartbeat bumps `lastTouch` every 30 s while a task runs. If the SW is dying anyway, the alarm is not firing.
**Fix.** Open `chrome://extensions` → Polaris → "service worker" and confirm the heartbeat alarm is registered (`chrome.alarms.getAll`). The watchdog catches stale tasks and surfaces a Resume button in the panel. If the SW dies repeatedly mid-task without a Resume offer, the alarm registration logic is broken — file with the SW console output.

## `format: <schema-object>` doesn't work

**Diagnosis.** Confirmed broken on qwen3.5 (10/10 fail on Mac, 3/3 fail on Linux per probe). The model returns nominally well-formed JSON that does not match the supplied schema.
**Fix.** Per conventions, never use `format: <schema-object>`. Use `format: "json"` string mode and validate the response with Zod on the client side. All four roles already do this; if you find a code path that still passes a schema object, it is a regression.

## Agent reaches DONE with finalAnswer = ""

**Diagnosis.** The Evaluator returned `done: true` with an empty `finalAnswer`. The M2.5.1 contract overrides this state to `continue` and emits a console warning (`evaluator returned DONE with empty answer; overriding to continue`).
**Fix.** Check the service-worker console for the warning. If you see it, the override is doing its job. If the task still terminates with an empty answer despite the warning, the override has regressed — capture `polaris.dumpLogs()` and the IDB event for that turn and report.

## Memory cells aren't surviving compaction

**Diagnosis.** Memory cells (written via `memory.write`) live in IDB and **do** survive compaction; only the scratchpad is touched. If a cell looks gone, the read is hitting the wrong namespace.
**Fix.** Run `polaris.state.memoryList(taskId, namespace)` from the service-worker console to confirm what is actually stored. Default namespace is `default`; the canonical end-to-end task uses `nums`. Namespaces are case-sensitive. If the cell is genuinely missing from the right namespace, check the original `memory.write` tool call's args in `polaris.dumpLogs()` — the model occasionally inverts key/value or passes a numeric value where a string was expected.

## Task resumes but immediately re-aborts

**Diagnosis.** The previous run aborted on an Ollama failure (mid-run HTTP 503, network drop) and the task is in `phase: 'ABORTED'`. The M2.7.4 mid-run-failure handler transitions to ABORTED honestly so resume cannot pick a dead task and fail the same way.
**Fix.** Confirm with `polaris.state.loadHot()`. To restart from scratch, run `polaris.state.resetTask(taskId)` and submit the goal again. To resume from where it failed, you need to manually patch `phase` back to `EXECUTING` — only do this if you know Ollama is healthy now, otherwise you will reproduce the failure.
