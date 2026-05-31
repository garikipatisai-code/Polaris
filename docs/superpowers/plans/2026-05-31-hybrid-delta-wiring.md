# Hybrid Delta Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Polaris's Hybrid Delta features actually run: harden the CDP page-action path so click/type works on real pages, wire the all-local 3-tier model routing (Planner+Evaluator→`qwen3.6:35b-a3b`, Executor+Compactor→`qwen3.5:4b`) with cloud as an opt-in per-role upgrade, route PII-anonymized payloads through the (now-correct) cloud path, and reconcile the docs to reality.

**Architecture:** Each agent role resolves to a `ProviderConfig {client, model, timeoutMs?, numPredict?}`. A single `driveChatOnce()` choke point in `chat_driver.ts` dispatches to either a local `OllamaClient` or a cloud `CloudClient`, owns the cloud tool-call/`response_format` mapping, the reversible PII sandwich, and auto-fallback to local on cloud error. A pure `buildProviders(settings, defaultClient)` function turns settings into per-role providers, with locked all-local defaults so the product works with zero cloud config. The service worker calls `buildProviders` at both Orchestrator sites.

**Tech Stack:** TypeScript, Vite + CRXJS (Chrome MV3), React (side panel), Zod, Vitest. Local inference via Ollama (`/api/chat`); cloud via raw `fetch` to an OpenAI-format endpoint. No new runtime dependencies.

**Baseline:** branch `feat/hybrid-delta-wiring`, 376 mock tests + 2 fast-tier integration green. Spec: `docs/superpowers/specs/2026-05-30-hybrid-delta-wiring-design.md` (FINALIZED). Linux verification: `extension/docs/model-distribution-verification.md`.

**Conventions for every task:** Work in `extension/`. Run `npm test` (full mock suite) at the end of each task — it must stay green and only grow. Commit after each task with the message shown. Commit identity is already `garikipatisai@gmail.com` (repo-local). Do NOT push (sandbox blocks GitHub); the user pushes.

---

## File Structure

**Created:**
- `extension/src/background/signal.ts` — `composeSignal` / `ComposedSignal` / `wasTimeout` extracted from `ollama.ts` so both clients share one leak-free timeout composer.
- `extension/src/background/providers.ts` — `buildProviders(settings, defaultClient)`: pure settings→per-role-provider resolution + the locked defaults + per-role timeout/`num_predict`.
- `extension/tests/chat_driver.test.ts` — `driveChatOnce` local passthrough, cloud tool-call normalize + arg-parse, PII sandwich round-trip, fallback-on-error, no-fallback-on-abort.
- `extension/tests/providers.test.ts` — locked-default resolution; cloud/local-override/default routing; per-role timeout/numPredict.
- `extension/scripts/browser_smoke_hybrid.py` — combined real-browser smoke harness (page actions + optional cloud-routed Executor turn). User-run, outside the sandbox.

**Modified:**
- `extension/src/agent/tools/browser/actions.ts` — hoist `DOM.getDocument`, add `DOM.scrollIntoViewIfNeeded` before `getContentQuads` (Stream A).
- `extension/src/agent/anonymize.ts` — dedup fix: `.replace` (first-only) → `.split/.join` (replace-all) (Stream C).
- `extension/src/background/cloud_client.ts` — forward `tools` + `response_format`, add `tool_calls` to response type, honor `timeoutMs` via `signal.ts` (Stream B2).
- `extension/src/background/chat_driver.ts` — `normalizeCloudResponse` maps `tool_calls` (+JSON.parse args); new `driveChatOnce` choke point (Stream B1/B3 + sandwich + fallback).
- `extension/src/background/ollama.ts` — import `composeSignal`/`wasTimeout` from `signal.ts` (remove the local copies).
- `extension/src/agent/roles/executor.ts`, `evaluator.ts`, `planner.ts` — call `driveChatOnce`; accept `timeoutMs`/`numPredict`; planner becomes `AnyClient`-aware (Stream B4).
- `extension/src/agent/orchestrator.ts` — `ProviderConfig` gains `timeoutMs?`/`numPredict?`; thread them + build the local fallback for cloud roles; drop planner cast (Stream B5).
- `extension/src/shared/messages.ts` — `Settings.roleModels?`; locked `DEFAULT_SETTINGS.roleModels` (Stream B0/B9).
- `extension/src/background/service_worker.ts` — both Orchestrator sites use `buildProviders`; pre-flight validates every configured local model is present (Stream B6).
- `extension/src/sidepanel/App.tsx` — per-role "Model source" selector in the settings drawer (Stream B7).
- `extension/tests/actions.test.ts`, `cloud_client.test.ts`, `anonymize.test.ts`, `orchestrator.test.ts` — extend for the above.
- `CLAUDE.md`, `README.md`, `probe_results.*` — docs reconciliation (Stream D).

---

## Task 1: Page-action hardening — DOM init + scroll before quads (Stream A)

Fixes the most foundational gap the user flagged ("do we really have click/type?"). The preferred `backendDOMNodeId` click path calls `DOM.resolveNode`→`DOM.requestNode` **without** `DOM.getDocument` first, which fails on a real page ("Could not find node with given id"); and `DOM.getContentQuads` on a scrolled element returns coordinates the mouse-event then misses.

**Files:**
- Modify: `extension/src/agent/tools/browser/actions.ts:346-427` (`resolveElementCoords`)
- Test: `extension/tests/actions.test.ts`

- [ ] **Step 1: Update the existing happy-path mocks to expect the new CDP calls**

In `tests/actions.test.ts`, the top-level `beforeEach` `mockSendCommand.mockImplementation` (lines 27-33) must now also answer `DOM.getDocument` and `DOM.scrollIntoViewIfNeeded` (the hardened path calls both on the backend path too). Replace that block with:

```ts
  mockSendCommand.mockImplementation(async (_target: unknown, method: string) => {
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
    if (method === 'DOM.requestNode') return { nodeId: 101 };
    if (method === 'DOM.scrollIntoViewIfNeeded') return {};
    if (method === 'DOM.getContentQuads') return { quads: [[10, 20, 100, 20, 100, 60, 10, 60]] };
    if (method === 'Input.dispatchMouseEvent') return {};
    return {};
  });
```

Also add `DOM.getDocument` + `DOM.scrollIntoViewIfNeeded` to the per-test `mockImplementation` overrides at lines 120-126 (CSS-selector test), 150-155 (no-bbox test), and 177-183 (rounding test) so they don't regress — each of those overrides currently omits one or both. Add these two lines inside each override's body:

```ts
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.scrollIntoViewIfNeeded') return {};
```

- [ ] **Step 2: Write the failing ordering tests**

Append to the `describe('tab.click', ...)` block in `tests/actions.test.ts`:

```ts
  it('calls DOM.getDocument before DOM.requestNode on the backendDOMNodeId path', async () => {
    await tabClickTool.execute(
      { tabId: 42, backendDOMNodeId: 7 },
      { taskId: 't1', stepId: null },
    );
    const order = mockSendCommand.mock.calls.map((c: unknown[]) => (c as [unknown, string])[1]);
    const docIdx = order.indexOf('DOM.getDocument');
    const reqIdx = order.indexOf('DOM.requestNode');
    expect(docIdx).toBeGreaterThanOrEqual(0);
    expect(reqIdx).toBeGreaterThanOrEqual(0);
    expect(docIdx).toBeLessThan(reqIdx);
  });

  it('calls DOM.scrollIntoViewIfNeeded before DOM.getContentQuads', async () => {
    await tabClickTool.execute(
      { tabId: 42, backendDOMNodeId: 7 },
      { taskId: 't1', stepId: null },
    );
    const order = mockSendCommand.mock.calls.map((c: unknown[]) => (c as [unknown, string])[1]);
    const scrollIdx = order.indexOf('DOM.scrollIntoViewIfNeeded');
    const quadsIdx = order.indexOf('DOM.getContentQuads');
    expect(scrollIdx).toBeGreaterThanOrEqual(0);
    expect(quadsIdx).toBeGreaterThanOrEqual(0);
    expect(scrollIdx).toBeLessThan(quadsIdx);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/actions.test.ts`
Expected: the two new tests FAIL (`DOM.getDocument`/`DOM.scrollIntoViewIfNeeded` not found in call order, i.e. index `-1`).

- [ ] **Step 4: Harden `resolveElementCoords`**

In `actions.ts`, replace the body of `resolveElementCoords` (the part from `const target` through the `nodeId` resolution and the quads fetch). The new sequence: (1) always `DOM.getDocument` first; (2) resolve `nodeId` via backend or selector path; (3) best-effort `DOM.scrollIntoViewIfNeeded`; (4) `DOM.getContentQuads`. Replace lines 353-410 with:

