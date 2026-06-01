# ★ Polaris

A goal-anchored agentic assistant for Chrome: tell it any goal you'd open a browser to accomplish, and it pursues that goal autonomously — without losing the thread. Local-first via Ollama (`qwen3.5:4b` hot-path + `qwen3.6:35b-a3b` reasoning), with optional per-role cloud BYOK.

> Your North Star for the web — never loses sight of what you actually asked for.

## What this is

You state a goal in plain language — research a topic, compare options, book or fill something out, monitor a page over time, look something up across a dozen sources, hunt a deal — and Polaris pursues it: opening tabs, reading pages, and synthesizing results until the goal is met. It's built for any task you'd open a browser to accomplish, not a single canned workflow.

It runs fully locally by default — no browsing data leaves your machine. Optionally enable per-role cloud routing (bring your own key); only PII-anonymized prompts are sent to your configured provider, and everything else stays local.

The architectural distinction: a hierarchical **Planner / Executor / Evaluator** loop with persistent state outside the model context, so the agent stays locked on your original goal even when its working context fills up mid-task.

**First proving ground (Phase 1):** cross-retailer deal hunting — a deliberately hard, multi-step, multi-tab goal. Tell Polaris what you want; it searches Amazon, Walmart, Best Buy, Target, etc.; extracts price + shipping + stock + coupons; ranks by total cost; surfaces the best options. You click to buy — no checkout automation. The same loop generalizes to any goal; deal-hunting is just where we harden it first.

## Status

In active development. Currently:

- ✅ Architecture designed (hierarchical agent + persistent state + ARIA-tree extraction + vision-grounded verification)
- ✅ Capability probe written and verified against the local Qwen models on real hardware
- ✅ **M1** — extension skeleton + Ollama wiring + streaming chat in side panel
- ✅ **M2** — full agent loop (Planner / Executor / Evaluator / Compactor) with persistent state, step advancement, circuit breaker, watchdog, crash-resume, and 116 unit + integration tests proving goal byte-survival across replan
- ✅ **M3** — real browser tools backend wired (ARIA-tree extractor, tab manager, search, retailer adapter framework + Amazon, browser tool lifecycle); **page-action tools** (CDP click/type/select with domain-tier gating); **vision.ground** verification tool via Ollama vision model; 376 total tests
- ✅ **Hybrid infrastructure** — OpenAI-format CloudClient (raw fetch, no SDK) + per-role provider routing in orchestrator + cloud client routing for executor/evaluator
- ✅ **SoM content script** — numbered interactive element overlay
- ✅ **Reversible PII redaction** — anonymize/deanonymize sandwich for cloud-bound payloads

## Hardware

| Resource | Minimum | Recommended |
|---|---|---|
| GPU VRAM | 4 GB | 8 GB+ |
| System RAM | 16 GB | 32 GB |
| Disk | 5 GB | 10 GB |
| Model | `qwen3.5:4b` (Q4_K_M, ~3.4 GB) | same |

Tested target: Linux + NVIDIA Quadro P2200 (5 GB) + 32 GB DDR4 → ~20 tok/s.

## Install the extension (M1)

The extension lives in [`extension/`](extension/). It's a Vite + React + TypeScript MV3 project built with [@crxjs/vite-plugin](https://crxjs.dev/vite-plugin).

```bash
cd extension
npm install
npm run dev          # dev build with HMR, watches src/
# - or -
npm run build        # one-shot production build into extension/dist/
```

Then in Chrome:

1. Navigate to `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked**
4. Select either `extension/dist/` (after `npm run build`) or the dev output directory printed by `npm run dev`

Click the Polaris toolbar icon to open the side panel. The first time:

1. Click the ⚙ gear in the top-right of the panel
2. Confirm the **Ollama URL** (defaults to `http://localhost:11434`; set it to your Linux box if remote)
3. Click **Test connection** — you should see a green ✓ and a model count
4. Pick a **Model** from the autocomplete (defaults to `qwen3.5:4b`)
5. Type a message and hit Enter — tokens stream in as the model generates

The "Goal" field is the persistent anchor that the M2 agent loop will be locked to. In M1 it's just included in the system prompt for the current chat.

## CORS setup (one-time, required)

