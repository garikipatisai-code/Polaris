# Architecture Delta: Design Doc ↔ Current Implementation

> **Purpose:** Maps every section of `docs/Polaris Hybrid Agentic Browser Design.md`
> against the current codebase to identify gaps, effort, and build order.
> "Current" = `main` at M3.5.1 (333 mock + 2 fast + 4 slow E2E passing).
> **Audited 2026-05-29** — verified against actual codebase via parallel
> subagent exploration. Corrections: domain tiers are already built (Phase 5
> item 4), not a future deliverable.

---

## 1. Hybrid Compute Split & Per-Role Model Routing

| Role | Design Doc (Desired) | Current Implementation | Gap |
|------|---------------------|----------------------|-----|
| **Planner** | Cloud DeepSeek V4-Flash, thinking ON, 32K ctx | Local qwen3.5:4b via Ollama, 32K ctx, thinking ON ✅ | **Compute environment** — needs cloud client, model swap |
| **Executor** | Cloud DeepSeek V4-Flash, thinking OFF, 6K ctx | Local qwen3.5:4b via Ollama, 6K ctx, thinking OFF ✅ | **Compute environment** — needs cloud client, model swap |
| **Evaluator** | Cloud DeepSeek V4-Flash, thinking ON, 8K ctx | Local qwen3.5:4b via Ollama, 8K ctx, thinking ON ✅ | **Compute environment** — needs cloud client, model swap |
| **Compactor** | Local qwen3.5:4b, thinking OFF, 8K ctx | Local qwen3.5:4b via Ollama, 8K ctx, thinking OFF ✅ | **No gap** — already correct |

**Key observation:** The roles, context budgets, thinking modes, and retry
patterns are already implemented. The gap is exclusively about where the model
runs — swapping `client + model` per role instead of passing one pair.

### What needs to change

**`extension/src/background/ollama.ts`** — Leave as-is (Compactor + embeddings
still use it). The cloud path needs a separate client.

**New file: `extension/src/background/cloud_client.ts`** — DeepSeek-compatible
OpenAI-format HTTP client. Key differences from OllamaClient:
- OpenAI `/v1/chat/completions` format, not Ollama `/api/chat`
- API key header auth, not no-auth
- Different streaming path (SSE, not NDJSON)
- Provider selection (DeepSeek official, OpenRouter, DeepInfra)
- Different timeout profile (cloud ~30s, not local ~5min)
- Prompt caching header support (DeepSeek: `x-ds-priority: cache-write/read`)

**`extension/src/agent/orchestrator.ts`** — `OrchestratorOptions` currently
takes `{ client, model }`. Change to accept a role-to-endpoint mapping:

```ts
interface RoleEndpoint {
  kind: 'ollama' | 'cloud';
  client: OllamaClient | CloudClient;
  model: string;
  thinking: boolean;
}
```

Each role's runner call (`runPlanner`, `runExecutor`, `runEvaluator`,
`runCompactor`) passes the mapped endpoint instead of the single pair.

**`extension/src/shared/messages.ts`** — `Settings` interface needs:
- `plannerEndpoint: { provider, model, apiKey }`
- `executorEndpoint: { provider, model, apiKey }`
- `evaluatorEndpoint: { provider, model, apiKey }`
- Keep `embeddingModel` and `ollamaBaseUrl` for local Compactor + tools

**Effort:** Medium (~2 days). Low code-change surface (orchestrator plumbing),
moderate for the cloud client (testing against real API).

---

## 2. Vision Pipeline (Local VLM + Set-of-Marks + Dual-Channel Fusion)

This is the **largest gap** — the design doc's most distinctive feature has
almost no implementation.

### 2a. Local VLM (qwen2.5vl:3b)

**`extension/src/agent/tools/browser/tab.ts`** — `tab.screenshot` captures a
PNG and parses its IHDR for dimensions. No VLM consumption exists.