```ts
  const target: { tabId: number } = { tabId };

  // (1) Initialize the DOM agent for THIS session. Required before any
  // DOM.requestNode / DOM.querySelector call — on a real page the
  // backendDOMNodeId path otherwise fails with "Could not find node with
  // given id". The selector path also reuses this document node.
  const docResult = await chrome.debugger.sendCommand(target, 'DOM.getDocument', { depth: 0 });
  const documentNodeId = (docResult as { root?: { nodeId: number } })?.root?.nodeId;
  if (typeof documentNodeId !== 'number') {
    throw new BrowserToolError('tab.click: could not get document', { fatal: true });
  }

  // (2) Resolve to a DOM nodeId.
  let nodeId: number;
  if (backendDOMNodeId !== undefined) {
    // Path 1: resolve from backendDOMNodeId (from the ARIA tree).
    const resolveResult = await chrome.debugger.sendCommand(target, 'DOM.resolveNode', {
      backendNodeId: backendDOMNodeId,
    }) as { object?: { objectId?: string } } | undefined;
    if (!resolveResult?.object?.objectId) {
      throw new BrowserToolError(
        `tab.click: could not resolve backendDOMNodeId ${backendDOMNodeId}`,
        { fatal: false },
      );
    }
    const domResult = await chrome.debugger.sendCommand(target, 'DOM.requestNode', {
      objectId: resolveResult.object.objectId,
    }) as { nodeId?: number } | undefined;
    if (typeof domResult?.nodeId !== 'number') {
      throw new BrowserToolError(
        `tab.click: could not request node for backendDOMNodeId ${backendDOMNodeId}`,
        { fatal: false },
      );
    }
    nodeId = domResult.nodeId;
  } else if (selector) {
    // Path 2: fallback to CSS selector against the document node from (1).
    const queryResult = await chrome.debugger.sendCommand(target, 'DOM.querySelector', {
      nodeId: documentNodeId,
      selector,
    });
    if (
      typeof (queryResult as { nodeId: number })?.nodeId !== 'number' ||
      (queryResult as { nodeId: number }).nodeId === 0
    ) {
      throw new BrowserToolError(
        `tab.click: selector "${selector}" matched no elements`,
        { fatal: false },
      );
    }
    nodeId = (queryResult as { nodeId: number }).nodeId;
  } else {
    // Should be unreachable because argsSchema.refine enforces at least one.
    throw new BrowserToolError('tab.click: no backendDOMNodeId or selector provided', {
      fatal: false,
    });
  }

  // (3) Bring the element into the viewport BEFORE measuring it. getContentQuads
  // returns viewport-relative coordinates; an element below the fold would
  // otherwise yield a quad the mouse event misses. Best-effort: some nodes
  // (e.g. detached) can't scroll — don't fail the click over it.
  try {
    await chrome.debugger.sendCommand(target, 'DOM.scrollIntoViewIfNeeded', { nodeId });
  } catch {
    /* best-effort: element may not support scrollIntoView */
  }

  // (4) Bounding box via DOM.getContentQuads.
  const quadsResult = await chrome.debugger.sendCommand(target, 'DOM.getContentQuads', { nodeId });
  const quads = (quadsResult as { quads?: number[][] })?.quads;
  if (!quads || quads.length === 0) {
    throw new BrowserToolError('tab.click: element has no visible bounding box', { fatal: false });
  }
```

Leave the quad-center math (lines 412-426) unchanged.

- [ ] **Step 5: Run the full action suite to verify it passes**

Run: `npx vitest run tests/actions.test.ts`
Expected: PASS (all prior tests + the 2 new ordering tests). If a prior test fails on a missing `DOM.getDocument`/`scrollIntoViewIfNeeded` mock, finish updating that test's override per Step 1.

- [ ] **Step 6: Run the whole suite + commit**

Run: `npm test`
Expected: 378 passed (376 baseline + 2).

```bash
git add src/agent/tools/browser/actions.ts tests/actions.test.ts
git commit -m "fix(actions): init DOM agent + scrollIntoView before getContentQuads

The preferred backendDOMNodeId click path called DOM.resolveNode/requestNode
without DOM.getDocument first (real-Chrome 'could not find node'), and
getContentQuads on a scrolled element returned coords the mouse event missed.
Hoist DOM.getDocument to run for both resolution paths; scrollIntoViewIfNeeded
before measuring. Mocks updated; +2 ordering tests."
```

---

## Task 2: Extract `composeSignal` into a shared module (Stream B2 prep)

`composeSignal`/`ComposedSignal`/`wasTimeout` are private to `ollama.ts`. The cloud client needs the same leak-free timeout composer. Extract them verbatim into `signal.ts` and re-import — no behavior change.

**Files:**
- Create: `extension/src/background/signal.ts`
- Modify: `extension/src/background/ollama.ts:87-157` (remove local defs, import instead)

- [ ] **Step 1: Create `signal.ts` with the extracted code**

Create `extension/src/background/signal.ts`:

```ts
// Leak-free AbortSignal composition shared by OllamaClient and CloudClient.
//
// Composes a user-supplied AbortSignal with a manual timeout and returns the
// combined signal PLUS a cleanup() the caller MUST invoke in a finally block.
// Implemented as a manual setTimeout/clearTimeout pair (not AbortSignal.timeout,
// whose timer can't be cancelled when the request completes early) so a fast
// call doesn't leave a zombie timer queued for the full timeout window.

export interface ComposedSignal {
  signal: AbortSignal;
  cleanup: () => void;
}

export function composeSignal(
  userSignal: AbortSignal | undefined,
  timeoutMs: number,
): ComposedSignal {
  const ctrl = new AbortController();
  const cleanups: Array<() => void> = [];

  if (userSignal) {
    if (userSignal.aborted) {
      ctrl.abort(userSignal.reason);
    } else {
      const onAbort = (): void => {
        if (!ctrl.signal.aborted) ctrl.abort(userSignal.reason);
      };
      userSignal.addEventListener('abort', onAbort, { once: true });
      cleanups.push(() => userSignal.removeEventListener('abort', onAbort));
    }
  }

  if (timeoutMs > 0 && !ctrl.signal.aborted) {
    const timer = setTimeout(() => {
      if (!ctrl.signal.aborted) {
        const err =
          typeof DOMException !== 'undefined'
            ? new DOMException(`timed out after ${timeoutMs}ms`, 'TimeoutError')
            : Object.assign(new Error(`timed out after ${timeoutMs}ms`), { name: 'TimeoutError' });
        ctrl.abort(err);
      }
    }, timeoutMs);
    cleanups.push(() => clearTimeout(timer));
  }

  return {
    signal: ctrl.signal,
    cleanup: () => {
      for (const fn of cleanups) {
        try { fn(); } catch { /* defensive */ }
      }
    },
  };
}

/** True if an AbortError came from a timeout signal rather than a user abort. */
export function wasTimeout(e: unknown): boolean {
  const err = e as { name?: string; cause?: { name?: string } } | null;
  if (!err) return false;
  if (err.name === 'TimeoutError') return true;
  return err.cause?.name === 'TimeoutError';
}
```

- [ ] **Step 2: Update `ollama.ts` to import from `signal.ts`**

In `ollama.ts`: (a) add `import { composeSignal, wasTimeout, type ComposedSignal } from './signal';` near the top imports; (b) delete the local `interface ComposedSignal { ... }` (lines ~100-103), the local `function composeSignal(...) { ... }` (lines ~105-149), and the local `export function wasTimeout(...) { ... }` (lines ~151-157); (c) re-export `wasTimeout` for existing importers by adding `export { wasTimeout };` where the old export was (other modules import `wasTimeout` from `./ollama`).

- [ ] **Step 3: Run the Ollama + full suite to verify no regression**

Run: `npx vitest run tests/ollama.test.ts && npm test`
Expected: all green (still 378). The timer-leak tests in `ollama.test.ts` still pass — same implementation, new home.

- [ ] **Step 4: Commit**

```bash
git add src/background/signal.ts src/background/ollama.ts
git commit -m "refactor: extract composeSignal/wasTimeout into background/signal.ts

Shared, leak-free timeout composer so CloudClient can reuse the exact
OllamaClient pattern. Pure move; behavior unchanged; ollama.ts re-exports
wasTimeout for existing importers."
```

---

## Task 3: CloudClient — forward tools + response_format + honor timeout (Stream B2)

The cloud Executor can't produce tool calls because `CloudClient.chatOnce` never sends `tools`; it also ignores `format:'json'` and `timeoutMs`. Fix all three.

**Files:**
- Modify: `extension/src/background/cloud_client.ts`
- Test: `extension/tests/cloud_client.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/cloud_client.test.ts` (inside `describe('CloudClient', ...)`):

```ts
  it('forwards tools and response_format in the request body', async () => {
    mockFetch.mockResolvedValue({ ok: true, text: vi.fn(), json: vi.fn().mockResolvedValue(sampleResponse) });
    const client = new CloudClient('https://api.example.com/v1', 'sk-test');
    const tools = [{ type: 'function' as const, function: { name: 'add', description: 'x', parameters: { type: 'object', properties: {} } } }];
    await client.chatOnce({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], apiKey: 'sk-test', tools, responseFormatJson: true });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.tools).toEqual(tools);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('parses tool_calls from the response', async () => {
    const toolResp = {
      id: 'c1',
      choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'add', arguments: '{"a":1}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    };
    mockFetch.mockResolvedValue({ ok: true, text: vi.fn(), json: vi.fn().mockResolvedValue(toolResp) });
    const client = new CloudClient();
    const result = await client.chatOnce({ model: 'm', messages: [], apiKey: 'k' });
    expect(result.choices[0].message.tool_calls?.[0].function.name).toBe('add');
    expect(result.choices[0].message.tool_calls?.[0].function.arguments).toBe('{"a":1}');
  });

  it('aborts after timeoutMs', async () => {
    // fetch never resolves; the composed timeout signal must abort it.
    mockFetch.mockImplementation((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    );
    const client = new CloudClient();
    await expect(
      client.chatOnce({ model: 'm', messages: [], apiKey: 'k', timeoutMs: 10 }),
    ).rejects.toThrow(/timed out/);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/cloud_client.test.ts`
Expected: the 3 new tests FAIL (`body.tools` undefined; `tool_calls` undefined; no timeout error).

- [ ] **Step 3: Implement the CloudClient fixes**

In `cloud_client.ts`:

(a) Add the import: `import { composeSignal, wasTimeout } from './signal';` and `import type { ToolDef } from './ollama';`.

(b) Extend `CloudMessage` to carry tool calls on responses:

```ts
export interface CloudMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: { id?: string; type?: string; function: { name: string; arguments: string } }[];
}
```

(c) Extend `CloudChatOptions` with the new inputs:

