# Remaining Challenges

## 1. Executor budget too tight for vision.ground call

The Executor's context budget is capped at ~6K tokens. A screenshot data URI is typically 500–800 KB as a base64 string, which translates to roughly 125–200K tokens in the model's context. When `tab.screenshot` returns the full data URI, the model cannot fit it in the Executor budget. This causes:

- The model fabricates truncated placeholders like `data:image/png;base64,placeholder_screenshot_data...`
- `vision.ground` args validation rejects these with `"dataUri must be a base64-encoded PNG data URI"`
- The model enters a failure loop: retry screenshot → budget fills → compaction → open new tab → repeat

**Attempted fix (40a5be1):** Added a cross-tool screenshot cache (`cacheScreenshot` Map in `vision.ts` keyed by tabId) so `vision.ground` accepts `tabId` instead of `dataUri`. However, qwen3.5:4b still doesn't reliably use `tabId` — it falls back to opening duplicate tabs.

**What needs to happen:**
- The Executor prompt or tool description must strongly bias the model toward calling `vision.ground({tabId: N})` after any `tab.screenshot(...)` result
- Or the evaluator should automatically run vision verification without requiring the model to call the tool explicitly
- Or `tab.screenshot` should automatically trigger a vision verification and return the result alongside the data URI

## 2. Evaluator Ollama timeout (5 min)

The Evaluator role has a 5-minute timeout (300,000ms = `DEFAULT_CHAT_TIMEOUT_MS`). On the P2200 with partial GPU offload, some Evaluator calls take >206 seconds. The timeout fires and aborts the entire task even when the Executor completed all steps successfully.

Example from trace:
```
evaluator start
error Ollama chat timed out after 300000ms
verdict abort — unrecoverable: Ollama chat timed out after 300000ms
```

**Root cause:** The Evaluator prompt is large (includes the full goal, plan, findings, and recent actions). At 11-38 tok/s this can exceed 5 minutes.

**Options:**
- Increase the Evaluator timeout
- Reduce the Evaluator prompt size
- Make the Evaluator timeout non-fatal (retry or skip)
- Disable Evaluator thinking mode (`evaluatorThinking: false`)

## 3. qwen3.5:4b model doesn't fit fully on GPU

`ollama ps` shows `31%/69% CPU/GPU` split. The loaded quantization is ~6 GB but the Quadro P2200 has only 5 GB VRAM. The model is partially offloaded to CPU.

**Effect:** Slower inference than full GPU fit. The 38 tok/s benchmark was for short "pong" responses. Real agent prompts with multi-thousand-token context are slower.

Also benchmarked `qwen3.6:35b-a3b` (MoE, 3B active params, 23 GB file) on the same hardware: it runs 85%/15% CPU/GPU at ~11 tok/s. Usable for Planner but too slow for Executor.

**Options:**
- Switch to Q4_K_M quantization (3.4 GB, fits entirely on GPU)
- Reduce `num_ctx` from the current setting to keep KV cache smaller

## 4. Model keeps repeating the same actions instead of progressing

qwen3.5:4b often gets stuck in repetitive loops:

- After `tab.screenshot` succeeds, the model opens a *new* tab with the same URL instead of calling `vision.ground` on the existing tab. This repeats multiple times — each cycle opens another duplicate tab, takes another screenshot, fills the scratchpad, triggers compaction, and never makes progress toward the goal.
- The model sometimes skips tool calls entirely and fabricates the answer from context.
- Example: a 10-executor-turn trace shows 4 duplicate `tab.open` calls (google.com opened 4 times), 0 `vision.ground` calls, yet the Evaluator still approved the task as "done."
- The Evaluator approved a task as complete even though `vision.ground` was never called — it accepted the model's fabricated claim that vision had verified the page.

**Root cause:** qwen3.5:4b is a 3.4 GB model at the edge of reliably following multi-step tool-use chains. When confused, it defaults to "open another tab" as a generic recovery action.

**Options:**
- Upgrade to a stronger model for the Executor role (cloud fallback was designed for this — Phase 2)
- Add explicit "tab reuse" instructions: after opening a tab, prefer using its existing tabId for subsequent actions
- Add a breaker that detects consecutive duplicate `tab.open` calls and forces a different action
- Deprecate qwen3.5:4b as the Executor once DeepSeek V4-Flash cloud routing works (Phase 2)

## 5. Tab management issues

The agent doesn't reuse existing tabs effectively:

- `tab.list` returns owned tabs but the model ignores them and opens new ones
- After `tab.screenshot` captures a valid screenshot, the model opens a fresh tab instead of proceeding with the existing tabId
- Each duplicate `tab.open` adds to `ownedTabs` but these tabs are never cleaned up during the task, only at terminal
- The `tab.screenshot` tool proved reliable via CDP `Page.captureScreenshot` — taking the screenshot is not the problem; the model just doesn't know what to do after getting it

**Needs:** Better prompt guidance that "tab.open is expensive — reuse tabIds you already have."
