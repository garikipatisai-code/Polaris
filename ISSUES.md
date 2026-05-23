# Polaris M1 — Known Issues & Debug Log

**Last updated:** 2026-05-23

---

## Issue #1: Ollama 403 on first request (P1 — BLOCKING)

### Symptom
When a user sends a message in the Polaris side panel and the model is not yet in memory, the extension correctly triggers the warm-up flow, but `/api/generate` returns:

```
[error: Model load failed: load HTTP 403: [object Promise]]
```

The `[object Promise]` in the error detail is itself a bug — `res.text()` is returning a Promise instead of a string, meaning the response body was already consumed or the `.catch(() => '')` swallowed the real error.

### Root Cause (unconfirmed)
Two possibilities:
1. **Linux Ollama requires explicit CORS/local network permission** — Ollama's security model blocks cross-origin requests from extensions unless configured
2. **Model not actually loadable via `/api/generate` when cold** — the model needs to be first loaded via `/api/chat` streaming, not `/api/generate`

### What was attempted
- Added `keep_alive: -1` to force model resident (did not fix 403)
- Probe.py successfully calls `/api/chat` (not `/api/generate`) — different code path

### Next debugging steps (from Mac side)
1. **Test `/api/generate` directly on Linux:**
   ```bash
   curl -X POST http://localhost:11434/api/generate \
     -H "Content-Type: application/json" \
     -d '{"model":"qwen3.5:4b","prompt":" ","stream":false,"keep_alive":-1}'
   ```
   Does this return 403 or 200?

2. **Test `/api/chat` directly on Linux:**
   ```bash
   curl -X POST http://localhost:11434/api/chat \
     -H "Content-Type: application/json" \
     -d '{"model":"qwen3.5:4b","messages":[{"role":"user","content":"hi"}],"stream":false}'
   ```
   Does this return 403 or 200?

3. **Check if model is actually loaded:**
   ```bash
   curl http://localhost:11434/api/ps
   ```
   Returns currently loaded models. Is qwen3.5:4b listed?

4. **Check Ollama version and startup flags:**
   ```bash
   ollama --version
   ps aux | grep ollama
   ```
   Some builds require `--cors` flag to allow browser extension origins.

### Fix plan (once root cause confirmed)
- If `/api/generate` returns 403 but `/api/chat` works → use `/api/chat` with `stream:false` as warm-up instead of `/api/generate`
- If Ollama needs `--cors` flag → document in CLAUDE.md for Linux box setup
- Fix the `[object Promise]` error detail by not relying on `res.text()` in the catch block

---

## Issue #2: [object Promise] in error message (P2 — BUG)

### Symptom
When `loadModel` fails, the error detail shows `[object Promise]` instead of the actual response body text.

### Root Cause
```typescript
// Line 187 in service_worker.ts:
const detail = res.text().catch(() => '');
```
`res.text()` returns a Promise, and in the catch block we're returning `''` — but the actual problem is that `res.text()` might be called twice (once in the `if (!res.ok)` check and once implicitly). The `[object Promise]` is the stringified Promise object.

### Fix
```typescript
const detail = await res.text().catch(() => 'no body');
```
Use `await` properly, or use `res.json().catch(...)` for structured error parsing.

---

## Issue #3: Probe passes but extension fails (P1 — ARCHITECTURAL)

### Symptom
`probe.py` can successfully call `/api/chat` and stream tokens, but the browser extension (same Ollama URL) returns 403.

### Root Cause (suspected)
- `probe.py` uses Python's `urllib` — no origin headers
- Browser extension uses `fetch()` from a service worker — adds `Origin: chrome-extension://...` header
- Ollama may be rejecting requests with unfamiliar origin headers by default

### Confirmation
Check Ollama startup flags on Linux:
```bash
ps aux | grep ollama
```
If no `--cors` flag, Ollama is likely blocking requests with `Origin` or `Access-Control-Request-*` headers that don't match `localhost`.

---

## Issue #4: Service worker chat stream probing is wasteful (P3 — OPTIMIZATION)

### Location
`service_worker.ts` lines 99–113

### Problem
To detect a 403 early, the code iterates one chunk from the generator before knowing if it's a 403. This means:
- On **success**: we've already consumed the first chunk, so we recreate the stream and re-send the same request — double request
- On **403**: we catch the error, load model, retry — but the first request was wasted

### Better approach
Make the initial call with `stream: false` to get an immediate HTTP status, then use streaming for the retry. Or check model load state before the first chat call entirely.

---

## Verified Working (from probe.py)
- `/api/chat` with streaming works (Python urllib)
- `/api/tags` works (no body, simple GET)
- `qwen3.5:4b` is in Ollama's model list
- Model responds to prompts once loaded