```ts
export interface CloudChatOptions {
  model: string;
  messages: CloudMessage[];
  apiKey: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Forwarded as OpenAI `tools`. Our ToolDef IS the OpenAI tools shape. */
  tools?: ToolDef[];
  /** When true, sets response_format:{type:'json_object'}. */
  responseFormatJson?: boolean;
}
```

(d) Add a default cloud timeout constant near the top of the file:

```ts
/** Cloud calls are fast (hosted API); 60s covers a slow tool-calling completion. */
export const DEFAULT_CLOUD_TIMEOUT_MS = 60_000;
```

(e) Rewrite the `chatOnce` body construction + fetch to include tools/response_format and a composed timeout. Replace the `const res = await fetch(...)` block (lines 51-65) and the surrounding flow with:

```ts
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 4096,
      stream: false,
    };
    if (opts.tools && opts.tools.length) body.tools = opts.tools;
    if (opts.responseFormatJson) body.response_format = { type: 'json_object' };

    const timeoutMs = opts.timeoutMs ?? DEFAULT_CLOUD_TIMEOUT_MS;
    const composed = composeSignal(opts.signal, timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: composed.signal,
      });
    } catch (e) {
      composed.cleanup();
      if (wasTimeout(e)) {
        const tErr = new Error(`Cloud chat timed out after ${timeoutMs}ms`);
        tErr.name = 'TimeoutError';
        throw tErr;
      }
      throw e;
    }
```

Then change the existing `if (!res.ok)` and JSON-parse tail so the `composed.cleanup()` runs after the body is read. Concretely, wrap the remainder (from `if (!res.ok)` through `return data;`) in a `try { ... } finally { composed.cleanup(); }`. The `temperature`/`maxTokens` are now in `body`, so delete the old inline `body:` object passed to fetch.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/cloud_client.test.ts`
Expected: PASS (prior 4 + new 3). The original "chatOnce returns parsed response" test still passes — `body.model`/`body.stream` are unchanged.

- [ ] **Step 5: Full suite + commit**

Run: `npm test`
Expected: 381 passed.

```bash
git add src/background/cloud_client.ts tests/cloud_client.test.ts
git commit -m "fix(cloud): forward tools + response_format, honor timeoutMs

CloudClient.chatOnce now sends OpenAI tools (our ToolDef is already that
shape), maps format:'json' -> response_format:{type:'json_object'}, parses
tool_calls on the response, and composes a 60s default timeout via signal.ts.
Without tools forwarding a cloud Executor produced zero tool calls. +3 tests."
```

---

## Task 4: `normalizeCloudResponse` maps tool_calls (Stream B3)

`normalizeCloudResponse` drops `tool_calls`, so even with Task 3 a cloud response wouldn't reach the role as a tool call. Map them and `JSON.parse` the argument strings into objects (our `DriverResponse.tool_calls[].function.arguments` is `Record<string, unknown>`).

**Files:**
- Modify: `extension/src/background/chat_driver.ts:28-38`
- Test: `extension/tests/chat_driver.test.ts` (created here)

- [ ] **Step 1: Write the failing test**

Create `extension/tests/chat_driver.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizeCloudResponse } from '../src/background/chat_driver';
import type { CloudChatResponse } from '../src/background/cloud_client';

describe('normalizeCloudResponse', () => {
  it('maps content + usage', () => {
    const resp = {
      id: 'c1',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    } as CloudChatResponse;
    const d = normalizeCloudResponse(resp);
    expect(d.message?.content).toBe('hello');
    expect(d.prompt_eval_count).toBe(10);
    expect(d.eval_count).toBe(4);
    expect(d.message?.tool_calls).toBeUndefined();
  });

  it('maps tool_calls and JSON.parses the arguments string', () => {
    const resp = {
      id: 'c1',
      choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [
        { id: 't1', type: 'function', function: { name: 'add', arguments: '{"a":2,"b":3}' } },
      ] } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    } as CloudChatResponse;
    const d = normalizeCloudResponse(resp);
    expect(d.message?.tool_calls?.[0].function.name).toBe('add');
    expect(d.message?.tool_calls?.[0].function.arguments).toEqual({ a: 2, b: 3 });
  });

  it('tolerates malformed argument JSON (-> empty object)', () => {
    const resp = {
      id: 'c1',
      choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [
        { id: 't1', type: 'function', function: { name: 'x', arguments: 'not json' } },
      ] } }],
    } as CloudChatResponse;
    const d = normalizeCloudResponse(resp);
    expect(d.message?.tool_calls?.[0].function.arguments).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/chat_driver.test.ts`
Expected: the tool_calls tests FAIL (`tool_calls` is undefined in current output).

- [ ] **Step 3: Implement**

In `chat_driver.ts`, replace `normalizeCloudResponse` (lines 28-38) with:

```ts
export function normalizeCloudResponse(
  response: import('./cloud_client').CloudChatResponse,
): DriverResponse {
  const msg = response.choices[0]?.message;
  const toolCalls = msg?.tool_calls?.map((tc) => ({
    function: {
      name: tc.function.name,
      arguments: safeParseArgs(tc.function.arguments),
    },
  }));
  return {
    message: {
      content: msg?.content,
      ...(toolCalls && toolCalls.length ? { tool_calls: toolCalls } : {}),
    },
    prompt_eval_count: response.usage?.prompt_tokens,
    eval_count: response.usage?.completion_tokens,
  };
}