**New: `extension/src/agent/tools/browser/vision.ts`** — Register a
`vision.ground` tool that:
1. Takes a screenshot + SoM annotation as input
2. Sends to local Ollama qwen2.5vl:3b via OllamaClient's existing chat stream
   (but with `images: [base64]` in the message — Ollama's format)
3. Returns structured output: "element N is visible/obscured, page state is X"
4. Acts as a **verification layer**, not primary extraction

The OllamaClient already supports `images?: string[]` in `ChatMessage` — this
is unused dead code waiting to be activated.

**VRAM math (design doc claims):** qwen2.5vl:3b @ Q4_K_M = ~3.2 GB resident
+ mxbai-embed-large 0.7 GB = 3.9 GB, leaving ~1.1 GB on P2200 for KV cache.
Needs empirical validation before committing to always-resident.

### 2b. Set-of-Marks Annotation

**New content script: `extension/src/content/som.ts`** — Injects into the page
to:
1. Query `chrome.debugger` / `DOM.getDocument` + `DOM.querySelectorAll` for
   interactable elements (buttons, links, inputs, comboboxes)
2. Overlay semi-transparent bounding boxes with colored SoM ID labels
3. Return a coordinate map: `{ [somId]: { x, y, w, h, role, text } }`
4. Coordinate with `aria.extract` tool to fuse AXTree nodes ↔ SoM IDs

**New manifest permission:** `scripting` (for content script injection) or use
`chrome.debugger`'s `Runtime.evaluate` to inject the overlay JS.

**Note:** The domain-tier gating infrastructure that will guard SoM-based page
actions is **already built** (`src/agent/domain_tiers.ts` — `assertCanAct`
throws `BrowserToolError` with `fatal: false`). The permission model is ready;
only the CDP click/type tools need writing.

### 2c. Dual-Channel Fusion

**New orchestration in `src/agent/orchestrator.ts`** — Before the Executor
dispatches a click/type tool call targeting SoM ID N:
1. Run local VLM verification (is element N visible? any modal overlapping?)
2. If obscured → route to Evaluator for replan (cookie banner handling, etc.)
3. If clear → proceed with CDP execution

This is an **M4+ concern** — the design doc presents it as core architecture,
but the Executor hot path doesn't have CDP-based click/type tools yet (those
are the deferred M4 page-action tools), so the fusion loop has nothing to
verify against.

**Effort:** High (~5–7 days). Vision tool alone is ~1 day (OllamaClient
already supports images). SoM content script is ~1 day. Fusion orchestration
depends on M4 page-action tools that don't exist yet.

**Recommendation:** Build vision.ground as a standalone tool first (blocked
on nothing). Defer SoM + fusion until M4 page-action tools exist.

---

## 3. PII Redaction → Presidio Reversible Sandwich

### Current state (`src/agent/redact.ts`)

- 5 regex patterns: CC, SSN, PHONE, EMAIL, ADDRESS
- Applied only at `appendFinding()` persistence boundary
- Scratchpad NOT redacted (intentional — model needs raw data for current turn)
- **No de-anonymization** — replacement is irreversible `[CC]` tokens

### Design doc desired state

- **Microsoft Presidio** with NLP-based Named Entity Recognition (NER) model
- **Reversible sandwich pattern:** anonymize → process → de-anonymize
- **WebPII taxonomy extension:** order IDs, tracking codes, delivery schedules
- **Smokescreen obfuscation:** indirect details (symptoms → "a friend")
- **Ephemeral SQLite vault:** real values stored locally during session
- **Placeholders:** `<PERSON_1>`, `<EMAIL_1>`, `<ORDER_ID_1>` — reversible

### What needs to change

**`src/agent/redact.ts`** — Expand to support two-tier redaction:
- *Tier 1 (fast path, current regex):* For high-speed pre-flight screening
- *Tier 2 (NER path):* For unstructured context (names, orgs, addresses)

