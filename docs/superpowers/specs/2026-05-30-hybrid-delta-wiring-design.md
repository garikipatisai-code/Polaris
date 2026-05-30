# Hybrid Delta — Wiring, Page-Action Hardening, PII & Doc Reconciliation

- **Date:** 2026-05-30
- **Status:** Design — awaiting user review before `writing-plans`
- **Author:** Claude (Opus 4.8) on Mac, with Saikrishna
- **Baseline:** `origin/main` @ 29d0f68, 376 mock tests + 2 fast-tier integration green
- **Supersedes/extends:** `docs/superpowers/plans/2026-05-29-hybrid-delta-implementation.md` (Phases 1/2/4 were scaffolded but never wired; Phase 5 page-actions shipped mock-only)

## 1. Problem

The Hybrid Delta wave landed 4 of 6 phases as **scaffolding that isn't reachable at runtime**, plus a page-action capability that has **never been verified against a real browser**:

1. **Cloud routing is dead code.** `service_worker.ts` constructs `new Orchestrator({client, model})` at both sites; it never reads `settings.cloud` or builds a `CloudClient`. Worse, the cloud Executor is **doubly broken**: `CloudClient` never forwards `tools`, and `normalizeCloudResponse` drops `tool_calls` — so a cloud Executor would get zero tool calls and no-op.
2. **PII sandwich is dead code.** `anonymize`/`deanonymize` are imported only by their test. Nothing anonymizes before cloud egress. `anonymize` also has a real bug: first-occurrence-only `.replace` leaks the 2nd copy of repeated PII.
3. **Page actions are unproven.** `tab.click`/`type`/`select` exist + are registered, but all 19 tests mock `chrome.debugger`. The **preferred** click path (`backendDOMNodeId`) never calls `DOM.getDocument` before `DOM.requestNode` — a likely real-Chrome failure. Coordinate-space (scrolled pages) is also unverified. Default domain tier is `read-only`, so actions are refused until the user opts a host in.
4. **Docs drifted.** Convention #6 ("single local model") and "read-only Phase 1" are byte-identical despite the pivots; README still claims "No browsing data leaves your computer"; `probe_results.*` was overwritten with a qwen3.6 run, unbacking CLAUDE.md's qwen3.5 claims.

## 2. Goals / Non-goals

**Goals:** Make the cloud path actually reachable + correct (incl. tool-calling); enable **per-role *local* model routing** (fast `qwen3.5:4b` vs capable `qwen3.6:35b-a3b`) so we stop forcing the 4B to do reasoning it fails at and wastes tokens on; protect PII on cloud egress; harden page actions and make them provably testable; reconcile docs to reality.

**Non-goals (explicitly deferred):** SoM↔AXTree fusion (`som.ts` stays dead); routing Compactor to cloud (stays local); a provider registry / multi-provider catalog; prompt-caching headers; full-page (vs viewport) screenshots.

## 3. Locked decisions (from brainstorming)

| # | Decision |
|---|---|
| Cloud roles | Executor + Evaluator + **Planner** cloud-capable; Compactor + embeddings + vision stay local |
| Config surface | **Full per-role** provider config (per-role baseUrl/apiKey/model) + UI |
| PII point | **Cloud send boundary** — anonymize all outbound, deanonymize response |
| Probe files | **Restore qwen3.5** `probe_results.*`; keep the qwen3.6 run as `probe_results_qwen36.*` |
| Sequencing | **Page-action hardening + cloud both in this build**, one combined real-browser smoke harness at the end |
| Fallback | Include auto-fallback to local on cloud error |
| Local model routing | Per-role provider can target the fast **qwen3.5:4b**, the capable **qwen3.6:35b-a3b**, OR cloud. The role→model **distribution defaults are PENDING** the Gemini capability research + Linux-box verification (see §10). The *mechanism* lands now. |

## 4. Design

### Stream A — Page-action hardening (`actions.ts`)
- **Fix the DOM-init bug:** hoist `DOM.getDocument({depth:0})` to the top of `resolveElementCoords` so it runs for *both* paths; the `backendDOMNodeId` path's `DOM.resolveNode`→`DOM.requestNode`→`getContentQuads` then operates on an initialized DOM agent.
- **Fix coordinate-space:** call `DOM.scrollIntoViewIfNeeded({nodeId})` before `DOM.getContentQuads`, so the returned quad is within the visual viewport and the `Input.dispatchMouseEvent` viewport coordinates land correctly even on scrolled pages.
- **Tests:** assert `DOM.getDocument` precedes `resolveNode` on the backend path; assert `scrollIntoViewIfNeeded` precedes `getContentQuads`; existing 19 tests still pass.
- Doc-string + manifest staleness fixes carried along (tab.screenshot "active tab restored", activeTab comment).

