# Polaris — Known Issues & Debug Log

**Last updated:** 2026-05-23

---

## Issue #1: Ollama 403 on first request — **RESOLVED ✓**

### Symptom
M1 extension loaded into Chrome on Mac, pointed at Linux Ollama at `:11434`, returned HTTP 403 on every chat request. Probe.py (Python urllib) worked fine against the same endpoint.

### Root cause
Ollama rejects requests whose `Origin` header is not on its allow-list. Browser `fetch()` from a Chrome MV3 service worker automatically attaches `Origin: chrome-extension://<extension-id>`. Python `urllib` does not send an `Origin` header, which is why the probe succeeded.

### Resolution
Set `OLLAMA_ORIGINS="chrome-extension://*"` on the Ollama server. See [README — CORS setup](README.md#cors-setup-one-time-required) for the systemd / foreground commands.

The earlier Python CORS proxy on `:11435` (see commit history) works as a fallback if you don't want to modify Ollama's environment, but `OLLAMA_ORIGINS` is the canonical fix: one env var, no separate process to keep alive across reboots.

### Validation
After setting the env var and restarting Ollama, the extension's "Test connection" returns ✓ and chat streams normally.

---

## Issue #2: `[object Promise]` in error message — **RESOLVED ✓**

### Symptom
When `loadModel` failed, the error detail rendered as `[object Promise]` instead of the actual response body.

### Root cause
`res.text()` was called without `await` in the catch chain — the Promise object itself was stringified.

### Resolution
The `loadModel` helper has been removed entirely (no longer needed once CORS is fixed at the server). Issue is moot.

---

## Issue #3: Probe passes but extension fails — **RESOLVED ✓**

Same root cause as Issue #1. The probe doesn't send `Origin` headers; the extension does. Fixed by `OLLAMA_ORIGINS`.

---

## Issue #4: Service worker probe-iteration was wasteful — **RESOLVED ✓**

### Symptom
`handleChat` previously started a chat stream, read one chunk to detect 403, then re-created the stream and started over. Every successful chat fired two HTTP requests to Ollama.

### Resolution
Rewritten in `service_worker.ts` to a single `chatStream` call. A timer-based "Loading model…" notification surfaces if no first chunk arrives within 3 s (covers the cold-load case). 403 detection moved to a clear error message that points the user at the README's CORS setup section. `loadModel` removed.

---

## Verified working (from probe.py, latest Linux run)

- `/api/chat` streaming (NDJSON)
- `/api/tags` model list
- `/api/embed` with mxbai-embed-large (1024-d)
- Native tool calls, `format: "json"` string mode, thinking-mode toggle
- Multi-turn continuity, multi-modal vision (≥1200 px source images)
- Needle-in-haystack at 4K → 128K depth (sub-quadratic latency scaling)