The NER model is the hard part — Presidio is a Python framework, not a JS
library. In an MV3 SW context, options:
1. **Run Presidio in a sidecar Python process** — defeats MV3 portability
2. **Use a local ONNX NER model** via `onnxruntime-web` (~10 MB model download)
3. **Use Ollama's own Qwen3 to detect PII** — `"Does this text contain names or
   addresses? Reply JSON."` — adds latency but zero deps
4. **Use a small NER-specific model** via Ollama (e.g., `glucoma/bert-ner`)

Recommendation: **Option 3** for M4 (simple PII detection via qwen3.5:4b,
latency acceptable since it only runs during compaction, not hot path).
Option 4 as M5 refinement if NER quality matters.

**New: `src/agent/anonymize.ts`** — Reversible substitution:
- Extract PII → map to `<PERSON_1>` placeholders
- Store mapping in an in-memory `Map<string, string>` (session scope)
- Serialize mapping to a separate IDB store for crash-recovery

**New: `src/agent/deanonymize.ts`** — Post-cloud processing:
- Scan cloud response for `<PERSON_1>` placeholders
- Replace with original values (longest-first to prevent nested collisions)
- Used by the Evaluator/DONE path (cloud returns verdicts with placeholders)

**`src/agent/state_store.ts`** — `appendFinding()` already calls
`redactPII()`. Add anon-path: if `appendFinding` is called during compaction
and the cloud processor will see the finding, use anonymize + reversible
placeholders instead of irreversible `[CC]` tokens.

**Effort:** Medium (~2–3 days) for regex-based reversible sandwich (nearest
term). High (~5+ days) for full Presidio NER integration — won't ship until
proven necessary.

---

## 4. Cloud Client (BYOK Abstraction)

### What exists

Zero. The codebase has never made an HTTPS request to a non-Ollama endpoint.
No cloud AI SDKs in `package.json`. No API key management.

### What needs to be built

**New: `src/background/cloud_client.ts`** — OpenAI-format chat completions
client:

```ts
interface CloudConfig {
  provider: 'deepseek' | 'openrouter' | 'deepinfra';
  apiKey: string;
  baseUrl: string; // per-provider override
  model: string;
}

class CloudClient {
  constructor(private config: CloudConfig) {}

  async chat(opts: CloudChatOptions): Promise<CloudChatResult> {
    // POST /v1/chat/completions with OpenAI-format body
    // Handle streaming, thinking mode, tool calls
    // Prompt caching headers:
    //   DeepSeek: X-DS-Priority: cache-read / cache-write
    //   OpenRouter: x-prompt-cache: true
  }
}
```

**New: `src/background/provider_registry.ts`** — Routes per-role requests:
```ts
const providers = {
  planner: new CloudClient({ provider: 'deepseek', model: 'deepseek-chat', ... }),
  executor: new CloudClient({ provider: 'deepseek', model: 'deepseek-chat', ... }),
  evaluator: new CloudClient({ provider: 'deepseek', model: 'deepseek-chat', ... }),
  local: ollamaClient, // for Compactor, embeddings, vision
};
```

### Key differences from OllamaClient

| Aspect | OllamaClient | CloudClient |
|--------|-------------|-------------|
| API format | Ollama `/api/chat` | OpenAI `/v1/chat/completions` |
| Auth | None | Bearer token / API key header |
| Streaming | NDJSON | Server-Sent Events (SSE) |
| Thinking | `think: true` body param | `reasoning_effort` or model-internal |
| Tool calls | Ollama native format | OpenAI `tools` array |
| Caching | `cache_prompt: true` | HTTP header-based (varies by provider) |
| Timeout | 5 min default | 30 s default |
| Retry | 1x on 5xx | Per-provider rules |

### Provider fallback

Design doc mentions Gemini 2.5 Flash-Lite and GPT-5.4 mini as alternatives.
The fallback chain should be:
1. Primary provider (DeepSeek V4-Flash, configured in settings)
2. Fallback (Gemini 2.5 Flash-Lite, configured in settings)
3. Emergency fallback — **local qwen3.5:4b** (degraded but functional)