/** Parse an OpenAI tool-call arguments string into an object; {} on failure. */
function safeParseArgs(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/chat_driver.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Full suite + commit**

Run: `npm test`
Expected: 384 passed.

```bash
git add src/background/chat_driver.ts tests/chat_driver.test.ts
git commit -m "fix(driver): normalizeCloudResponse maps tool_calls + parses args

Cloud tool_calls were dropped, so a cloud Executor saw zero tool calls.
Map choices[0].message.tool_calls, JSON.parse the arguments string into the
Record shape DriverResponse expects; malformed args -> {}. +3 tests."
```

---

## Task 5: Anonymize dedup fix — replace-all (Stream C)

`anonymize` uses `result.replace(item.match, placeholder)` which replaces only the **first** occurrence; the `seen` set then skips the duplicate, so the 2nd copy of repeated PII leaks in cleartext. The existing dedup test only checks the placeholder is present, never that the cleartext is gone.

**Files:**
- Modify: `extension/src/agent/anonymize.ts:48-56`
- Test: `extension/tests/anonymize.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/anonymize.test.ts` (inside the existing `describe`):

```ts
  it('replaces BOTH copies of repeated PII (no cleartext leak)', () => {
    const { text } = anonymize('x@y.com is same as x@y.com');
    // The literal email must not survive anywhere in the anonymized text.
    expect(text).not.toContain('x@y.com');
    // Both positions collapse to the same single placeholder.
    expect(text).toBe('<EMAIL_1> is same as <EMAIL_1>');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/anonymize.test.ts`
Expected: FAIL — current output is `'<EMAIL_1> is same as x@y.com'` (second copy leaks).

- [ ] **Step 3: Implement the replace-all fix**

In `anonymize.ts`, replace line 54:

```ts
    // Replace only the first occurrence (others of the same value handled via `seen`)
    result = result.replace(item.match, placeholder);
```

with:

```ts
    // Replace ALL occurrences of this exact value. `.replace(string, ...)` only
    // hits the first match — split/join is a literal replace-all (no regex
    // escaping needed) so a repeated PII value can't leak its 2nd copy.
    result = result.split(item.match).join(placeholder);
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/anonymize.test.ts`
Expected: PASS (prior 8 + new 1). The existing "deduplicates repeated identical PII" test still passes (still 1 map key).

- [ ] **Step 5: Full suite + commit**

Run: `npm test`
Expected: 385 passed.

```bash
git add src/agent/anonymize.ts tests/anonymize.test.ts
git commit -m "fix(anonymize): replace ALL occurrences of repeated PII

.replace(str,...) only replaced the first occurrence; the dedup `seen` guard
then skipped the rest, leaking the 2nd copy in cleartext. split/join =
literal replace-all. +1 test asserting no cleartext survives."
```

---

## Task 6: `driveChatOnce` choke point — dispatch + PII sandwich + fallback (Stream B1)

The single place that owns: local-vs-cloud dispatch, cloud tools/`response_format`, the anonymize→deanonymize sandwich, and auto-fallback to local on cloud error. Roles call this instead of `(client as any).chatOnce`.

**Files:**
- Modify: `extension/src/background/chat_driver.ts`
- Test: `extension/tests/chat_driver.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/chat_driver.test.ts`:

```ts
import { driveChatOnce } from '../src/background/chat_driver';
import { CloudClient } from '../src/background/cloud_client';
import { resetAnonymizeCounters } from '../src/agent/anonymize';

describe('driveChatOnce', () => {
  it('local provider: passes through chatOnce result as DriverResponse', async () => {
    const fake = {
      chatOnce: async (opts: { model: string }) => ({
        message: { content: `ok:${opts.model}` },
        prompt_eval_count: 11,
        eval_count: 3,
      }),
    };
    const r = await driveChatOnce(
      { client: fake as never, model: 'qwen3.5:4b' },
      { messages: [{ role: 'user', content: 'hi' }] },
    );
    expect(r.providerUsed).toBe('local');
    expect(r.fellBack).toBe(false);
    expect(r.message?.content).toBe('ok:qwen3.5:4b');
  });

  it('cloud provider: anonymizes outbound, deanonymizes response (sandwich)', async () => {
    resetAnonymizeCounters();
    const cloud = new CloudClient('https://api.example.com/v1', 'sk');
    // Echo the anonymized content back so we can verify deanonymization restores it.
    vi.spyOn(cloud, 'chatOnce').mockImplementation(async (opts) => {
      const sent = opts.messages.map((m) => m.content).join(' | ');
      // The outbound content must NOT contain the raw email.
      expect(sent).not.toContain('alice@example.com');
      expect(sent).toContain('<EMAIL_1>');
      return {
        id: 'c1',
        choices: [{ index: 0, message: { role: 'assistant', content: `noted <EMAIL_1>` } }],
        usage: { prompt_tokens: 7, completion_tokens: 2 },
      };
    });
    const r = await driveChatOnce(
      { client: cloud, model: 'deepseek-chat' },
      { messages: [{ role: 'user', content: 'email alice@example.com' }] },
    );
    expect(r.providerUsed).toBe('cloud');
    // Response placeholder restored to the original.
    expect(r.message?.content).toBe('noted alice@example.com');
  });

  it('cloud error: falls back to the local provider', async () => {
    const cloud = new CloudClient();
    vi.spyOn(cloud, 'chatOnce').mockRejectedValue(new Error('Cloud API HTTP 503'));
    const localFake = {
      chatOnce: async () => ({ message: { content: 'local-answer' }, prompt_eval_count: 1, eval_count: 1 }),
    };
    const r = await driveChatOnce(
      { client: cloud, model: 'deepseek-chat' },
      { messages: [{ role: 'user', content: 'hi' }] },
      { client: localFake as never, model: 'qwen3.5:4b' },
    );
    expect(r.providerUsed).toBe('local');
    expect(r.fellBack).toBe(true);
    expect(r.message?.content).toBe('local-answer');
  });

  it('cloud user-abort: propagates, does NOT fall back', async () => {
    const cloud = new CloudClient();
    vi.spyOn(cloud, 'chatOnce').mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const localFake = { chatOnce: async () => ({ message: { content: 'should-not-run' } }) };
    await expect(
      driveChatOnce(
        { client: cloud, model: 'deepseek-chat' },
        { messages: [{ role: 'user', content: 'hi' }] },
        { client: localFake as never, model: 'qwen3.5:4b' },
      ),
    ).rejects.toThrow('aborted');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/chat_driver.test.ts`
Expected: the `driveChatOnce` block FAILS to import (`driveChatOnce is not a function`).

- [ ] **Step 3: Implement `driveChatOnce`**

In `chat_driver.ts`: change the type-only imports to bring in the concrete `CloudClient` (for `instanceof`) and the helpers, and append the function. Update the top of the file:

```ts
import type { OllamaClient, ChatMessage, ToolDef } from './ollama';
import { wasTimeout } from './ollama';
import { CloudClient } from './cloud_client';
import type { CloudMessage } from './cloud_client';
import { anonymize } from '../agent/anonymize';
import { deanonymize } from '../agent/deanonymize';
import { log } from '../agent/log';
```

(Keep the existing `export type AnyClient = OllamaClient | CloudClient;` and `DriverResponse`.) Append:

```ts
export interface DriveProvider {
  client: AnyClient;
  model: string;
  /** Per-provider timeout override (ms). 35B local roles need a big one. */
  timeoutMs?: number;
  /** num_predict for local thinking roles on the 35B (else thinking eats the budget). */
  numPredict?: number;
}

export interface DriveOptions {
  messages: ChatMessage[];
  tools?: ToolDef[];
  format?: 'json' | Record<string, unknown>;
  think?: boolean;
  signal?: AbortSignal;
}

export interface DriveResult extends DriverResponse {
  providerUsed: 'local' | 'cloud';
  fellBack: boolean;
}

/**
 * Single choke point for routing a role's chat call to a local OllamaClient
 * or a cloud CloudClient. Owns: cloud tools/response_format mapping, the
 * reversible PII sandwich (anonymize outbound / deanonymize response), and
 * auto-fallback to a local provider on cloud network/HTTP/timeout error
 * (NOT on user abort).
 */
export async function driveChatOnce(
  primary: DriveProvider,
  opts: DriveOptions,
  fallback?: DriveProvider,
): Promise<DriveResult> {
  if (!(primary.client instanceof CloudClient)) {
    // Local path — OllamaClient.chatOnce is already DriverResponse-shaped.
    const resp = await (primary.client as OllamaClient).chatOnce({
      model: primary.model,
      messages: opts.messages,
      tools: opts.tools,
      format: opts.format,
      think: opts.think,
      signal: opts.signal,
      timeoutMs: primary.timeoutMs,
      options: primary.numPredict ? { num_predict: primary.numPredict } : undefined,
    });
    return { ...resp, providerUsed: 'local', fellBack: false };
  }

  // Cloud path.
  const cloud = primary.client;
  try {
    // (1) Anonymize every outbound message content; accumulate one map.
    const map: Record<string, string> = {};
    const cloudMessages: CloudMessage[] = opts.messages.map((m) => {
      const { text, map: m2 } = anonymize(m.content);
      Object.assign(map, m2);
      const role = m.role === 'system' || m.role === 'assistant' ? m.role : 'user';
      return { role, content: text };
    });

    // (2) Call cloud with tools + json mapping + the provider timeout.
    const raw = await cloud.chatOnce({
      model: primary.model,
      messages: cloudMessages,
      apiKey: '', // CloudClient falls back to its baked-in defaultApiKey
      tools: opts.tools,
      responseFormatJson: opts.format === 'json',
      signal: opts.signal,
      timeoutMs: primary.timeoutMs,
    });

    // (3) Deanonymize response strings BEFORE normalize parses the args.
    const respMsg = raw.choices[0]?.message;
    if (respMsg) {
      if (respMsg.content) respMsg.content = deanonymize(respMsg.content, map);
      if (respMsg.tool_calls) {
        for (const tc of respMsg.tool_calls) {
          tc.function.arguments = deanonymize(tc.function.arguments, map);
        }
      }
    }
    const normalized = normalizeCloudResponse(raw);
    return { ...normalized, providerUsed: 'cloud', fellBack: false };
  } catch (e) {
    const err = e as Error;
    // User abort propagates with no fallback. Timeout / network / HTTP / an
    // anonymize throw are all treated as cloud-path failures -> fall back.
    const isUserAbort = err.name === 'AbortError' && !wasTimeout(e);
    if (isUserAbort || !fallback) throw e;
    log('warn', 'cloud', 'cloud call failed — falling back to local', { error: err.message?.slice(0, 200) });
    const resp = await (fallback.client as OllamaClient).chatOnce({
      model: fallback.model,
      messages: opts.messages,
      tools: opts.tools,
      format: opts.format,
      think: opts.think,
      signal: opts.signal,
      timeoutMs: fallback.timeoutMs,
      options: fallback.numPredict ? { num_predict: fallback.numPredict } : undefined,
    });
    return { ...resp, providerUsed: 'local', fellBack: true };
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/chat_driver.test.ts`
Expected: PASS (normalize 3 + driveChatOnce 4).

- [ ] **Step 5: Full suite + commit**

Run: `npm test`
Expected: 389 passed.

```bash
git add src/background/chat_driver.ts tests/chat_driver.test.ts
git commit -m "feat(driver): driveChatOnce choke point — dispatch + PII sandwich + fallback

One entry point owns local/cloud dispatch (instanceof CloudClient), cloud
tools/response_format, the anonymize->deanonymize sandwich (fail-closed on
egress), and auto-fallback to local on cloud error/timeout (NOT on user
abort). +4 tests."
```

---

## Task 7: Route roles through `driveChatOnce` + accept timeout/numPredict (Stream B4)

Replace the scattered `(client as any).chatOnce` + `'choices' in raw` in executor/evaluator with `driveChatOnce`; make planner `AnyClient`-aware; thread `timeoutMs`/`numPredict` from the provider into the call.

**Files:**
- Modify: `extension/src/agent/roles/executor.ts`, `evaluator.ts`, `planner.ts`
- Verified by: existing `tests/orchestrator.test.ts` (the FakeOllamaClient is not a CloudClient → local path, unchanged behavior).

- [ ] **Step 1: Executor — use driveChatOnce**

In `executor.ts`: (a) update imports — remove `normalizeCloudResponse`, add `driveChatOnce`; keep the `OllamaClient | CloudClient` client type. (b) Extend `ExecutorInput` with `timeoutMs?: number;` and `numPredict?: number;`. (c) Replace the first-attempt block (lines 82-96) with:

```ts
  const provider = { client, model, timeoutMs: input.timeoutMs, numPredict: input.numPredict };
  const firstResult = await driveChatOnce(provider, {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userAnchor },
    ],
    tools: toolDefs,
    think: false,
    signal,
  });
  const first: DriverResponse = firstResult;
```

(d) In the retry block (lines 128-137), replace the `const rawSecond = await (client as any).chatOnce({...})` + normalize with:

```ts
    const secondResult = await driveChatOnce(provider, {
      messages: retryMessages,
      tools: toolDefs,
      think: false,
      signal,
    });
    const second: DriverResponse = secondResult;
```

(Keep `import type { DriverResponse }` — `DriveResult extends DriverResponse`, so the assignment is valid.)

- [ ] **Step 2: Evaluator — use driveChatOnce**

In `evaluator.ts`: (a) imports — drop `normalizeCloudResponse`, add `driveChatOnce`. (b) Extend `EvaluatorInput` with `timeoutMs?: number;` and `numPredict?: number;`. (c) Replace the init call (lines 88-100) with:

```ts
  const provider = { client, model, timeoutMs: input.timeoutMs, numPredict: input.numPredict };
  const firstResp: DriverResponse = await driveChatOnce(provider, {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userAnchor },
    ],
    format: 'json',
    think: thinkingMode,
    signal,
  });
```

(d) Replace the retry call (lines 132-141) with:

```ts
    const retryResp: DriverResponse = await driveChatOnce(provider, {
      messages: retryMessages,
      format: 'json',
      think: false,
      signal,
    });
```

- [ ] **Step 3: Planner — become AnyClient-aware**

In `planner.ts`: (a) imports — add `import type { AnyClient } from '../../background/chat_driver';` and `import { driveChatOnce } from '../../background/chat_driver';`; keep `import type { OllamaClient }` only if still referenced (it isn't after this — remove it). (b) Change `PlannerInput.client` from `OllamaClient` to `AnyClient`; add `timeoutMs?: number;` and `numPredict?: number;`. (c) Replace the first attempt (lines 99-108) with:

```ts
  const provider = { client, model, timeoutMs: input.timeoutMs, numPredict: input.numPredict };
  let response = await driveChatOnce(provider, {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userAnchor },
    ],
    format: 'json',
    think: thinkingMode,
    signal,
  });
```

(d) Replace the retry (lines 144-150) with:

```ts
    response = await driveChatOnce(provider, {
      messages: retryMessages,
      format: 'json',
      think: false,
      signal,
    });
```

`response.prompt_eval_count` / `eval_count` / `message?.content` all still exist on `DriveResult` (extends `DriverResponse`).

- [ ] **Step 4: Run the orchestrator + role suites to verify no behavior change**

Run: `npx vitest run tests/orchestrator.test.ts tests/role_retry_pattern.test.ts`
Expected: PASS. The FakeOllamaClient is not a `CloudClient` instance, so `driveChatOnce` takes the local path and calls `client.chatOnce` exactly as before. If `role_retry_pattern.test.ts` asserts on the message array shape, confirm the `messages`/`tools`/`think` it sees are unchanged (they are — same fields, now passed via DriveOptions).

- [ ] **Step 5: Full suite + commit**

Run: `npm test`
Expected: 389 passed (no new tests; refactor covered by existing suite).

```bash
git add src/agent/roles/executor.ts src/agent/roles/evaluator.ts src/agent/roles/planner.ts
git commit -m "refactor(roles): route executor/evaluator/planner through driveChatOnce

Replaces scattered (client as any).chatOnce + 'choices' in raw with the
driveChatOnce choke point. Planner is now AnyClient-aware (drops its
OllamaClient assumption). Roles accept per-provider timeoutMs/numPredict and
forward them. Compactor stays local/unchanged."
```

---

## Task 8: Orchestrator threads timeout/numPredict + builds the cloud fallback (Stream B5)

`ProviderConfig` carries the per-role timeout/numPredict; the orchestrator passes them to each role and, for any cloud role, passes the local default as the fallback. Remove the now-unneeded planner cast.

**Files:**
- Modify: `extension/src/agent/orchestrator.ts`
- Test: `extension/tests/orchestrator.test.ts`

- [ ] **Step 1: Write the failing routing test**

The FakeOllamaClient must record the model it was called with, per role. In `tests/orchestrator.test.ts`, extend `FakeOllamaClient.chatOnce` to record the model and add a getter. Change the `callLog` type and the push:

```ts
  public callLog: { role: Role; model: string; idx: number }[] = [];
```
and inside `chatOnce`, change the push to:
```ts
    this.callLog.push({ role, model: opts.model, idx: this.callLog.length });
```

Then append a test:

```ts
describe('orchestrator: per-role model routing', () => {
  it('routes each role to its provider model (planner override, executor default)', async () => {
    const fake = new FakeOllamaClient({
      planner: [plannerR({ rootSteps: [{ id: 's1', title: 'echo then finish' }] })],
      executor: [
        execR({ name: 'echo', arguments: { text: 'hi' } }),
        execR({ name: 'finish', arguments: { summary: 'ok' } }),
      ],
      evaluator: [evalR('done', { finalAnswer: 'ok', reason: 'v' })],
    });

    const orchestrator = new Orchestrator({
      defaultProvider: { client: fake as unknown as OllamaClient, model: 'qwen3.5:4b' },
      plannerProvider: { client: fake as unknown as OllamaClient, model: 'qwen3.6:35b-a3b', timeoutMs: 1500000, numPredict: 2048 },
      evaluatorProvider: { client: fake as unknown as OllamaClient, model: 'qwen3.6:35b-a3b', timeoutMs: 720000, numPredict: 2048 },
      plannerThinking: false,
      evaluatorThinking: false,
    });

    await orchestrator.start('routing test');
    const final = await orchestrator.runUntilTerminal();
    expect(final.phase).toBe('DONE');

    const byRole = (r: Role) => fake.callLog.filter((c) => c.role === r).map((c) => c.model);
    expect(byRole('planner').every((m) => m === 'qwen3.6:35b-a3b')).toBe(true);
    expect(byRole('evaluator').every((m) => m === 'qwen3.6:35b-a3b')).toBe(true);
    expect(byRole('executor').every((m) => m === 'qwen3.5:4b')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/orchestrator.test.ts -t "per-role model routing"`
Expected: FAIL — `callLog` has no `model` field yet (compile error) → after the FakeOllamaClient edit, it fails only if routing is wrong; but the orchestrator already routes by provider, so the real failure here is that `numPredict`/`timeoutMs` aren't yet on `ProviderConfig` (TS error). That's the signal to implement Step 3.

- [ ] **Step 3: Extend `ProviderConfig` and thread the fields**

In `orchestrator.ts`:

(a) Extend `ProviderConfig` (lines 62-65):

```ts
export interface ProviderConfig {
  client: AnyClient;
  model: string;
  /** Per-role timeout (ms). 35B reasoning roles need a large one. */
  timeoutMs?: number;
  /** num_predict for 35B thinking roles. */
  numPredict?: number;
}
```

(b) Add a private helper to compute a role's local fallback (used only for cloud roles). After `getProvider` (line 140), add:

```ts
  /** Local default provider, used as the cloud fallback target. */
  private localDefault(): ProviderConfig {
    return { client: this.defaultClient, model: this.defaultModel };
  }

  /** Fallback for a role: the local default IFF the role's provider is cloud. */
  private fallbackFor(role: 'planner' | 'executor' | 'evaluator'): ProviderConfig | undefined {
    const prov = this.getProvider(role);
    return prov.client instanceof CloudClientCtor ? this.localDefault() : undefined;
  }
```

and add the import at the top: `import { CloudClient as CloudClientCtor } from '../background/cloud_client';`

(c) In `runPlannerStep`, pass the new fields + fallback to `runPlanner`. Replace the `runPlanner({...})` call (lines 389-398) with:

```ts
    const result = await runPlanner({
      state: prepared,
      registry: this.registry,
      client: plannerProv.client,
      model: plannerProv.model,
      timeoutMs: plannerProv.timeoutMs,
      numPredict: plannerProv.numPredict,
      signal: this.abort?.signal,
      isInitial,
      replanHint,
      thinkingMode: this.plannerThinking,
    });
```

(d) `executeOneStep`: pass timeout/numPredict to `runExecutor` (lines 463-469):

```ts
    const result = await runExecutor({
      state,
      registry: this.registry,
      client: execProv.client,
      model: execProv.model,
      timeoutMs: execProv.timeoutMs,
      numPredict: execProv.numPredict,
      signal: this.abort?.signal,
    });
```

(e) `runEvaluation`: pass timeout/numPredict to `runEvaluator` (lines 693-700):

```ts
    const result = await runEvaluator({
      state,
      client: evalProv.client,
      model: evalProv.model,
      timeoutMs: evalProv.timeoutMs,
      numPredict: evalProv.numPredict,
      signal: this.abort?.signal,
      thinkingMode: this.evaluatorThinking,
      triggeredByFinish,
    });
```

> NOTE on the cloud fallback: `driveChatOnce` accepts a `fallback` provider, but the role runners (Task 7) currently call `driveChatOnce(provider, opts)` with no third arg. Wire the fallback by adding an optional `fallback?: DriveProvider` to each role's `Input` and passing it to `driveChatOnce`. Update Task 7's three role files to accept `fallback?: import('../../background/chat_driver').DriveProvider` on their Input and pass it as the 3rd arg of every `driveChatOnce(provider, opts, input.fallback)` call. Then here in the orchestrator, set `fallback: this.fallbackFor('planner' | 'executor' | 'evaluator')` in each role call above. (Compactor has no cloud path.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/orchestrator.test.ts`
Expected: PASS including the new routing test. All prior orchestrator tests still pass (they construct with `client+model`, so `getProvider` returns the default with `timeoutMs`/`numPredict` undefined; `fallbackFor` returns undefined since the default fake isn't a CloudClient).

- [ ] **Step 5: Full suite + commit**

Run: `npm test`
Expected: 390 passed.

```bash
git add src/agent/orchestrator.ts src/agent/roles/executor.ts src/agent/roles/evaluator.ts src/agent/roles/planner.ts tests/orchestrator.test.ts
git commit -m "feat(orchestrator): thread per-role timeout/numPredict + cloud fallback

ProviderConfig gains timeoutMs/numPredict; the orchestrator forwards them to
each role and passes the local default as the driveChatOnce fallback for any
role whose provider is cloud. +1 routing test; planner cast removed."
```

---

## Task 9: Settings — `roleModels` + locked all-local defaults (Stream B0/B9)

`Settings` gains a per-role local-model override map; `DEFAULT_SETTINGS` ships the locked defaults so the product runs the all-local quality split out of the box.

**Files:**
- Modify: `extension/src/shared/messages.ts:13-39`
- Test: covered by `tests/providers.test.ts` (Task 10).

- [ ] **Step 1: Add `roleModels` to `Settings` + locked defaults**

In `messages.ts`, inside `interface Settings` after the `cloud?` block (line 29), add:

```ts
  /**
   * Per-role LOCAL model override (same Ollama server, different model tag).
   * Locked defaults route the reasoning roles to the capable 35B; Executor /
   * Compactor inherit `model` (the fast 4B). Cloud (above) takes precedence.
   */
  roleModels?: {
    planner?: string;
    executor?: string;
    evaluator?: string;
    compactor?: string;
  };
```

and extend `DEFAULT_SETTINGS` (lines 32-39):

```ts
export const DEFAULT_SETTINGS: Settings = {
  ollamaBaseUrl: 'http://localhost:11434',
  model: 'qwen3.5:4b',
  embeddingModel: 'mxbai-embed-large',
  enableThinking: false,
  plannerThinking: true,
  evaluatorThinking: true,
  // Locked 2026-05-31 (spec §10): reasoning roles -> capable local 35B;
  // Executor/Compactor inherit the fast 4B (`model`). Cloud stays opt-in/off.
  roleModels: {
    planner: 'qwen3.6:35b-a3b',
    evaluator: 'qwen3.6:35b-a3b',
  },
};
```

- [ ] **Step 2: Type-check + commit**

Run: `npx tsc -b --noEmit` (or `npm run build` if that's the type-check entry)
Expected: no type errors. (No behavior change yet — nothing reads `roleModels` until Task 10/11.)

Run: `npm test`
Expected: 390 passed.

```bash
git add src/shared/messages.ts
git commit -m "feat(settings): add roleModels + lock all-local defaults

Settings.roleModels = per-role local model override. DEFAULT_SETTINGS ships
the locked split: Planner/Evaluator -> qwen3.6:35b-a3b, Executor/Compactor ->
qwen3.5:4b (inherited). Cloud remains opt-in/off-by-default."
```

---

## Task 10: `buildProviders` — settings → per-role providers (Stream B6 core)

A pure, unit-testable function that turns `Settings` + a local `OllamaClient` into the orchestrator's per-role providers, applying the resolution precedence (cloud → local-override → default) and the per-role 35B timeout/numPredict.

**Files:**
- Create: `extension/src/background/providers.ts`
- Test: `extension/tests/providers.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `extension/tests/providers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildProviders } from '../src/background/providers';
import { DEFAULT_SETTINGS } from '../src/shared/messages';
import { OllamaClient } from '../src/background/ollama';
import { CloudClient } from '../src/background/cloud_client';

const local = new OllamaClient('http://localhost:11434');

describe('buildProviders', () => {
  it('locked defaults route reasoning roles to the 35B local override', () => {
    const p = buildProviders(DEFAULT_SETTINGS, local);
    expect(p.defaultProvider.model).toBe('qwen3.5:4b');
    expect(p.plannerProvider?.model).toBe('qwen3.6:35b-a3b');
    expect(p.evaluatorProvider?.model).toBe('qwen3.6:35b-a3b');
    // Executor/Compactor have no override -> undefined -> orchestrator uses default.
    expect(p.executorProvider).toBeUndefined();
    expect(p.compactorProvider).toBeUndefined();
    // Local overrides reuse the same OllamaClient instance.
    expect(p.plannerProvider?.client).toBe(local);
  });

  it('35B reasoning roles get a raised timeout + num_predict', () => {
    const p = buildProviders(DEFAULT_SETTINGS, local);
    expect(p.plannerProvider?.timeoutMs).toBeGreaterThanOrEqual(25 * 60 * 1000);
    expect(p.evaluatorProvider?.timeoutMs).toBeGreaterThanOrEqual(12 * 60 * 1000);
    expect(p.plannerProvider?.numPredict).toBeGreaterThanOrEqual(2048);
    expect(p.evaluatorProvider?.numPredict).toBeGreaterThanOrEqual(2048);
  });

  it('cloud config takes precedence over a local override', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      cloud: { planner: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk', model: 'deepseek-chat' } },
    };
    const p = buildProviders(settings, local);
    expect(p.plannerProvider?.client).toBeInstanceOf(CloudClient);
    expect(p.plannerProvider?.model).toBe('deepseek-chat');
    // Cloud gets the short cloud timeout, not the 25-min local one.
    expect(p.plannerProvider?.timeoutMs).toBeLessThanOrEqual(120000);
  });

  it('an override equal to the default model is treated as no override', () => {
    const settings = { ...DEFAULT_SETTINGS, roleModels: { executor: 'qwen3.5:4b' } };
    const p = buildProviders(settings, local);
    expect(p.executorProvider).toBeUndefined();
  });

  it('zero cloud config => fully local, no CloudClient anywhere', () => {
    const p = buildProviders(DEFAULT_SETTINGS, local);
    for (const prov of [p.defaultProvider, p.plannerProvider, p.evaluatorProvider]) {
      expect(prov?.client).not.toBeInstanceOf(CloudClient);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/providers.test.ts`
Expected: FAIL (`buildProviders` not found).

- [ ] **Step 3: Implement `buildProviders`**

Create `extension/src/background/providers.ts`:

```ts
// Pure settings -> per-role provider resolution for the Orchestrator.
//
// Precedence per reasoning role: cloud[role] -> CloudClient; else
// roleModels[role] (a local Ollama model override) -> the local client +
// that model; else undefined (the orchestrator uses defaultProvider).
//
// 35B reasoning roles (planner/evaluator local override) get a raised timeout
// and a num_predict floor — the Linux verification proved a 35B turn at the
// Evaluator/Planner budgets exceeds the 5-min default, and that think:true
// with a small num_predict returns empty content.

import type { Settings } from '../shared/messages';
import type { OllamaClient } from './ollama';
import { CloudClient } from './cloud_client';
import type { ProviderConfig } from '../agent/orchestrator';

export interface ResolvedProviders {
  defaultProvider: ProviderConfig;
  plannerProvider?: ProviderConfig;
  executorProvider?: ProviderConfig;
  evaluatorProvider?: ProviderConfig;
  compactorProvider?: ProviderConfig;
}

/** Big timeouts for the CPU-bound 35B (from the Linux verification). */
const PLANNER_35B_TIMEOUT_MS = 25 * 60 * 1000;
const EVALUATOR_35B_TIMEOUT_MS = 12 * 60 * 1000;
/** Generation budget so think:true doesn't swallow the whole output. */
const THINKING_NUM_PREDICT = 2048;
/** Cloud calls are fast; matches CloudClient's default. */
const CLOUD_TIMEOUT_MS = 60_000;

type ReasoningRole = 'planner' | 'executor' | 'evaluator' | 'compactor';

export function buildProviders(settings: Settings, defaultClient: OllamaClient): ResolvedProviders {
  const defaultProvider: ProviderConfig = { client: defaultClient, model: settings.model };

  const resolve = (role: ReasoningRole): ProviderConfig | undefined => {
    // Compactor stays LOCAL always (spec non-goal: no compactor-on-cloud). The
    // orchestrator casts the compactor client to OllamaClient, so never hand it
    // a CloudClient even if settings.cloud.compactor was hand-edited.
    const cloud = role !== 'compactor' ? settings.cloud?.[role] : undefined;
    if (cloud && cloud.apiKey && cloud.model) {
      return {
        client: new CloudClient(cloud.baseUrl || 'https://api.deepseek.com/v1', cloud.apiKey),
        model: cloud.model,
        timeoutMs: CLOUD_TIMEOUT_MS,
        // numPredict left undefined: cloud uses max_tokens.
      };
    }
    const localModel = settings.roleModels?.[role];
    if (localModel && localModel !== settings.model) {
      return {
        client: defaultClient,
        model: localModel,
        timeoutMs:
          role === 'planner' ? PLANNER_35B_TIMEOUT_MS
          : role === 'evaluator' ? EVALUATOR_35B_TIMEOUT_MS
          : undefined,
        numPredict:
          role === 'planner' || role === 'evaluator' ? THINKING_NUM_PREDICT : undefined,
      };
    }
    return undefined;
  };

  return {
    defaultProvider,
    plannerProvider: resolve('planner'),
    executorProvider: resolve('executor'),
    evaluatorProvider: resolve('evaluator'),
    compactorProvider: resolve('compactor'),
  };
}

/**
 * All distinct LOCAL models the resolved config will request (for pre-flight
 * validation against `ollama list`). Excludes cloud-routed roles.
 */
export function localModelsInUse(settings: Settings): string[] {
  const models = new Set<string>([settings.model]);
  const roles: ReasoningRole[] = ['planner', 'executor', 'evaluator', 'compactor'];
  for (const role of roles) {
    if (settings.cloud?.[role]?.apiKey) continue; // cloud role — not a local model
    const m = settings.roleModels?.[role];
    if (m) models.add(m);
  }
  return [...models];
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/providers.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Full suite + commit**

Run: `npm test`
Expected: 395 passed.

```bash
git add src/background/providers.ts tests/providers.test.ts
git commit -m "feat(providers): buildProviders — settings -> per-role providers

Pure resolution: cloud -> CloudClient; roleModels -> local override; else
default. 35B reasoning roles get raised timeout + num_predict floor (from the
Linux verification). localModelsInUse() lists local models for pre-flight.
+5 tests."
```

---

## Task 11: Service worker uses `buildProviders` + validates configured models (Stream B6)

Wire the dead cloud/roleModels path: both `new Orchestrator(...)` sites resolve providers via `buildProviders`; pre-flight validates every configured local model is actually pulled (so a missing 35B fails in seconds with a clear message, not a 25-min hang).

**Files:**
- Modify: `extension/src/background/service_worker.ts`

- [ ] **Step 1: Import the resolver + a validation helper**

In `service_worker.ts`, add to the imports: `import { buildProviders, localModelsInUse } from './providers';`

- [ ] **Step 2: Extend the pre-flight model check in `handleAgentStart`**

Replace the single-model check (lines 315-323) with a check over all configured local models:

```ts
  const needed = localModelsInUse(settings);
  const missing = needed.filter((m) => !ping.models?.includes(m));
  if (missing.length > 0) {
    send(port, {
      type: 'agent.terminal',
      phase: 'ABORTED',
      error: `model(s) not present at ${settings.ollamaBaseUrl}: ${missing.join(', ')}. ` +
        `Pull them (e.g. \`ollama pull ${missing[0]}\`) or change the model in Polaris settings. ` +
        `Available: ${(ping.models ?? []).slice(0, 8).join(', ') || '(none)'}.`,
    });
    return;
  }
```

- [ ] **Step 3: Use `buildProviders` at the `handleAgentStart` Orchestrator site**

Replace the `new Orchestrator({ client, model: settings.model, ... })` (lines 328-346) with:

```ts
  const providers = buildProviders(settings, client);
  const orchestrator = new Orchestrator({
    defaultProvider: providers.defaultProvider,
    plannerProvider: providers.plannerProvider,
    executorProvider: providers.executorProvider,
    evaluatorProvider: providers.evaluatorProvider,
    compactorProvider: providers.compactorProvider,
    plannerThinking: settings.plannerThinking,
    evaluatorThinking: settings.evaluatorThinking,
    onEvent: (event) => {
      send(port, { type: 'agent.event', event });
      if (event.type === 'verdict') {
        const d = event.data as { summary?: string; verdict?: string; reason?: string; finalAnswer?: string } | undefined;
        if (d?.verdict === 'done' && d.finalAnswer) lastSummary = d.finalAnswer;
        if (d?.verdict === 'done' && d.summary) lastSummary = d.summary;
        if (d?.verdict === 'abort') lastError = d.reason ?? 'aborted';
      }
      if (event.type === 'error') {
        const d = event.data as { error?: string } | undefined;
        if (d?.error) lastError = d.error;
      }
    },
  });
```

- [ ] **Step 4: Use `buildProviders` at the `handleAgentResume` Orchestrator site**

Apply the same replacement to the `new Orchestrator({...})` in `handleAgentResume` (lines 438-455): add `const providers = buildProviders(settings, client);` before it and swap `client`/`model` for the resolved `defaultProvider` + per-role providers (keep that site's existing `onEvent` body, which already lacks the `d.summary` line — leave it as-is to minimize the diff, or align it; either is fine).

> NOTE: `vision.ground` is registered inside the Orchestrator against `defaultProvider.client` — which `buildProviders` always sets to the local `OllamaClient`. So vision stays local even when a reasoning role is cloud, satisfying Convention #5. No change needed there.

- [ ] **Step 5: Build to verify the SW compiles**

Run: `npm run build`
Expected: build succeeds; no TS errors. (`service_worker.ts` has no unit test — `chrome.*` globals — so the build is the gate. The provider logic itself is covered by `providers.test.ts`.)

Run: `npm test`
Expected: 395 passed (unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/background/service_worker.ts
git commit -m "feat(sw): wire buildProviders at both Orchestrator sites

The dead cloud/roleModels path is now live: providers resolved from settings
(locked all-local defaults), passed per-role. Pre-flight validates EVERY
configured local model is pulled, so a missing 35B fails in seconds with a
'pull it' message instead of a 25-min Planner hang. vision.ground stays local
(bound to defaultProvider.client)."
```

---

## Task 12: Settings UI — per-role "Model source" selector (Stream B7)

Surface the 3-tier routing in the settings drawer so users can change a role's source (and enter a cloud key). Mirrors the existing Domain-trust-tiers section pattern.

**Files:**
- Modify: `extension/src/sidepanel/App.tsx`

- [ ] **Step 1: Add a helper to derive a role's current source + update it**

In `App.tsx`, inside the `App` component (after `updateSetting`, ~line 390), add:

```ts
  type ModelSource = 'default' | 'local35b' | 'cloud';
  const LOCAL_35B = 'qwen3.6:35b-a3b';

  function roleSource(role: 'planner' | 'executor' | 'evaluator'): ModelSource {
    if (settings.cloud?.[role]?.apiKey) return 'cloud';
    if (settings.roleModels?.[role]) return 'local35b';
    return 'default';
  }

  function setRoleSource(role: 'planner' | 'executor' | 'evaluator', source: ModelSource) {
    const roleModels = { ...(settings.roleModels ?? {}) };
    const cloud = { ...(settings.cloud ?? {}) };
    if (source === 'local35b') {
      roleModels[role] = LOCAL_35B;
      delete cloud[role];
    } else if (source === 'cloud') {
      delete roleModels[role];
      cloud[role] = cloud[role] ?? { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' };
    } else {
      delete roleModels[role];
      delete cloud[role];
    }
    // Persist both maps together (settings.set shallow-merges top-level keys).
    send(null, { type: 'settings.set', settings: { roleModels, cloud } });
  }

  function updateCloudField(role: 'planner' | 'executor' | 'evaluator', field: 'baseUrl' | 'apiKey' | 'model', value: string) {
    const cloud = { ...(settings.cloud ?? {}) };
    const existing = cloud[role] ?? { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' };
    cloud[role] = { ...existing, [field]: value };
    send(null, { type: 'settings.set', settings: { cloud } });
  }
```

- [ ] **Step 2: Render the selector section in the drawer**

In the drawer JSX, after the Domain-trust-tiers `drawer-section` (closes at line 607) and before the final `drawer-actions` (line 608), insert a new section:

```tsx
          <div className="drawer-section">
            <div className="drawer-section-head">
              <span className="drawer-section-label">Model source per role</span>
              <span className="drawer-section-hint">
                Default is fully local. <code>Local 35B</code> uses {LOCAL_35B} for higher-quality
                reasoning (slower). <code>Cloud</code> sends PII-anonymized prompts to your own key.
              </span>
            </div>
            {(['planner', 'executor', 'evaluator'] as const).map((role) => (
              <div key={role} className="role-model-row">
                <span className="role-model-label">{role}</span>
                <select
                  value={roleSource(role)}
                  onChange={(e) => setRoleSource(role, e.target.value as ModelSource)}
                >
                  <option value="default">Default (4B)</option>
                  <option value="local35b">Local 35B</option>
                  <option value="cloud">Cloud (BYOK)</option>
                </select>
                {roleSource(role) === 'cloud' && (
                  <div className="role-cloud-fields">
                    <input
                      type="text"
                      placeholder="baseUrl"
                      value={settings.cloud?.[role]?.baseUrl ?? ''}
                      onChange={(e) => updateCloudField(role, 'baseUrl', e.target.value)}
                    />
                    <input
                      type="password"
                      placeholder="apiKey"
                      value={settings.cloud?.[role]?.apiKey ?? ''}
                      onChange={(e) => updateCloudField(role, 'apiKey', e.target.value)}
                    />
                    <input
                      type="text"
                      placeholder="model (e.g. deepseek-chat)"
                      value={settings.cloud?.[role]?.model ?? ''}
                      onChange={(e) => updateCloudField(role, 'model', e.target.value)}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
```

- [ ] **Step 3: Add minimal styles**

In `extension/src/sidepanel/styles.css`, append:

```css
.role-model-row { display: flex; align-items: center; gap: 8px; margin: 4px 0; flex-wrap: wrap; }
.role-model-label { min-width: 72px; text-transform: capitalize; font-size: 12px; opacity: 0.85; }
.role-cloud-fields { display: flex; flex-direction: column; gap: 4px; width: 100%; padding-left: 80px; }
.role-cloud-fields input { width: 100%; }
```

- [ ] **Step 4: Build to verify the panel compiles**

Run: `npm run build`
Expected: build succeeds; bundle sizes printed (panel grows a few KB). No TS errors.

Run: `npm test`
Expected: 395 passed (no panel unit tests; the build is the gate, browser verification is in Task 14).

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/App.tsx src/sidepanel/styles.css
git commit -m "feat(panel): per-role Model source selector (Default/Local 35B/Cloud)

Settings drawer gains a per-role source selector mirroring the domain-tier
section. Local 35B writes settings.roleModels[role]; Cloud reveals
baseUrl/apiKey/model into settings.cloud[role]. Default is fully local."
```

---

## Task 13: Docs reconciliation (Stream D)

Bring the docs in line with the pivots + the locked decision. No code; the gate is `npm run build` (unchanged) and a self-read for accuracy.

**Files:**
- Modify: `CLAUDE.md`, `README.md`
- Restore: `probe_results.json`, `probe_results.log`; add `probe_results_qwen36.json`, `probe_results_qwen36.log`

- [ ] **Step 1: Amend Convention #6 in `CLAUDE.md`**

Find the "Single reasoning model" convention (Convention #6) and replace its body with the local-default-plus-opt-in-cloud framing:

```
6. **Local-first, per-role model routing.** Default is fully local with both
   models resident: Planner + Evaluator → `qwen3.6:35b-a3b` (quality reasoning),
   Executor + Compactor → `qwen3.5:4b` (hot-path / throughput). Cloud BYOK is an
   OPT-IN per-role upgrade, OFF by default — full functionality requires no cloud
   config. (Locked 2026-05-31 via the §10 model-distribution flow; see
   `docs/superpowers/specs/2026-05-30-hybrid-delta-wiring-design.md` and
   `extension/docs/model-distribution-verification.md`. Supersedes the prior
   "single local model" rule.)
```

- [ ] **Step 2: Soften "read-only Phase 1" in `CLAUDE.md`**

Find the read-only Phase 1 line (in the stack-decisions list) and replace with:

```
- **Read by default; actions are domain-tier-gated.** click / type / select are
  available via CDP but gated per host (default `read-only`, fail-closed; the
  user opts a host into `click-only` / `full-action`). Not read-only-only anymore.
```

- [ ] **Step 3: Fix the README privacy claim**

In `README.md`, find the intro line claiming "runs entirely on your own machine. No browsing data leaves your computer" and replace with:

```
Polaris runs fully locally by default — no browsing data leaves your machine.
You can optionally enable per-role cloud routing (bring your own API key); when
you do, only PII-anonymized prompts are sent to your configured provider, and
everything else stays local.
```

Also add a short "Dual-model Ollama setup" subsection near the install steps documenting the verified coexistence config:

```
### Dual-model Ollama setup (local 35B reasoning)

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
```

- [ ] **Step 4: Restore the qwen3.5 probe artifacts; keep the qwen3.6 run**

The current `probe_results.*` were overwritten with a qwen3.6 run, unbacking CLAUDE.md's qwen3.5 citations. Restore the pre-29d0f68 qwen3.5 files and preserve the qwen3.6 run alongside:

```bash
# From repo root. Save the current (qwen3.6) run under a kept name first.
cp probe_results.json probe_results_qwen36.json
cp probe_results.log  probe_results_qwen36.log
# Restore the qwen3.5 versions from the last commit that had them.
git log --oneline -- probe_results.json | head -5   # find the pre-29d0f68 sha
git checkout <that-sha> -- probe_results.json probe_results.log
```

If the qwen3.5 versions can't be recovered from history, instead add a one-line header to `probe_results_qwen36.json`'s companion note clarifying it is the qwen3.6 latency-only run, and add a CLAUDE.md note that the qwen3.5 capability data lives in the hardware tables / `extension/docs/probes/m3.5-linux.md` rather than a stale JSON. (Record which path you took in the commit message.)

- [ ] **Step 5: Update CLAUDE.md "Current state" + "Recent decisions"**

Add a "Recent decisions" entry (at the top) dated 2026-05-31 summarizing: model-distribution locked all-local (cloud opt-in), parser-mismatch + swap-thrash refuted on Linux (XML fallback + mandatory pinning dropped), 35B needs num_predict≥2048 + raised timeout. Update "Current state / Last shipped" to reflect the wiring work once the branch is merged.

- [ ] **Step 6: Build + self-read + commit**

Run: `npm run build && npm test`
Expected: build OK, 395 passed (docs don't affect either).

Self-read: open `README.md` and confirm there is no remaining sentence that contradicts the new privacy framing (grep for "entirely" / "never leaves").

```bash
git add CLAUDE.md README.md probe_results.json probe_results.log probe_results_qwen36.json probe_results_qwen36.log
git commit -m "docs: reconcile to reality — local-first routing, gated actions, privacy

Convention #6 -> local-first per-role routing (cloud opt-in). 'Read-only Phase
1' -> domain-tier-gated actions. README privacy line no longer self-contradicts.
Dual-model Ollama setup documented. qwen3.5 probe artifacts restored; qwen3.6
run kept as probe_results_qwen36.*."
```

---

## Task 14: Combined real-browser smoke harness (Stream E)

A runnable harness the **user** executes on real Chrome (this Mac's sandbox blocks Chrome). It builds + loads the extension, drives `tab.click` → `tab.type` → `tab.select` against a known local page, and (if a cloud key is set) runs one cloud-routed Executor turn asserting a tool-call round-trip. Emits PASS/FAIL.

**Files:**
- Create: `extension/scripts/browser_smoke_hybrid.py`
- Reference: `scripts/browser_smoke.py` (existing harness to model structure/CLI on)

- [ ] **Step 1: Read the existing harness to match its conventions**

Read `scripts/browser_smoke.py` end-to-end. Match its Chrome-launch flags, extension-load mechanism (`--load-extension=dist`), debugging-port usage, and output format. Reuse its helpers rather than reinventing them.

- [ ] **Step 2: Write the harness**

Create `extension/scripts/browser_smoke_hybrid.py` with this structure (fill the Chrome-driving internals from Step 1's patterns — do NOT invent a new driver if the existing one works):

```python
#!/usr/bin/env python3
"""Hybrid Delta real-browser smoke test (page actions + optional cloud Executor).

Run OUTSIDE the Claude sandbox (it binds Chrome's debugging port):
    cd extension && npm run build && python3 scripts/browser_smoke_hybrid.py

What it verifies end-to-end against a real Chrome:
  1. Loads the unpacked extension from dist/.
  2. Opens a local test page (a form with a text input, a button, and a <select>).
  3. Sets that host to full-action via the domain-tier API.
  4. Drives tab.type -> tab.click -> tab.select and asserts the DOM mutated
     (input value set, button-click handler fired, select value changed).
  5. (Optional) If POLARIS_SMOKE_CLOUD=1 and a cloud key is configured, runs one
     cloud-routed Executor turn and asserts a tool_calls round-trip.

Emits a PASS/FAIL line per check and a final summary; exit code 0 iff all PASS.
"""
import os, sys, json, time
# Reuse the launch/connect helpers from browser_smoke.py (import or copy the
# proven pieces). Serve TEST_PAGE_HTML from a localhost http.server so the
# domain-tier host is stable and not file://.

TEST_PAGE_HTML = """<!doctype html><meta charset=utf-8><title>polaris smoke</title>
<input id="q" type="text">
<button id="go" onclick="window.__clicked=true">Go</button>
<select id="sort"><option value="rel">Relevance</option><option value="price">Price</option></select>
"""

def main() -> int:
    results = []
    def check(name, ok, detail=""):
        results.append((name, ok, detail))
        print(("PASS" if ok else "FAIL"), name, ("- " + detail) if detail else "")
    # 1) build present
    # 2) launch chrome with --load-extension=$(pwd)/dist (see browser_smoke.py)
    # 3) open the served test page; capture its tab id + host
    # 4) set host -> full-action via the extension's domainTiers API / chrome.storage
    # 5) drive the three tools; read back window state via Runtime.evaluate:
    #      - tab.type '#q' "wireless headphones"   -> assert document.querySelector('#q').value == "wireless headphones"
    #      - tab.click '#go'                         -> assert window.__clicked === true
    #      - tab.select '#sort' value 'price'        -> assert document.querySelector('#sort').value === 'price'
    # 6) if POLARIS_SMOKE_CLOUD=1: configure cloud[executor] from env
    #      (DEEPSEEK_API_KEY) and run one Executor turn; assert a tool_call fired.
    ok = all(r[1] for r in results)
    print(f"\n{'ALL PASS' if ok else 'FAILURES'}: {sum(1 for r in results if r[1])}/{len(results)}")
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
```

Implement the numbered steps using the proven Chrome-driving code from `browser_smoke.py`. The page-action checks read back DOM state via CDP `Runtime.evaluate` (the same channel `tab.select` already uses), so the harness verifies real mutation, not just that the tool returned `ok`.

- [ ] **Step 3: Syntax-check the harness (no browser needed here)**

Run: `python3 -c "import ast; ast.parse(open('extension/scripts/browser_smoke_hybrid.py').read()); print('ok')"`
Expected: `ok`.

- [ ] **Step 4: Commit + hand off the run to the user**

Run: `npm test`
Expected: 395 passed (the harness is a script; no unit tests).

```bash
git add scripts/browser_smoke_hybrid.py
git commit -m "test(e2e): combined real-browser smoke harness for page actions + cloud

Drives tab.type/click/select against a served test page and asserts real DOM
mutation; optional cloud-routed Executor turn (POLARIS_SMOKE_CLOUD=1). Must run
outside the sandbox. This is the gate that settles whether click/type actually
work on a real page."
```

> The user runs `cd extension && npm run build && python3 scripts/browser_smoke_hybrid.py` on a machine with real Chrome (Linux box or their Mac terminal). The page-action PASS/FAIL is the definitive answer to "do we really have click/type capability?" that static tests can't give.

---

## Final verification (after all tasks)

- [ ] `npm test` → all green (expected ~395, up from 376; +19 across the tasks).
- [ ] `npm run build` → succeeds; note the SW + panel bundle sizes.
- [ ] `npx tsc -b --noEmit` (or the project's type-check command) → no errors; confirm no remaining `(client as any)` casts in the role files and no `as OllamaClient` planner cast.
- [ ] Spot-check: with `DEFAULT_SETTINGS` and no cloud config, `buildProviders` yields Planner/Evaluator on `qwen3.6:35b-a3b`, Executor/Compactor on the default — fully local, no `CloudClient` constructed.
- [ ] Hand the user the Task 14 harness command for the real-browser gate, and (separately) the README dual-model Ollama setup so they can run the locked 35B+4B config on the Linux box.

---

## Notes for the implementer

- **Why this order:** Stream A (page actions) is independent and addresses the user's foundational concern first. The cloud chain is built bottom-up — `signal` → `CloudClient` → `normalize` → `anonymize` → `driveChatOnce` → roles → orchestrator → settings → `buildProviders` → service worker → UI — so every commit leaves the suite green and each layer is tested before the next consumes it. Docs + harness last.
- **Dispatch by `instanceof CloudClient`:** chosen over a discriminant field so role unit tests (plain-object / FakeOllamaClient) transparently take the local path. The new cloud-path tests construct a real `CloudClient` and stub `chatOnce`/`fetch`.
- **Compactor stays local, always** (no cloud branch, no fallback) — per the locked decision; it's a fast local transform.
- **vision.ground stays local** automatically: the Orchestrator binds it to `defaultProvider.client`, which `buildProviders` always sets to the local `OllamaClient`.
- **35B constraints are correctness, not polish:** `num_predict ≥ 2048` (else think:true returns empty content) and the raised per-role timeout (else 35B turns abort under the 5-min default) — both live in `buildProviders` and flow through `driveChatOnce`.
- **Out of scope (do NOT add):** SoM↔AXTree fusion, compactor-on-cloud, a provider registry, prompt-caching headers, full-page screenshots, the client-side XML tool-call fallback parser (the parser mismatch did NOT reproduce on Ollama 0.22.1), mandatory model pinning (swap-thrash refuted).