### Stream B — Model routing + cloud wiring

**B0. Per-role model routing (three-tier provider).** The per-role `ProviderConfig {client, model}` already abstracts model choice — generalize so each reasoning role resolves to one of: the **default fast local model** (`qwen3.5:4b`), a **per-role local-model override** (e.g. `qwen3.6:35b-a3b` on the *same* Ollama server), or a **cloud provider**. `Settings` gains `roleModels?: { planner?, executor?, evaluator?, compactor?: string }` (local Ollama model override). Resolution precedence per role: `cloud[role]` → `CloudClient`; else `roleModels[role]` → `OllamaClient(default url)` + that model; else default `{ollama, settings.model}`. The distribution *defaults* (which model per role) are decided after research + verification (§10); only the *mechanism* lands now.

**B1. One choke point — `driveChatOnce` in `chat_driver.ts`:**
```ts
export interface DriveProvider { client: AnyClient; model: string }
export interface DriveOptions {
  messages: ChatMessage[]; tools?: ToolDef[];
  format?: 'json' | Record<string, unknown>; think?: boolean;
  timeoutMs?: number; signal?: AbortSignal;
}
export interface DriveResult extends DriverResponse { providerUsed: 'local'|'cloud'; fellBack: boolean }
export async function driveChatOnce(primary: DriveProvider, opts: DriveOptions, fallback?: DriveProvider): Promise<DriveResult>
```
- Ollama primary → `client.chatOnce({model, ...opts})` (already `DriverResponse`-shaped) → `{providerUsed:'local'}`.
- Cloud primary → the cloud path (B3 + Stream C), returning normalized `DriverResponse`.
- On cloud error that is **not** a user abort: `log('warn','cloud','falling back to local')`, retry once with `fallback` → `{providerUsed:'local', fellBack:true}`. No fallback / fallback also throws → propagate.

**B2. `CloudClient` fixes (`cloud_client.ts`):**
- Request body gains `tools` (our `ToolDef[]` is already the OpenAI tools shape — pass through) and `response_format:{type:'json_object'}` when `format==='json'`; low `temperature` default for agent calls.
- `CloudChatResponse` types gain `choices[].message.tool_calls?: {id;type;function:{name;arguments:string}}[]`.
- Honor `timeoutMs` with a shared manual-timer signal composer (extract `composeSignal` from `ollama.ts` into `background/signal.ts`, reuse in both clients — no leaked timers). Default cloud timeout 60s.

**B3. Normalization (`normalizeCloudResponse`):** map `choices[0].message.content` **and** `tool_calls`, **`JSON.parse`-ing each `function.arguments` string into an object** to match our `ToolCall` shape.

**B4. Role runners (`executor.ts`, `evaluator.ts`, `planner.ts`):** replace `(client as any).chatOnce` + `'choices' in raw` with `driveChatOnce(provider, opts, fallback)`. **Planner becomes normalization-aware** (drop its `as OllamaClient` cast). Compactor unchanged (local).

**B5. `orchestrator.ts`:** for each role, compute `fallback = providerIsCloud ? {client: defaultClient, model: defaultModel} : undefined` and pass to the runner; remove the planner `as OllamaClient` cast; keep `getProvider` resolution.

**B6. `service_worker.ts`:** at both `new Orchestrator(...)` sites, read `settings.cloud` **and `settings.roleModels`**; resolve each role per the B0 precedence (cloud → `CloudClient`; local-model-override → `OllamaClient` + override model; else default), and pass the resolved per-role providers + the local default.

**B7. Settings UI (settings drawer, side panel):** per reasoning role (Planner/Executor/Evaluator) a **"Model source" selector** — `Default (4B)` / `Local 35B (qwen3.6:35b-a3b)` / `Cloud (BYOK)`. Selecting **Local 35B** persists a model string into `settings.roleModels[role]`. Selecting **Cloud** reveals `baseUrl` (default `https://api.deepseek.com/v1`) + `apiKey` (password field) + `model` (default `deepseek-chat`), persisted into `settings.cloud[role]`. Uses the existing `settings.set`; `messages.ts` adds `roleModels?` alongside the existing `cloud?`.

### Stream C — PII sandwich + dedup fix
- **Sandwich** lives in `driveChatOnce`'s cloud path: `resetAnonymizeCounters()`, anonymize every outbound message `content` (accumulate one `map`), send; on return `deanonymize` the response `content` **and** each tool-call `arguments` JSON string (before `JSON.parse`). Local path untouched (no anonymization needed).
- **Dedup bug:** in `anonymize`, replace `result.replace(item.match, placeholder)` with `result.split(item.match).join(placeholder)` (replace-all). Add a test asserting **both** copies of repeated PII are replaced and cleartext no longer appears.