The Orchestrator's `runPlanner/runExecutor/runEvaluator` already have a
`result.retried` flag. If cloud retry fails, fall back to local + emit a
degraded-mode event to the panel.

### API key storage

**Manifest perm:** `storage` (already have it). Store keys in
`chrome.storage.local['polaris.api_keys']` — but this is NOT encrypted at rest.
Chrome's `storage.local` is in the user's profile directory; any process with
user-level access can read it.

Medium-term: use `chrome.identity.getAuthToken` or a dedicated keychain API
if Chrome ships one. For M4, storage.local with a UI warning is acceptable.

**Effort:** Medium (~3 days). The HTTP client itself is ~200 lines. Provider
registry + fallback + key management + testing adds the rest.

---

## 5. Settings Expansion

### Current (`src/shared/messages.ts`)

```ts
interface Settings {
  ollamaBaseUrl: string;
  model: string;
  embeddingModel: string;
  enableThinking: boolean;
  plannerThinking: boolean;
  evaluatorThinking: boolean;
}
```

### Desired

```ts
interface Settings {
  // Local (unchanged)
  ollamaBaseUrl: string;
  embeddingModel: string;

  // Per-role cloud endpoints
  planner: {
    provider: 'deepseek' | 'openrouter' | 'deepinfra' | 'gemini' | 'openai';
    model: string;
    baseUrl?: string;
  };
  executor: {
    provider: string;
    model: string;
    baseUrl?: string;
    thinking: false; // always OFF
  };
  evaluator: {
    provider: string;
    model: string;
    baseUrl?: string;
  };
  compactor: {
    model: string; // still local, but configurable
  };

  // API keys (stored separately or same object? — UX choice)
  apiKeys: Record<string, string>; // provider name → key

  // Thinking toggles (now per-role, not globally)
  enableThinking: boolean;           // chat path (M1)
  plannerThinking: boolean;          // default true
  evaluatorThinking: boolean;        // default true
}
```

**Side panel UI:** Settings drawer currently has single "Model" input. Needs
expandable per-role sections, provider dropdowns, API key inputs (masked).

**Effort:** Low-medium (~1 day) for backend changes. Panel UI rework adds ~1
more day.

---

## 6. Set-of-Marks Content Script

### What needs building

**New: `extension/src/content/som.ts`** — Content script injected into
tabs the agent controls:

1. Query all interactable DOM elements:
   ```ts
   const interactables = document.querySelectorAll(
     'a, button, input, select, textarea, [role="button"], [role="link"], [role="combobox"]'
   );
   ```
2. For each, compute bounding box relative to viewport:
   ```ts
   const rect = el.getBoundingClientRect();
   const somId = nextId++;
   overlay[rect.top, rect.left, rect.width, rect.height, somId];
   ```
3. Draw lightweight semi-transparent overlays:
   - Blue box with `#1` label in corner
   - Layers are `position: fixed; pointer-events: none; z-index: 2147483647`
4. Return `somMap → { [id]: { role, text, x, y, w, h, axNodeId? } }`
5. Wire into ARIA extraction pipeline: `aria.extract` currently returns
   `SimplifiedNode[]`. Augment with `somId` field from the content script.

### Where it connects

- `src/agent/tools/browser/aria.ts` — `ariaExtractTool` currently calls
  `chrome.debugger → Accessibility.getFullAXTree`. Fuse with content-script
  SoM data by matching AXNode `backendDOMNodeId` + bounding-box overlap.
- `src/agent/tools/browser/tab.ts` — New `tab.som_overlay` message to inject
  + remove SoM overlays.

**Effort:** Medium (~2 days). The overlay rendering is straightforward. The
AXTree ↔ SoM ID fusion is the hard part — two different sources (CDP
Accessibility domain vs DOM queries) need coordinate-space alignment.

---

## 7. Page-Action Tools (M4 Dependency)

The design doc assumes CDP-based click/type tools exist. They don't. The
current toolset has `tab.open/close/list/screenshot/wait_loaded` but no:

