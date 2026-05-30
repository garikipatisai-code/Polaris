# Hybrid Delta Implementation: Build Order

> **Spec:** Maps the agreed build sequence for closing the gap between
> `docs/Polaris Hybrid Agentic Browser Design.md` and the current codebase.
> Detailed gap analysis in `docs/architecture-delta.md`.

---

## Build Order (Agreed 2026-05-29)

```
Phase 3a ──┐
Phase 5 ────┤── parallelizable first tier
            │
Phase 1 ────┘
    │
    ↓
Phase 2 ──→ Phase 3b (needs Phase 5)
    │
    ↓
Phase 4 (most valuable after cloud pipeline exists)
```

### Phase 3a: vision.ground tool (~1 day)
**Goal:** Activate the dead `images?: string[]` field in OllamaClient.
- New `src/agent/tools/browser/vision.ts` — sends screenshots to local qwen2.5vl:3b
- Register as `vision.ground` tool
- Returns structured output: element visibility, page state
- Verification layer only, not primary extraction
- Dependencies: none (OllamaClient already supports images)

### Phase 5: Page-action tools (~2 days)
**Goal:** CDP-based click/type/select wrappers for real browser interaction.
- `tab.click(somId | selector)` — `Input.dispatchMouseEvent`
- `tab.type(somId | selector, text)` — `Input.dispatchKeyEvent`
- `tab.select(selector, value)` — for dropdowns
- Each tool gates through existing `assertCanAct(url, requiredTier)`
- Dependencies: domain tiers already built

### Phase 1: Hybrid Ready infrastructure (~2 days)
**Goal:** Architect the split without changing behavior.
- `src/background/cloud_client.ts` — OpenAI-format HTTP client
- `OrchestratorOptions` per-role endpoint config (still routes to local by default)
- Settings expansion: per-role provider/model in UI
- Provider registry: `{ planner, executor, evaluator, compactor }` map
- Dependencies: none

### Phase 2: Cloud Executor (~2 days)
**Goal:** Executor + Evaluator route to DeepSeek V4-Flash.
- Real DeepSeek API integration in CloudClient
- `runExecutor`/`runEvaluator` receive cloud client
- Auto-fallback to local on cloud failure
- API key management in chrome.storage.local
- Dependencies: Phase 1

### Phase 3b: SoM + Fusion (~2 days)
**Goal:** Set-of-Marks content script + AXTree fusion.
- `src/content/som.ts` — overlay injector with numbered bounding boxes
- Coordinate-space alignment: AXTree `backendDOMNodeId` ↔ SoM bounding boxes
- Dual-Channel verification: Executor consults vision.ground before dispatching
- Dependencies: Phase 5 (page-action tools to verify against)

### Phase 4: Presidio Redaction (~2 days)
**Goal:** Reversible sandwich pattern for cloud-bound payloads.
- `src/agent/anonymize.ts` — regex `<PERSON_1>` placeholders + mapping table
- `src/agent/deanonymize.ts` — post-cloud placeholder replacement
- Expand `redact.ts` with two-tier: fast regex + qwen3.5 PII detection
- Dependencies: none, but most valuable after Phase 2

---

## Key Constraints

1. **All existing tests must pass** after each phase (333 mock + 2 fast + 4 slow)
2. **No framework dependencies** — cloud client is raw fetch(), no OpenAI SDK
3. **Domain tier gating** is pre-built — page-action tools just call `assertCanAct`
4. **vision.ground runs local only** — screenshots never leave the machine
