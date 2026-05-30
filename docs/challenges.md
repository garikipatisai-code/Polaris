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

**Options:**
- Switch to Q4_K_M quantization (3.4 GB, fits entirely on GPU)
- Reduce `num_ctx` from the current setting to keep KV cache smaller

## 4. NVIDIA driver not persistent across reboots

The custom `linux-image-surface` kernel (`6.19.8-surface-3`) was installed on this Lenovo ThinkStation P330. The nvidia kernel module was not built for this kernel. After the user installed `dkms` and ran `modprobe nvidia`, the driver loaded, but it's unclear if it persists across reboots.

**Symptoms:**
- `modprobe: FATAL: Module nvidia not found in directory /lib/modules/6.19.8-surface-3`
- After installing dkms, the module loaded but DKMS reported the source directory missing (`/usr/src/nvidia-535 does not exist`)

**Recommendation:** Remove the Surface kernel and switch to the standard Ubuntu kernel, then rebuild the NVIDIA driver via DKMS.

## 5. Model improvises instead of calling tools correctly

qwen3.5:4b sometimes skips tool calls entirely or invents arguments. Examples:
- After receiving a screenshot, instead of calling `vision.ground({tabId: ...})`, it opens a new tab with the same URL
- When asked to verify page state, it fabricates the answer without actually calling `vision.ground`
- The Evaluator approved the task as "done" even though `vision.ground` was never called

This is a model capability limitation — qwen3.5:4b is 3.4 GB and at the edge of reliably following multi-step tool-use chains.

**Options:**
- Upgrade to a stronger model for the Executor role (cloud fallback was designed for this — Phase 2)
- Add more explicit step-by-step instructions in the Executor prompt
- Add a system-level guard that forces tool calls in specific sequences