- `tab.click(somId | selector)` — dispatch `Input.dispatchMouseEvent`
- `tab.type(somId | selector, text)` — dispatch `Input.dispatchKeyEvent`
- `tab.select(selector, value)` — for dropdowns
- `tab.hover(somId | selector)` — hover for tooltip menus

These are **blocking dependencies** for the Dual-Channel Fusion pattern and
Set-of-Marks interaction.

**Head start:** The domain-tier gating infrastructure
(`src/agent/domain_tiers.ts`) that these tools will call is already
implemented — three tiers (`read-only` / `click-only` / `full-action`),
`assertCanAct(url, requiredTier)` gate with non-fatal `BrowserToolError`,
and `chrome.storage.local` persistence. Page-action tools just need the CDP
wrappers.

**Effort:** Medium (~2 days) for the basic CDP wrappers. They're simple
`chrome.debugger.sendCommand` calls wrapped in `withBrowserTimeout`.

---

## Summary: Migration Roadmap

### Phase 1 — "Hybrid Ready" (M4.0, current sprint)
**Goal:** Architect the split without changing behavior. All roles still use
local qwen3.5:4b, but the plumbing supports per-role endpoint routing.

1. **Cloud client abstraction** (`src/background/cloud_client.ts`) — shared
   interface, no real API calls yet
2. **Orchestrator role-to-endpoint mapping** — `OrchestratorOptions` grows
   per-role endpoint config
3. **Settings expansion** — per-role model/thinking config in UI
4. **Provider registry** — routes to local OllamaClient by default
5. **Store API keys** in chrome.storage.local

**Tests:** Existing 333 tests pass unchanged (orchestrator still passes
single local client). New tests: CloudClient interface mock, endpoint
routing logic.

### Phase 2 — "Cloud Executor" (M4.1)
**Goal:** Executor + Evaluator route to DeepSeek V4-Flash on cloud; Planner
and Compactor stay local.

1. **Real CloudClient** — implements DeepSeek OpenAI-format API
2. **Executor cloud path** — `runExecutor` receives cloud client
3. **Evaluator cloud path** — `runEvaluator` receives cloud client
4. **Fallback** — auto-fallback to local on cloud failure
5. **Key management** — encrypt stored keys (chrome.storage.area, or at
   least clear warning)

**Risk:** DeepSeek V4-Flash tool-calling reliability at 6K context. Need
empirical measurement before declaring victory.

### Phase 3 — "Vision Grounding" (M4.2, concurrent with Phase 2)
**Goal:** Local VLM verification tool exists; SoM annotation on extracted
pages.

1. **`vision.ground` tool** — Ollama qwen2.5vl:3b via existing images[]
   support in OllamaClient
2. **Set-of-Marks content script** — overlay injection + removal
3. **AXTree → SoM fusion** — aria.extract augmented with SoM IDs
4. **Dual-Channel verification** — Executor consults vision.ground before
   dispatching page actions (once page-action tools exist)

### Phase 4 — "Presidio Redaction" (M4.3)
**Goal:** Reversible sandwich pattern for cloud-bound payloads.

1. **Reversible anonymize/de-anonymize** — regex-based first, NER if needed
2. **PII detection via qwen3.5** — option 3 from §3 above
3. **Anonymized cloud pipeline** — Executor/Evaluator inputs run through
   anonymize → cloud → de-anonymize
4. **UI indicators** — panel shows when PII is redacted

### Phase 5 — "Page Actions" (M4.4, or can begin earlier)
**Goal:** CDP-based click/type tools, enabling the full vision-fused loop.

1. **`tab.click` tool** — `Input.dispatchMouseEvent`
2. **`tab.type` tool** — `Input.dispatchKeyEvent`
3. **`tab.select` tool** — for dropdowns
4. **Fusion integration** — vision.ground verification before each click/type

**Note:** Domain-tier gating (item 4 in the original version) is **already
built** (`src/agent/domain_tiers.ts`). New page-action tools just call
`assertCanAct(url, requiredTier)` before dispatching — no infrastructure work
needed.