### Stream D — Docs reconciliation
- **Convention #6** → "local by default; per-role cloud BYOK is opt-in (Planner/Executor/Evaluator). Compactor/embeddings/vision stay local." Record the amendment + link the BYOK decision.
- **Read-only Phase 1** → "read by default; click/type/select are domain-tier-gated (default read-only, fail-closed; user opts a host into click-only/full-action)."
- **README** privacy line → "Runs locally by default. If you enable cloud BYOK for a role, only PII-anonymized prompts are sent to your configured provider; everything else stays local."
- **Probe:** `git show` the pre-29d0f68 `probe_results.json`/`.log` back into place; save the qwen3.6 run as `probe_results_qwen36.json`/`.log`; CLAUDE.md cites both.
- Update CLAUDE.md "Current state" + "Recent decisions" to reflect this wiring work.

### Stream E — Combined real-browser smoke harness
A runnable harness (modeled on `scripts/browser_smoke.py`) the **user** runs on real Chrome (this Mac's sandbox blocks Chrome): builds + loads the unpacked extension, opens a known local test page with a form + `<select>`, sets that host to `full-action`, then drives `tab.click` → `tab.type` → `tab.select` and asserts the DOM mutated; and (if a cloud key is configured) runs one cloud-routed Executor turn asserting a `tool_calls` round-trip. Emits a clear PASS/FAIL report. Documents that it must run outside the sandbox.

## 5. Error handling
- Cloud abort vs error: user `signal` abort → propagate, **no** fallback. Network/HTTP/timeout → fallback (if provided) then propagate.
- `assertCanAct` failures stay non-fatal (model can explain/ask for tier upgrade).
- Anonymization failure is treated as a cloud-path failure: on any `anonymize`/`deanonymize` throw, log and **fall back to the local provider**. We never send un-anonymized content to cloud (fail-closed on egress), and availability is preserved via local fallback.

## 6. Testing (TDD; `npm test` green per commit; baseline 376)
- `actions.test.ts`: +DOM.getDocument-before-resolveNode, +scrollIntoViewIfNeeded ordering.
- `cloud_client.test.ts`: +tools in body, +response_format on json, +timeout fires.
- `chat_driver.test.ts` (new): `driveChatOnce` local passthrough; cloud normalize + `tool_calls` arg-parse; PII sandwich round-trip; fallback on cloud error; no-fallback-on-abort.
- `orchestrator.test.ts`: per-role routing (cloud, local-model-override via `roleModels`, default); fallback wiring; planner cloud path.
- `anonymize.test.ts`: both-copies-removed.
- (UI) light test or manual note for the settings section.

## 7. Risks — only a real-browser run can settle
- CDP coordinate space / `getContentQuads` semantics on scrolled/zoomed pages (mitigated by `scrollIntoViewIfNeeded`, confirmed by Stream E).
- DeepSeek's tool-calling fidelity + `response_format` behavior with `deepseek-chat`.
- Whether `aria.extract`'s `backendDOMNodeId` actually round-trips to a clickable node (Stream E).

## 8. Out of scope / follow-ups
SoM fusion; compactor-on-cloud; provider registry; prompt-caching; full-page screenshots; real-vision verification on Linux.

## 9. Next step
On approval → resolve the model-distribution defaults via the §10 flow → `writing-plans` to produce the ordered, TDD task plan → implement on this feature branch.

## 10. Model-distribution research & verification (gates the distribution *defaults* only)

The routing *mechanism* (B0) is locked and implemented regardless. Which model each role defaults to follows this flow:

1. **Gemini deep research (user-run).** Capability comparison of `qwen3.5:4b` vs `qwen3.6:35b-a3b` across the four roles + Ollama multi-model swap/keep-alive behavior on the 5 GB-VRAM / 32 GB-RAM box → produces a **findings file**.
2. **Linux-box verification.** From the findings, Claude generates a **verification-guide `.md`** that the Claude CLI on the Linux/P2200 box executes — empirically testing the proposed role→model assignments (latency per role at real budgets, tool-call reliability) and the model-swap/keep-alive cost against the real hardware → returns a **results `.md`**.
3. **Decision.** Claude reviews research + empirical results and locks the role→model distribution table, which feeds the implementation defaults.

**Starting hypothesis (to be confirmed/refuted):** Planner + Evaluator → `qwen3.6:35b-a3b`; Executor + Compactor → `qwen3.5:4b`; Executor additionally cloud-capable. The observed token-waste is mostly in the Executor — a local split mainly improves plan/verdict *quality* (fewer doomed loops); Executor *reliability* still leans on cloud or better scaffolding. Open risk: model-swap thrashing when alternating a GPU-resident 4B and a CPU-spilled 35B per task.