Ollama rejects requests from browser extensions by default (HTTP 403, because the `Origin: chrome-extension://...` header isn't on its allow-list). You need to set `OLLAMA_ORIGINS` once on the machine running Ollama.

**If Ollama runs as a systemd service (typical Linux install):**

```bash
sudo systemctl edit ollama.service
```

Add these lines in the override editor:

```ini
[Service]
Environment="OLLAMA_ORIGINS=chrome-extension://*"
Environment="OLLAMA_KV_CACHE_TYPE=q8_0"
Environment="OLLAMA_KEEP_ALIVE=-1"
```

- `OLLAMA_ORIGINS` — allows the Chrome extension to reach Ollama (otherwise HTTP 403).
- `OLLAMA_KV_CACHE_TYPE=q8_0` — halves KV cache memory, enabling 16K+ context windows on 5 GB VRAM.
- `OLLAMA_KEEP_ALIVE=-1` — keeps models loaded in memory between requests (avoids 5-15s reload delays).

Save, then:

```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
systemctl show ollama --property=Environment   # verify
```

**If you run Ollama in the foreground (e.g., dev / macOS):**

```bash
OLLAMA_ORIGINS="chrome-extension://*" ollama serve
```

**Verify from the extension:** open the ⚙ settings drawer in Polaris and click **Test connection**. You should see a green ✓ and a model count. If you see ✗ with a 403 hint, the env var didn't take — double-check the systemd override.

You can also use a wider value like `OLLAMA_ORIGINS="*"` for testing, but pin it to `chrome-extension://*` in production to avoid exposing your local Ollama to arbitrary websites.

## Run the test suite

The agent's pure logic and orchestrator state machine are covered by Vitest:

```bash
cd extension
npm test           # 376 mock-Ollama tests, ~15 s
npm run test:watch # watch mode
```

114 tests cover:
- Pure-function units (`walkPlan`, `actionHash`/`stableStringify`, `parseJSONPermissive`, ULID, budget helpers including the new chars-per-token reconciliation)
- Circuit breaker (`evaluate`, `recordAfter`, `resetForReplan`, `recordTrip`, plus the M2.7.2 distinct-action progress signal)
- State store (lifecycle, goal immutability, forward-fill migration, plus the hot-state mutex serialization contract)
- 5 orchestrator end-to-end integration tests with a scripted fake Ollama client (proves goal byte-survival across replan + retry without a real model)
- OllamaClient HTTP timeout, 5xx retry, network-error retry, abort-signal propagation, and `keep_alive` defaults
- Role retry-pattern shape: every role's retry path uses `[system, user-anchor, assistant-failed, user-nudge]` rather than the unreliable `[system, system-nudge]`

### Real-Ollama integration tests

Two extra tiers exercise the agent against a live Ollama server:

```bash
# Fast smoke — Planner JSON round-trip + Executor tool_call round-trip.
# Skips gracefully if Ollama isn't reachable. ~30s + ~70s on Mac CPU,
# <10s total on a GPU box.
npm run test:integration

# Full agent loop — 4 multi-turn end-to-end tests:
#   • trivial single-tool task
#   • multi-tool with memory + sum
#   • non-ASCII goal byte-survival
#   • compaction-fires + findings persisted + scratchpad emptied (Phase 4)
# Opt-in because each test does 4–8+ model calls; on the Linux P2200 they
# take 1–3 min each, on Mac CPU they can take 20+ min.
npm run test:integration:full
```

Override the URL or model via env vars: `OLLAMA_URL=http://192.168.1.50:11434 OLLAMA_MODEL=qwen3.5:4b npm run test:integration:full`.

## Dual-model Ollama setup (local 35B reasoning)

Polaris's default routes Planner/Evaluator to `qwen3.6:35b-a3b` and
Executor/Compactor to `qwen3.5:4b`, with both models resident at once. On the
reference box (5 GB VRAM + 32 GB RAM) the verified config is:

    OLLAMA_MAX_LOADED_MODELS=2
    OLLAMA_KEEP_ALIVE=-1
    OLLAMA_KV_CACHE_TYPE=q8_0

Pin the 35B to CPU (it doesn't fit 5 GB VRAM) via a Modelfile (`PARAMETER
num_gpu 0`); keep the 4B GPU-resident. Pull both: `ollama pull qwen3.5:4b` and
`ollama pull qwen3.6:35b-a3b` (~23 GB — put it on fast storage). Footprint is
tight (~29/31 GB RAM, ~4.4/5 GB VRAM) but stable. If the browser needs CORS,
re-add `OLLAMA_ORIGINS=chrome-extension://*` (a `systemctl revert` wipes it).

## Run the capability probe

Verifies your local Qwen models have everything Polaris needs.

```bash
# 1. Install Ollama (one-time): https://ollama.com/download
# 2. Pull the models
ollama pull qwen3.5:4b
ollama pull qwen3.6:35b-a3b    # reasoning roles — ~23 GB, put on fast storage
ollama pull mxbai-embed-large  # for the future embeddings index

# 3. Run the probe (all tests)
python3 probe.py

# Or hit a remote Ollama (e.g., browser on laptop, model on a GPU box)
OLLAMA_BASE_URL=http://192.168.1.50:11434 python3 probe.py

# Run a subset
python3 probe.py --only chat,tool,needle --needle-depths 4,16,64,128

# Skip the slow needle tests
python3 probe.py --skip needle
```

Outputs `probe_results.json` (structured) and `probe.log`. Each test is saved incrementally — safe to interrupt and resume by running the subset you missed.

## Architecture (high level)

```
chrome.sidePanel UI ──► background service worker
                          │
                          ├── Agent loop
                          │   ├── Planner    (thinking-mode ON,  rare calls)
                          ├── │   Executor   (thinking-mode OFF, hot path)
                          │   ├── Evaluator  (thinking-mode ON,  periodic)
                          │   ├── Compactor  (scratchpad → structured findings)
                          │   ├── CircuitBreaker (loop / dup-action detection)
                          │   └── Reflexion  (write lessons on failure)
                          │
                          ├── Persistent state
                          │   ├── chrome.storage  (goal, plan, budgets)
                          │   └── IndexedDB       (findings, lessons, skills)
                          │
                          ├── Memory
                          │   ├── working / episodic / archival tiers (MemGPT-style)
                          │   └── embedding index over archival (mxbai-embed-large)
                          │
                          ├── Tools
                          │   ├── ARIA-tree extractor (chrome.debugger)
                          │   ├── Visual verifier (screenshot → Qwen vision)
                          │   ├── Tab manager (open / extract / close)
                          │   ├── Page-action tools (CDP click / type / select)
                          │   ├── SoM overlay (numbered interactive element labels)
                          │   ├── Retailer adapters (Amazon, Walmart, ...)
                          │   └── Search (DuckDuckGo / Google Shopping)
                          │
                          ├── Clients
                          │   ├── Ollama HTTP client (local — qwen3.5:4b hot-path, qwen3.6:35b-a3b reasoning)
                          │   └── CloudClient (OpenAI-format, raw fetch)
                          │
                          └── PII handling
                              ├── Irreversible redact (IDB persistence)
                              └── Reversible anonymize/deanonymize (cloud-bound)
```

The hierarchical role split keeps per-call context tight (≤6K for the Executor hot path) so the GPU-resident KV cache stays small and the agent feels responsive. Larger calls (planning, evaluation) are rare and tolerate higher latency.

See [`docs/research-notes.md`](docs/research-notes.md) for the literature survey behind these design choices.

## Roadmap

- **M1** ✅ Extension scaffold (MV3, side panel, service worker), Ollama HTTP client, basic chat round-trip
- **M2** ✅ Full agent loop:
  - Planner / Executor / Evaluator / Compactor roles with thinking-mode toggles
  - Persistent state in `chrome.storage.local` + IndexedDB; goal text byte-immutable across replan
  - Step advancement via `next_step` tool; force-advance after 8 turns
  - Circuit breaker (action repetition, max replans), chrome.alarms watchdog, crash-resume with event replay
  - Mock tools (`echo`, `add`, `sum`, `delay`, `next_step`, `finish`, `memory.read/write/list`)
  - 73 tests: pure-function unit tests + orchestrator integration tests with a scripted fake Ollama client (no model dependency)
- **M3** ✅ Real browser tools (ARIA-tree extractor, tab management, search, page-action click/type/select, vision.ground, SoM overlay) — 376 tests
- **M4** First vertical — shopping / deal-hunting (retailer adapters, coupon lookup, deal-ranking UI)
- **M5** Polish (price history, error recovery, onboarding, settings)

## Stack

- **Browser:** Chrome MV3 (works on Edge / Brave / Arc / Opera)
- **Models:** [qwen3.5:4b](https://ollama.com/library/qwen3.5) (Executor/Compactor hot-path) + [qwen3.6:35b-a3b](https://ollama.com/library/qwen3.6) (Planner/Evaluator reasoning) via [Ollama](https://ollama.com) — hybrid Gated DeltaNet SSM + sparse full-attention, native vision, native tool calling, 256K context
- **Embeddings:** [mxbai-embed-large](https://ollama.com/library/mxbai-embed-large) for archival memory retrieval
- **UI:** chrome.sidePanel API (Chrome 114+)

## License

Apache 2.0 — see [LICENSE](LICENSE).
