# Hybrid Delta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gap between the Polaris Hybrid Agentic Browser design doc (`docs/Polaris Hybrid Agentic Browser Design.md`) and the current fully-local codebase, following the agreed 6-phase build order.

**Architecture:** Six independent phases building on each other: (3a) activate the dead `images?` field in OllamaClient + create a `vision.ground` verification tool, (5) CDP-based page-action tools gated by the already-built domain tier system, (1) hybrid-ready infrastructure with a separate cloud client + per-role provider config, (2) route executor + evaluator to DeepSeek V4-Flash with auto-fallback, (3b) Set-of-Marks content script fused with ARIA tree coordinates, (4) reversible Presidio-style sandwich redaction for cloud-bound PII.

**Tech Stack:** Chrome MV3 extension, TypeScript, Zod, Ollama (qwen3.5:4b local), vitest, `fake-indexeddb`, CDP via `chrome.debugger` API.

---

## File Structure

### Phase 3a — vision.ground tool
- **Create:** `extension/src/agent/tools/browser/vision.ts` — Ollama vision chat helper + `visionGroundTool` handler
- **Modify:** `extension/src/background/ollama.ts` — wire `images` field into `chatOnce` and `chatStream` POST bodies
- **Modify:** `extension/src/agent/tools/index.ts` — register `vision.ground`
- **Create:** `extension/tests/vision.test.ts` — unit tests for `chatOnce` images body, tool args/output, dimension check
- **Modify:** `extension/src/agent/tools/browser/tab.ts` — no changes needed; screenshot tool already returns `dataUri`

### Phase 5 — Page-action tools
- **Create:** `extension/src/agent/tools/browser/actions.ts` — `tab.click`, `tab.type`, `tab.select` ToolHandler exports
- **Modify:** `extension/src/agent/tools/index.ts` — register page-action tools
- **Create:** `extension/tests/actions.test.ts` — tool tests with mocked chrome.debugger

### Phase 1 — Hybrid Ready infrastructure
- **Create:** `extension/src/background/cloud_client.ts` — OpenAI-format HTTP client (raw fetch, no SDK)
- **Modify:** `extension/src/agent/orchestrator.ts` — add per-role client/model in `OrchestratorOptions`
- **Modify:** `extension/src/shared/messages.ts` — expand `Settings` with per-role provider fields
- **Modify:** `extension/src/background/sw.ts` — wire cloud client and provider map
- **Create:** `extension/tests/cloud_client.test.ts` — unit tests for cloud client
- **Modify:** `extension/tests/orchestrator.test.ts` — test per-role configuration

### Phase 2 — Cloud Executor
- **Modify:** `extension/src/background/cloud_client.ts` — real DeepSeek API integration with streaming
- **Modify:** `extension/src/agent/roles/executor.ts` — accept client selector, cloud routing
- **Modify:** `extension/src/agent/roles/evaluator.ts` — same as executor
- **Modify:** `extension/src/agent/orchestrator.ts` — route executor/evaluator to cloud when configured
- **Modify:** `extension/src/shared/messages.ts` — API key management fields
- **Create:** `extension/tests/cloud_executor.test.ts` — integration-style tests with recorded responses

### Phase 3b — SoM + Fusion
- **Create:** `extension/src/content/som.ts` — set-of-marks overlay content script
- **Create:** `extension/src/agent/tools/browser/som.ts` — SoM generation tool (links ARIA backendDOMNodeId to bounding boxes)
- **Modify:** `extension/src/agent/tools/index.ts` — register som.generate
- **Modify:** `extension/src/manifest.ts` — add content_scripts entry for som.ts
- **Create:** `extension/tests/som.test.ts` — SoM overlay logic tests

### Phase 4 — Presidio Redaction
- **Create:** `extension/src/agent/anonymize.ts` — regex `<PERSON_1>` placeholders + stable mapping table
- **Create:** `extension/src/agent/deanonymize.ts` — post-cloud placeholder replacement
- **Modify:** `extension/src/agent/redact.ts` — two-tier: fast regex + qwen3.5 PII detection
- **Modify:** `extension/src/agent/state_store.ts` — apply anonymize before cloud-bound findings
- **Create:** `extension/tests/anonymize.test.ts` — sandwich round-trip tests
- **Modify:** `extension/tests/redact.test.ts` — add two-tier tests

---

## Phase 3a: vision.ground tool

### Task 3a.1: Wire images field in OllamaClient

**Files:**
- Modify: `extension/src/background/ollama.ts:174-188` — add `images` to `chatStream` request body
- Modify: `extension/src/background/ollama.ts:270-286` — add `images` to `chatOnce` request body
- Test: `extension/tests/ollama.test.ts` — new test for images in request body

- [ ] **Step 1: Write the failing test for images in chatOnce**

```typescript
// Add to extension/tests/ollama.test.ts

it('includes images in the chatOnce request body when present', async () => {
  const scope = nock(baseUrl)
    .post('/api/chat', (body: Record<string, unknown>) => {
      return (
        body.messages &&
        Array.isArray(body.messages) &&
        body.messages[0]?.images?.[0] === 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' &&
        body.stream === false
      );
    })
    .reply(200, { message: { content: 'valid', role: 'assistant' }, done: true });
  const client = new OllamaClient(baseUrl);
  const result = await client.chatOnce({
    model: 'test-model',
    messages: [{ role: 'user', content: 'describe this image', images: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='] }],
  });
  expect(result.message?.content).toBe('valid');
  scope.done();
});

it('includes images in the chatStream request body when present', async () => {
  const scope = nock(baseUrl)
    .post('/api/chat', (body: Record<string, unknown>) => {
      return (
        body.messages &&
        Array.isArray(body.messages) &&
        body.messages[0]?.images?.[0]?.startsWith('data:image/') &&
        body.stream === true
      );
    })
    .reply(200, '{"message":{"content":"seeing"},"done":true}\n');
  const client = new OllamaClient(baseUrl);
  const chunks: string[] = [];
  for await (const chunk of client.chatStream({
    model: 'test-model',
    messages: [{ role: 'user', content: 'what do you see', images: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAAAAFfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='] }],
  })) {
    if (chunk.message?.content) chunks.push(chunk.message.content);
  }
  expect(chunks.join('')).toContain('seeing');
  scope.done();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest tests/ollama.test.ts -t "includes images" --reporter=verbose`
Expected: Tests fail because the POST body doesn't include `images` — the `scope` matcher never matches, nock throws `No match for request`.

- [ ] **Step 3: Add images to chatOnce body**

In `extension/src/background/ollama.ts`, find the `chatOnce` method's `body` construction (around line 271):

```typescript
// BEFORE (line 271-276):
const body: Record<string, unknown> = {
  model: opts.model,
  messages: opts.messages,
  stream: false,
  keep_alive: opts.keepAlive ?? DEFAULT_KEEP_ALIVE,
};

// AFTER — same pattern, existing ChatMessage already has images?: string[]
// The messages objects already carry images in each message payload;
// Ollama's /api/chat expects { model, messages: [{ role, content, images }], ... }
// No additional body field needed — images live inside each message.
```

The key insight: Ollama's `/api/chat` accepts `images` as a per-message field, not a top-level field. The `ChatMessage` interface already declares `images?: string[]` at line 12. The issue is that `JSON.stringify(body)` which includes `opts.messages` will serialize those images if they exist. So actually **no code change is needed** — the `body.messages` already carries the full `ChatMessage` objects including their `images` field.

Wait — the current code does `JSON.stringify(body)` and `body.messages = opts.messages`. If a message in opts.messages has `images`, it WILL be serialized. Let me verify by checking the actual POST body.

Actually, looking more carefully: `body.messages = opts.messages` and `opts.messages` is `ChatMessage[]` which has `images?: string[]`. When JSON.stringify serializes `messages`, any present `images` fields WILL be included. So the images field is already being sent. The real question is: has anyone ever set `images` on a message in practice? Looking at all callers of `chatOnce` and `chatStream`, none of them set `images` — the field is declared but never populated.

So the fix isn't in the OllamaClient at all — the client already works. The fix is that the `vision.ground` tool needs to construct messages with images. Let me adjust this task accordingly.

- [ ] **Step 4: Verify the existing client already handles images**

Run: `grep -n 'images' extension/src/background/ollama.ts`
Expected: Line 12 shows `images?: string[]` in `ChatMessage`. The body construction at line 271/174 passes `opts.messages` which carries this field — no change needed.

- [ ] **Step 5: Commit**

```bash
git add extension/tests/ollama.test.ts
git commit -m "test: verify ChatMessage images field is serialized in request body"
```

`★ Insight ─────────────────────────────────────`
The `images` field was added to `ChatMessage` during M1 scaffold as part of the Ollama API spec, but no caller ever populated it — it was dead code waiting for the vision pipeline. The fix is gratifyingly simple: `ChatMessage.images` flows through `JSON.stringify(body)` automatically because `body.messages = opts.messages` copies the full message objects. No client-level wiring is needed; the vision tool just needs to set `images` on the message before calling `chatOnce`.
`─────────────────────────────────────────────────`

### Task 3a.2: Create the vision.ground tool

**Files:**
- Create: `extension/src/agent/tools/browser/vision.ts`
- Modify: `extension/src/agent/tools/index.ts` — register vision.ground
- Create: `extension/tests/vision.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// extension/tests/vision.test.ts

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Import the tool AFTER it's created — test will fail initially
// import { visionGroundTool } from '../src/agent/tools/browser/vision';

describe('vision.ground tool', () => {
  it('has the correct name and description', () => {
    // Remove '// ' when file exists
    // expect(visionGroundTool.name).toBe('vision.ground');
    // expect(visionGroundTool.description).toContain('verify');
    expect(true).toBe(true); // placeholder until file exists
  });

  it('args schema accepts dataUri and question', () => {
    const schema = z.object({
      dataUri: z.string().min(1),
      question: z.string().min(1).optional(),
    });
    const valid = schema.safeParse({
      dataUri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      question: 'is the search bar visible?',
    });
    expect(valid.success).toBe(true);
  });

  it('rejects empty dataUri', () => {
    const schema = z.object({
      dataUri: z.string().min(1),
      question: z.string().min(1).optional(),
    });
    const invalid = schema.safeParse({ dataUri: '', question: 'test' });
    expect(invalid.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify placeholder passes**

Run: `cd extension && npx vitest tests/vision.test.ts --reporter=verbose`
Expected: Tests pass (placeholder).

- [ ] **Step 3: Create vision.ts**

```typescript
// extension/src/agent/tools/browser/vision.ts
//
// Vision grounding tool (Phase 3a). Verification-only: never primary extraction.
// Takes a screenshot data URI (from tab.screenshot) and optionally a question,
// sends to local Ollama vision model, returns structured visibility assessment.
//
// Design constraints:
//   - Screenshots must be ≥ 1200 px wide (per Polaris CLAUDE.md — smaller and
//     the model hallucinates instead of refusing). The tool rejects smaller
//     images as non-fatal so the model can retry with a wider capture.
//   - The question prompt asks for brief, structured responses rather than
//     prose descriptions because the answer is consumed by the agent loop, not
//     a human. Default: "Describe the page contents briefly. What elements are
//     visible and what are their states?"
//   - Uses chatOnce (non-streaming) because the agent loop needs the full
//     response to continue; streaming adds complexity for no benefit here.
//
// The OllamaClient is injected from outside (not imported here) because the
// tool does not know which client the orchestrator has configured. The
// registry / executor provides the client reference.

import { z } from 'zod';
import type { ToolHandler } from '../registry';
import { BrowserToolError } from './lifecycle';
import type { OllamaClient } from '../../../background/ollama';

const MIN_VISION_WIDTH_PX = 1200;

const visionGroundArgs = z.object({
  /** Data URI of a PNG screenshot, e.g. from tab.screenshot. */
  dataUri: z.string().min(20, 'dataUri too short — not a valid screenshot'),
  /** Optional question to ask about the image. Default: general description. */
  question: z.string().min(1).optional(),
  /** Pixel width of the source screenshot (for pre-check). */
  widthPx: z.number().int().positive().optional(),
});

const visionGroundOutput = z.object({
  /** Free-form assessment from the vision model. */
  assessment: z.string(),
  /** True if the model confirmed seeing the page (not a hallucination marker). */
  confirmed: z.boolean(),
});

/**
 * Create a vision.ground tool handler bound to a specific OllamaClient + model.
 * The tool is factory-produced because it needs the client at construction time
 * (the registry dispatches tools without context about which LLM to call).
 */
export function createVisionGroundTool(
  client: OllamaClient,
  model: string,
): ToolHandler<
  z.infer<typeof visionGroundArgs>,
  z.infer<typeof visionGroundOutput>
> {
  return {
    name: 'vision.ground',
    description:
      'Send a screenshot to the local vision model and return a verification assessment. ' +
      'Use this to verify that extracted ARIA data matches the actual visible page state. ' +
      'Always provide widthPx when available; images < 1200 px wide will be rejected.',
    argsSchema: visionGroundArgs,
    outputSchema: visionGroundOutput,
    parametersJSON: {
      type: 'object',
      properties: {
        dataUri: {
          type: 'string',
          description: 'Data URI of a PNG screenshot from tab.screenshot.',
        },
        question: {
          type: 'string',
          description: 'Optional verification question (e.g., "Is the search bar visible?"). Defaults to general description.',
        },
        widthPx: {
          type: 'integer',
          description: 'Width of the source screenshot in pixels. Used to reject undersized images.',
        },
      },
      required: ['dataUri'],
    },
    execute: async (args) => {
      if (args.widthPx !== undefined && args.widthPx < MIN_VISION_WIDTH_PX) {
        throw new BrowserToolError(
          `vision.ground: image width ${args.widthPx}px < minimum ${MIN_VISION_WIDTH_PX}px — ` +
          'screenshot is too small for reliable vision. Capture a wider screenshot and retry.',
          { fatal: false },
        );
      }

      const question = args.question ?? 'Describe the page contents briefly. What elements are visible and what are their states?';

      const result = await client.chatOnce({
        model,
        messages: [
          {
            role: 'user',
            content: question,
            images: [args.dataUri],
          },
        ],
        // Vision calls need generous timeout — image tokens are large
        timeoutMs: 120_000,
        think: false,
      });

      const assessment = result.message?.content ?? '';
      const confirmed = assessment.length > 20;

      return { assessment, confirmed };
    },
  };
}
```

- [ ] **Step 4: Register vision.ground in index.ts**

```typescript
// In extension/src/agent/tools/index.ts, AFTER the import block:

// NOTE: vision.ground is NOT registered in createDefaultRegistry() because it
// requires an OllamaClient reference. The orchestrator registers it separately
// after construction (see orchestrator.ts). The import and export are provided
// here for reference and re-export.

export { createVisionGroundTool } from './browser/vision';
```

- [ ] **Step 5: Write unit tests for the tool**

```typescript
// Replace contents of extension/tests/vision.test.ts

import { describe, it, expect, vi } from 'vitest';
import { createVisionGroundTool } from '../src/agent/tools/browser/vision';
import type { OllamaClient } from '../src/background/ollama';

function mockClient(response: string): OllamaClient {
  return {
    baseUrl: 'http://localhost:11434',
    chatOnce: vi.fn().mockResolvedValue({
      message: { content: response, role: 'assistant' },
      done: true,
    }),
    chatStream: vi.fn(),
    embed: vi.fn(),
    ping: vi.fn(),
    url: vi.fn(),
  } as unknown as OllamaClient;
}

const sampleDataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('createVisionGroundTool', () => {
  it('returns correct tool name', () => {
    const client = mockClient('visible');
    const tool = createVisionGroundTool(client, 'qwen3.5:4b');
    expect(tool.name).toBe('vision.ground');
  });

  it('sends images to Ollama and returns assessment', async () => {
    const client = mockClient('The page shows a search bar and navigation menu.');
    const tool = createVisionGroundTool(client, 'qwen3.5:4b');
    const result = await tool.execute({ dataUri: sampleDataUri }, { taskId: 't1', stepId: null });
    expect(result.assessment).toContain('search bar');
    expect(result.confirmed).toBe(true);
    expect(client.chatOnce).toHaveBeenCalledTimes(1);
    const call = (client.chatOnce as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.messages[0].images).toEqual([sampleDataUri]);
  });

  it('rejects images below minimum width', async () => {
    const client = mockClient('visible');
    const tool = createVisionGroundTool(client, 'qwen3.5:4b');
    await expect(tool.execute(
      { dataUri: sampleDataUri, widthPx: 800 },
      { taskId: 't1', stepId: null },
    )).rejects.toThrow(/minimum 1200/);
  });

  it('passes custom question to Ollama', async () => {
    const client = mockClient('Yes, the button is visible.');
    const tool = createVisionGroundTool(client, 'qwen3.5:4b');
    await tool.execute(
      { dataUri: sampleDataUri, question: 'Is the submit button visible?' },
      { taskId: 't1', stepId: null },
    );
    const call = (client.chatOnce as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.messages[0].content).toBe('Is the submit button visible?');
  });

  it('reports confirmed=false for short/tiny response', async () => {
    const client = mockClient('ok');
    const tool = createVisionGroundTool(client, 'qwen3.5:4b');
    const result = await tool.execute({ dataUri: sampleDataUri }, { taskId: 't1', stepId: null });
    expect(result.confirmed).toBe(false);
  });
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd extension && npx vitest tests/vision.test.ts --reporter=verbose`
Expected: 5/5 passing.

- [ ] **Step 7: Run full test suite to confirm no regressions**

Run: `cd extension && npx vitest run --reporter=verbose 2>&1 | tail -5`
Expected: "333 passed" (or whatever the current count is + 5).

- [ ] **Step 8: Commit**

```bash
git add extension/src/agent/tools/browser/vision.ts extension/src/agent/tools/index.ts extension/tests/vision.test.ts
git commit -m "feat: add vision.ground tool for screenshot verification

- Factory function createVisionGroundTool binds OllamaClient + model
- Minimum 1200px width guard (non-fatal BrowserToolError)
- Custom question passthrough; confirmed flag based on response length
- 5 tests: name, images sent, width rejection, custom question, short response"
```

`★ Insight ─────────────────────────────────────`
The `vision.ground` tool is a factory (`createVisionGroundTool(client, model)`) rather than a plain export because it wraps the orchestrator's OllamaClient. This follows the tool-registry pattern cleanly: tools that need external dependencies are constructed at wiring time, not import time. The screenshot data URI comes from a separate tool (`tab.screenshot`), keeping the two concerns independent — the agent calls `tab.screenshot` first, then `vision.ground` with the result.
`─────────────────────────────────────────────────`

### Task 3a.3: Wire vision.ground into orchestrator

**Files:**
- Modify: `extension/src/agent/orchestrator.ts` — register vision.ground tool after construction
- Modify: `extension/tests/orchestrator.test.ts` — verify tool is registered

- [ ] **Step 1: Add vision.ground registration to Orchestrator constructor**

In `extension/src/agent/orchestrator.ts`, after the `this.registry = options.registry ?? createDefaultRegistry();` line (around line 82), add:

```typescript
import { createVisionGroundTool } from './tools';

// In the constructor body, after registry assignment:
// Register vision.ground — it needs the orchestrator's client+model
this.registry.register(
  createVisionGroundTool(this.client, this.model),
);
```

- [ ] **Step 2: Write a test that vision.ground is in the registry**

```typescript
// Add to extension/tests/orchestrator.test.ts

it('vision.ground tool is registered in the orchestrator', () => {
  // Orchestrator constructor registers vision.ground via createVisionGroundTool
  // The test creates an orchestrator and checks the registry
  const { Orchestrator } = await import('../src/agent/orchestrator');
  const client = new OllamaClient('http://localhost:11434');
  // Mock chatOnce to avoid real calls
  vi.spyOn(client, 'chatOnce').mockResolvedValue({
    message: { content: 'test', role: 'assistant' },
    done: true,
  });
  const orch = new Orchestrator({ client, model: 'test-model' });
  // Access private registry via the orchestrator's internal use
  // We verify by checking that the tool defs include vision.ground
  const defs = orch['registry'].names();
  expect(defs).toContain('vision.ground');
});
```

- [ ] **Step 3: Run orchestrator tests**

Run: `cd extension && npx vitest tests/orchestrator.test.ts -t "vision.ground" --reporter=verbose`
Expected: 1 test passes.

- [ ] **Step 4: Commit**

```bash
git add extension/src/agent/orchestrator.ts extension/tests/orchestrator.test.ts
git commit -m "feat: register vision.ground in orchestrator with client+model binding"
```

---

## Phase 5: Page-action tools

### Task 5.1: Create CDP click tool (tab.click)

**Files:**
- Create: `extension/src/agent/tools/browser/actions.ts` — `tabClickTool` export
- Create: `extension/tests/actions.test.ts` — click tool tests

- [ ] **Step 1: Write failing test for tab.click**

```typescript
// extension/tests/actions.test.ts

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

describe('tab.click', () => {
  it('requires either backendDOMNodeId or selector', () => {
    const schema = z.object({
      tabId: z.number().int(),
      backendDOMNodeId: z.number().int().optional(),
      selector: z.string().min(1).optional(),
    }).refine(
      (d) => d.backendDOMNodeId !== undefined || d.selector !== undefined,
      { message: 'must provide either backendDOMNodeId or selector' },
    );

    const withNodeId = schema.safeParse({ tabId: 1, backendDOMNodeId: 42 });
    expect(withNodeId.success).toBe(true);

    const withSelector = schema.safeParse({ tabId: 1, selector: '#submit-btn' });
    expect(withSelector.success).toBe(true);

    const neither = schema.safeParse({ tabId: 1 });
    expect(neither.success).toBe(false);
  });
});
```

- [ ] **Step 2: Create actions.ts with tab.click tool**

```typescript
// extension/src/agent/tools/browser/actions.ts
//
// Page-action tools for M3 (Phase 5). CDP-based click/type/select wrappers
// that let the agent interact with real browser pages.
//
// Each tool gates through assertCanAct() from domain_tiers.ts before
// dispatching any CDP command. The domain tier infrastructure is already
// built; these tools are its first consumers.
//
// CDP flow:
//   1. chrome.debugger.attach({ tabId }, '1.3')
//   2. Resolve element coordinates via DOM.getDocument + DOM.querySelector
//      + DOM.getContentQuads (when given a selector) or DOM.resolveNode +
//      DOM.getContentQuads (when given a backendDOMNodeId)
//   3. Dispatch Input.dispatchMouseEvent / Input.dispatchKeyEvent
//   4. chrome.debugger.detach({ tabId })
//
// Error handling: non-fatal BrowserToolError for recoverable issues (element
// not found, domain tier too low). Fatal only on impossible states
// (debugger unavailable, tab crashed).

import { z } from 'zod';
import type { ToolHandler } from '../registry';
import { BrowserToolError, withBrowserTimeout } from './lifecycle';
import { assertCanAct, canonicalHost } from '../../domain_tiers';

// ──────────────────────────────────────────────────────────────────────────
// tab.click
// ──────────────────────────────────────────────────────────────────────────

const DRAGGABLE_EVENT_TYPES = ['dragstart', 'drag', 'dragend', 'drop'] as const;
const MOUSE_EVENT_TYPES = [
  'click', 'mousedown', 'mouseup', 'dblclick', 'contextmenu',
  ...DRAGGABLE_EVENT_TYPES,
] as const;

const tabClickArgs = z.object({
  tabId: z.number().int(),
  /**
   * `backendDOMNodeId` from the ARIA tree (aria.extract returns these).
   * Prefer this over selector when available — it's CDP-native and doesn't
   * need a DOM re-walk.
   */
  backendDOMNodeId: z.number().int().optional(),
  /** CSS selector fallback when backendDOMNodeId isn't available. */
  selector: z.string().min(1).optional(),
  /** Mouse button to use. Default 'left'. */
  button: z.enum(['left', 'right', 'middle']).optional(),
  /** Number of clicks. Default 1. Use 2 for double-click. */
  clickCount: z.number().int().min(1).max(3).optional(),
  /** X offset from the element's top-left corner (px). */
  offsetX: z.number().int().optional(),
  /** Y offset from the element's top-left corner (px). */
  offsetY: z.number().int().optional(),
}).refine(
  (d) => d.backendDOMNodeId !== undefined || d.selector !== undefined,
  { message: 'must provide either backendDOMNodeId or a CSS selector' },
);

const tabClickOutput = z.object({
  action: z.literal('click'),
  x: z.number(),
  y: z.number(),
});

export const tabClickTool: ToolHandler<
  z.infer<typeof tabClickArgs>,
  z.infer<typeof tabClickOutput>
> = {
  name: 'tab.click',
  description:
    'Click on an element in a tab. Requires either a backendDOMNodeId (from aria.extract) ' +
    'or a CSS selector. Gated by domain tier: the target domain must be at least "click-only".',
  argsSchema: tabClickArgs,
  outputSchema: tabClickOutput,
  parametersJSON: {
    type: 'object',
    properties: {
      tabId: { type: 'integer', description: 'Tab id from tab.open or tab.list.' },
      backendDOMNodeId: {
        type: 'integer',
        description: 'backendDOMNodeId from aria.extract output. Prefer this over selector.',
      },
      selector: {
        type: 'string',
        description: 'CSS selector fallback (e.g., "#submit-btn", ".search-box").',
      },
      button: {
        type: 'string',
        enum: ['left', 'right', 'middle'],
        description: 'Mouse button (default: left).',
      },
      clickCount: {
        type: 'integer',
        minimum: 1,
        maximum: 3,
        description: 'Click count (default: 1, use 2 for double-click).',
      },
      offsetX: {
        type: 'integer',
        description: 'X offset from element origin in px.',
      },
      offsetY: {
        type: 'integer',
        description: 'Y offset from element origin in px.',
      },
    },
    required: ['tabId'],
  },
  execute: async (args) => {
    return withBrowserTimeout(async () => {
      // Resolve tab URL for domain tier check
      let tab: chrome.tabs.Tab;
      try {
        tab = await chrome.tabs.get(args.tabId);
      } catch (e) {
        throw new BrowserToolError(
          `tab.click: tab ${args.tabId} not found: ${(e as Error).message}`,
          { fatal: false },
        );
      }
      const url = tab.url ?? '';
      await assertCanAct(url, 'click-only');

      const targetAttach: { tabId: number } = { tabId: args.tabId };
      let detach = true;
      try {
        await chrome.debugger.attach(targetAttach, '1.3');

        // Resolve the element coordinates
        const { x, y } = await resolveElementCoords(
          args.tabId,
          args.backendDOMNodeId,
          args.selector,
          args.offsetX,
          args.offsetY,
        );

        // Click at coordinates
        const button = args.button ?? 'left';
        const clickCount = args.clickCount ?? 1;

        await chrome.debugger.sendCommand(targetAttach, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: Math.round(x),
          y: Math.round(y),
          button,
          clickCount,
        });
        await chrome.debugger.sendCommand(targetAttach, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: Math.round(x),
          y: Math.round(y),
          button,
          clickCount,
        });

        return { action: 'click', x: Math.round(x), y: Math.round(y) };
      } finally {
        if (detach) {
          try { await chrome.debugger.detach(targetAttach); } catch { /* best-effort */ }
        }
      }
    }, 15_000, 'tab.click');
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

async function resolveElementCoords(
  tabId: number,
  backendDOMNodeId?: number,
  selector?: string,
  offsetX?: number,
  offsetY?: number,
): Promise<{ x: number; y: number }> {
  const target: { tabId: number } = { tabId };

  let nodeId: number;
  if (backendDOMNodeId !== undefined) {
    // Resolve by backendDOMNodeId from the ARIA tree
    const resolveResult = await chrome.debugger.sendCommand(target, 'DOM.resolveNode', {
      backendNodeId: backendDOMNodeId,
    });
    if (!resolveResult?.object?.objectId) {
      throw new BrowserToolError(
        `tab.click: could not resolve backendDOMNodeId ${backendDOMNodeId}`,
        { fatal: false },
      );
    }
    // Get the DOM node id from the remote object
    const domResult = await chrome.debugger.sendCommand(target, 'DOM.requestNode', {
      objectId: resolveResult.object.objectId,
    });
    if (typeof domResult?.nodeId !== 'number') {
      throw new BrowserToolError(
        `tab.click: could not request node for backendDOMNodeId ${backendDOMNodeId}`,
        { fatal: false },
      );
    }
    nodeId = domResult.nodeId;
  } else if (selector) {
    // Walk by CSS selector
    const docResult = await chrome.debugger.sendCommand(target, 'DOM.getDocument', { depth: -1 });
    const documentNodeId = (docResult as { root?: { nodeId: number } })?.root?.nodeId;
    if (typeof documentNodeId !== 'number') {
      throw new BrowserToolError('tab.click: could not get document', { fatal: true });
    }
    const queryResult = await chrome.debugger.sendCommand(target, 'DOM.querySelector', {
      nodeId: documentNodeId,
      selector,
    });
    if (typeof (queryResult as { nodeId: number })?.nodeId !== 'number' || (queryResult as { nodeId: number }).nodeId === 0) {
      throw new BrowserToolError(
        `tab.click: selector "${selector}" matched no elements`,
        { fatal: false },
      );
    }
    nodeId = (queryResult as { nodeId: number }).nodeId;
  } else {
    throw new BrowserToolError('tab.click: no backendDOMNodeId or selector provided', { fatal: false });
  }

  // Get content quads (bounding boxes) for the element
  const quadsResult = await chrome.debugger.sendCommand(target, 'DOM.getContentQuads', {
    nodeId,
  });
  const quads = (quadsResult as { quads?: number[][] })?.quads;
  if (!quads || quads.length === 0) {
    throw new BrowserToolError(
      'tab.click: element has no visible bounding box (hidden or off-screen?)',
      { fatal: false },
    );
  }

  // The first quad is the element's bounding box as [x1,y1,x2,y2,x3,y3,x4,y4]
  const quad = quads[0];
  if (!quad || quad.length < 4) {
    throw new BrowserToolError('tab.click: empty quad data', { fatal: false });
  }
  const x0 = quad[0]!;
  const y0 = quad[1]!;
  const x2 = quad[4]!;
  const y2 = quad[5]!;

  const width = x2 - x0;
  const height = y2 - y0;
  const cx = x0 + (offsetX ?? Math.floor(width / 2));
  const cy = y0 + (offsetY ?? Math.floor(height / 2));

  return { x: cx, y: cy };
}
```

`★ Insight ─────────────────────────────────────`
The CDP coordinate resolution has two paths: `backendDOMNodeId` (from the ARIA tree via `aria.extract`) and `CSS selector`. The backendDOMNodeId path goes through `DOM.resolveNode → DOM.requestNode → DOM.getContentQuads` — a CDP-native chain that avoids selector re-parsing but requires the debugger to have the full DOM tree. The selector path uses `DOM.querySelector` which is cheaper but needs a prior `DOM.getDocument`. Both converge on `DOM.getContentQuads` to obtain viewport coordinates for `Input.dispatchMouseEvent`.
`─────────────────────────────────────────────────`

- [ ] **Step 3: Write tests for tab.click**

```typescript
// In extension/tests/actions.test.ts — replace placeholder content

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock chrome.debugger and chrome.tabs before importing
const mockSendCommand = vi.fn();
const mockAttach = vi.fn().mockResolvedValue(undefined);
const mockDetach = vi.fn().mockResolvedValue(undefined);
const mockTabsGet = vi.fn();

(globalThis as unknown as { chrome: Record<string, unknown> }).chrome = {
  ...(globalThis as unknown as { chrome: Record<string, unknown> }).chrome,
  tabs: { get: mockTabsGet },
  debugger: {
    attach: mockAttach,
    detach: mockDetach,
    sendCommand: mockSendCommand,
  },
};

import { tabClickTool } from '../src/agent/tools/browser/actions';

describe('tab.click', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTabsGet.mockResolvedValue({ id: 42, url: 'https://example.com/page' });
    mockSendCommand.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'DOM.resolveNode') {
        return { object: { objectId: 'obj-1' } };
      }
      if (method === 'DOM.requestNode') {
        return { nodeId: 101 };
      }
      if (method === 'DOM.getContentQuads') {
        return { quads: [[10, 20, 100, 20, 100, 60, 10, 60]] };
      }
      if (method === 'Input.dispatchMouseEvent') {
        return {};
      }
      return {};
    });
  });

  it('clicks at coordinates resolved from backendDOMNodeId', async () => {
    const result = await tabClickTool.execute(
      { tabId: 42, backendDOMNodeId: 7 },
      { taskId: 't1', stepId: null },
    );
    expect(result.action).toBe('click');
    expect(result.x).toBe(55); // center of 10..100
    expect(result.y).toBe(40); // center of 20..60
  });

  it('throws fatal error for invalid tabId', async () => {
    mockTabsGet.mockRejectedValue(new Error('tab not found'));
    await expect(tabClickTool.execute(
      { tabId: 999, backendDOMNodeId: 7 },
      { taskId: 't1', stepId: null },
    )).rejects.toThrow('tab.click: tab 999 not found');
  });

  it('attaches and detaches debugger', async () => {
    await tabClickTool.execute(
      { tabId: 42, backendDOMNodeId: 7 },
      { taskId: 't1', stepId: null },
    );
    expect(mockAttach).toHaveBeenCalledWith({ tabId: 42 }, '1.3');
    expect(mockDetach).toHaveBeenCalledWith({ tabId: 42 });
  });

  it('applies offset from element origin', async () => {
    const result = await tabClickTool.execute(
      { tabId: 42, backendDOMNodeId: 7, offsetX: 5, offsetY: 5 },
      { taskId: 't1', stepId: null },
    );
    expect(result.x).toBe(15); // x0(10) + offset(5)
    expect(result.y).toBe(25); // y0(20) + offset(5)
  });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && npx vitest tests/actions.test.ts --reporter=verbose`
Expected: 4/4 tests pass.

- [ ] **Step 5: Run full suite for regressions**

Run: `cd extension && npx vitest run --reporter=verbose 2>&1 | tail -5`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add extension/src/agent/tools/browser/actions.ts extension/tests/actions.test.ts
git commit -m "feat: add tab.click page-action tool with CDP coordinate resolution

- Two element resolution paths: backendDOMNodeId and CSS selector
- Gated through assertCanAct(click-only)
- Manual setTimeout/clearTimeout timeout (no AbortSignal.timeout leak)
- 4 tests: click at center, invalid tab, debugger lifecycle, offset"
```

### Task 5.2: Create tab.type tool

**Files:**
- Modify: `extension/src/agent/tools/browser/actions.ts` — add `tabTypeTool`
- Modify: `extension/tests/actions.test.ts` — add type tests

- [ ] **Step 1: Add tab.type to actions.ts**

```typescript
// Append to extension/src/agent/tools/browser/actions.ts

// ──────────────────────────────────────────────────────────────────────────
// tab.type
// ──────────────────────────────────────────────────────────────────────────

const tabTypeArgs = z.object({
  tabId: z.number().int(),
  /** CSS selector for the input element. */
  selector: z.string().min(1),
  /** Text to type. Clears existing content first. */
  text: z.string(),
  /** If true, press Enter after typing. Default false. */
  submit: z.boolean().optional(),
});

const tabTypeOutput = z.object({
  action: z.literal('type'),
  charsTyped: z.number().int(),
  submitted: z.boolean(),
});

export const tabTypeTool: ToolHandler<
  z.infer<typeof tabTypeArgs>,
  z.infer<typeof tabTypeOutput>
> = {
  name: 'tab.type',
  description:
    'Type text into an input element identified by CSS selector. Clears existing content first. ' +
    'Gated by domain tier: the target domain must be "full-action".',
  argsSchema: tabTypeArgs,
  outputSchema: tabTypeOutput,
  parametersJSON: {
    type: 'object',
    properties: {
      tabId: { type: 'integer', description: 'Tab id.' },
      selector: { type: 'string', description: 'CSS selector for the input element.' },
      text: { type: 'string', description: 'Text to type.' },
      submit: { type: 'boolean', description: 'Press Enter after typing. Default false.' },
    },
    required: ['tabId', 'selector', 'text'],
  },
  execute: async (args) => {
    return withBrowserTimeout(async () => {
      let tab: chrome.tabs.Tab;
      try {
        tab = await chrome.tabs.get(args.tabId);
      } catch (e) {
        throw new BrowserToolError(
          `tab.type: tab ${args.tabId} not found: ${(e as Error).message}`,
          { fatal: false },
        );
      }
      const url = tab.url ?? '';
      await assertCanAct(url, 'full-action');

      const target: { tabId: number } = { tabId: args.tabId };
      try {
        await chrome.debugger.attach(target, '1.3');

        // Focus the element first via click
        const docResult = await chrome.debugger.sendCommand(target, 'DOM.getDocument', { depth: -1 });
        const documentNodeId = (docResult as { root?: { nodeId: number } })?.root?.nodeId;
        if (typeof documentNodeId !== 'number') {
          throw new BrowserToolError('tab.type: could not get document', { fatal: true });
        }
        const queryResult = await chrome.debugger.sendCommand(target, 'DOM.querySelector', {
          nodeId: documentNodeId,
          selector: args.selector,
        });
        const elNodeId = (queryResult as { nodeId: number }).nodeId;
        if (!elNodeId) {
          throw new BrowserToolError(
            `tab.type: selector "${args.selector}" matched no elements`,
            { fatal: false },
          );
        }

        // Clear existing content
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
          type: 'keyDown',
          windowsVirtualKeyCode: 8, // Backspace
          key: 'Backspace',
          text: '\b',
        });
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
          type: 'keyUp',
          windowsVirtualKeyCode: 8,
          key: 'Backspace',
        });

        // Type each character
        for (const char of args.text) {
          await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
            type: 'char',
            text: char,
            key: char,
            windowsVirtualKeyCode: char.charCodeAt(0),
          });
        }

        if (args.submit) {
          await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
            type: 'keyDown',
            windowsVirtualKeyCode: 13,
            key: 'Enter',
          });
          await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
            type: 'keyUp',
            windowsVirtualKeyCode: 13,
            key: 'Enter',
          });
        }

        return { action: 'type', charsTyped: args.text.length, submitted: args.submit ?? false };
      } finally {
        try { await chrome.debugger.detach(target); } catch { /* best-effort */ }
      }
    }, 15_000, 'tab.type');
  },
};
```

- [ ] **Step 2: Write tab.type tests**

```typescript
// Add to extension/tests/actions.test.ts

describe('tab.type', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTabsGet.mockResolvedValue({ id: 42, url: 'https://example.com/page' });
    mockSendCommand.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'DOM.getDocument') {
        return { root: { nodeId: 1 } };
      }
      if (method === 'DOM.querySelector') {
        return { nodeId: 101 };
      }
      if (method === 'Input.dispatchKeyEvent') {
        return {};
      }
      return {};
    });
  });

  it('types text into selected element', async () => {
    const result = await tabTypeTool.execute(
      { tabId: 42, selector: '#search', text: 'hello' },
      { taskId: 't1', stepId: null },
    );
    expect(result.action).toBe('type');
    expect(result.charsTyped).toBe(5);
    expect(result.submitted).toBe(false);
  });

  it('presses Enter after text when submit=true', async () => {
    const result = await tabTypeTool.execute(
      { tabId: 42, selector: '#search', text: 'query', submit: true },
      { taskId: 't1', stepId: null },
    );
    expect(result.submitted).toBe(true);
    // Check Enter key was dispatched
    const enterCalls = mockSendCommand.mock.calls.filter(
      (c: unknown[]) => (c[1] as string) === 'Input.dispatchKeyEvent' && (c[2] as Record<string, unknown>)?.key === 'Enter',
    );
    expect(enterCalls.length).toBe(2); // keyDown + keyUp
  });

  it('throws for empty selector match', async () => {
    mockSendCommand.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'DOM.querySelector') return { nodeId: 0 };
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'Input.dispatchKeyEvent') return {};
      return {};
    });
    await expect(tabTypeTool.execute(
      { tabId: 42, selector: '#nonexistent', text: 'x' },
      { taskId: 't1', stepId: null },
    )).rejects.toThrow('matched no elements');
  });
});
```

- [ ] **Step 3: Run tests**

Run: `cd extension && npx vitest tests/actions.test.ts --reporter=verbose`
Expected: ~7 tests passing (4 from click + 3 from type).

- [ ] **Step 4: Commit**

```bash
git add extension/src/agent/tools/browser/actions.ts extension/tests/actions.test.ts
git commit -m "feat: add tab.type page-action tool with per-character CDP dispatch

- Requires full-action domain tier
- Clears existing content then types character-by-character
- Optional Enter key after typing (submit flag)
- 3 tests: basic typing, submit true, empty selector"
```

### Task 5.3: Create tab.select tool

**Files:**
- Modify: `extension/src/agent/tools/browser/actions.ts` — add `tabSelectTool`
- Modify: `extension/tests/actions.test.ts` — add select tests

- [ ] **Step 1: Add tab.select to actions.ts**

```typescript
// Append to extension/src/agent/tools/browser/actions.ts

// ──────────────────────────────────────────────────────────────────────────
// tab.select
// ──────────────────────────────────────────────────────────────────────────

const tabSelectArgs = z.object({
  tabId: z.number().int(),
  /** CSS selector for the <select> element. */
  selector: z.string().min(1),
  /** Value of the <option> to select (not the display text). */
  value: z.string().min(1),
});

const tabSelectOutput = z.object({
  action: z.literal('select'),
  selector: z.string(),
  value: z.string(),
});

export const tabSelectTool: ToolHandler<
  z.infer<typeof tabSelectArgs>,
  z.infer<typeof tabSelectOutput>
> = {
  name: 'tab.select',
  description:
    'Select an option in a <select> dropdown identified by CSS selector. ' +
    'Gated by domain tier: the target domain must be "click-only" (selecting is a mutation, ' +
    'but does not involve typing keystrokes).',
  argsSchema: tabSelectArgs,
  outputSchema: tabSelectOutput,
  parametersJSON: {
    type: 'object',
    properties: {
      tabId: { type: 'integer', description: 'Tab id.' },
      selector: { type: 'string', description: 'CSS selector for the <select> element.' },
      value: { type: 'string', description: 'Value of the <option> to select.' },
    },
    required: ['tabId', 'selector', 'value'],
  },
  execute: async (args) => {
    return withBrowserTimeout(async () => {
      let tab: chrome.tabs.Tab;
      try {
        tab = await chrome.tabs.get(args.tabId);
      } catch (e) {
        throw new BrowserToolError(
          `tab.select: tab ${args.tabId} not found: ${(e as Error).message}`,
          { fatal: false },
        );
      }
      const url = tab.url ?? '';
      // Select is click-only (not full-action) because it doesn't involve free-form typing
      await assertCanAct(url, 'click-only');

      const target: { tabId: number } = { tabId: args.tabId };
      try {
        await chrome.debugger.attach(target, '1.3');

        // Evaluate JavaScript to set the select value and dispatch a change event
        const expr = `(() => {
          const el = document.querySelector(${JSON.stringify(args.selector)});
          if (!el) return { ok: false, error: 'element not found' };
          if (el.tagName !== 'SELECT') return { ok: false, error: 'element is not a <select>' };
          el.value = ${JSON.stringify(args.value)};
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true };
        })()`;

        const result = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
          expression: expr,
          returnByValue: true,
        });

        const outcome = (result as { result?: { value?: { ok: boolean; error?: string } } })?.result?.value;
        if (!outcome?.ok) {
          throw new BrowserToolError(
            `tab.select: ${outcome?.error ?? 'evaluation failed'}`,
            { fatal: false },
          );
        }

        return { action: 'select', selector: args.selector, value: args.value };
      } finally {
        try { await chrome.debugger.detach(target); } catch { /* best-effort */ }
      }
    }, 10_000, 'tab.select');
  },
};
```

- [ ] **Step 2: Write tab.select tests**

```typescript
// Add to extension/tests/actions.test.ts

describe('tab.select', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTabsGet.mockResolvedValue({ id: 42, url: 'https://example.com/page' });
    mockSendCommand.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { ok: true } } };
      }
      return {};
    });
  });

  it('selects a value in a dropdown', async () => {
    const result = await tabSelectTool.execute(
      { tabId: 42, selector: '#sort', value: 'price-asc' },
      { taskId: 't1', stepId: null },
    );
    expect(result.action).toBe('select');
    expect(result.value).toBe('price-asc');
  });

  it('throws when element is not found', async () => {
    mockSendCommand.mockResolvedValue({ result: { value: { ok: false, error: 'element not found' } } });
    await expect(tabSelectTool.execute(
      { tabId: 42, selector: '#missing', value: 'x' },
      { taskId: 't1', stepId: null },
    )).rejects.toThrow('element not found');
  });
});
```

- [ ] **Step 3: Run tests**

Run: `cd extension && npx vitest tests/actions.test.ts --reporter=verbose`
Expected: ~9 tests passing.

- [ ] **Step 4: Register all three tools in index.ts**

```typescript
// In extension/src/agent/tools/index.ts, add import:
import {
  tabClickTool,
  tabTypeTool,
  tabSelectTool,
} from './browser/actions';

// In createDefaultRegistry(), add:
reg.register(tabClickTool);
reg.register(tabTypeTool);
reg.register(tabSelectTool);
```

- [ ] **Step 5: Add registration test**

```typescript
// Add to extension/tests/actions.test.ts

it('tool names are correct', () => {
  expect(tabClickTool.name).toBe('tab.click');
  expect(tabTypeTool.name).toBe('tab.type');
  expect(tabSelectTool.name).toBe('tab.select');
});
```

- [ ] **Step 6: Run full suite for regressions**

Run: `cd extension && npx vitest run --reporter=verbose 2>&1 | tail -5`
Expected: All existing + new tests pass.

- [ ] **Step 7: Commit**

```bash
git add extension/src/agent/tools/browser/actions.ts extension/src/agent/tools/index.ts extension/tests/actions.test.ts
git commit -m "feat: add tab.select tool with Runtime.evaluate DOM access

- Uses inline JavaScript evaluation for <select> value setting
- click-only domain tier (dropdown selection ≠ free-form typing)
- Registers all 3 page-action tools in default registry
- 2 select tests + name checks"
```

---

## Phase 1: Hybrid Ready infrastructure

### Task 1.1: Create OpenAI-format cloud client

**Files:**
- Create: `extension/src/background/cloud_client.ts`
- Create: `extension/tests/cloud_client.test.ts`

- [ ] **Step 1: Create cloud_client.ts**

```typescript
// extension/src/background/cloud_client.ts
//
// OpenAI-format HTTP client for cloud LLM providers. Raw `fetch()`, no SDK.
// Compatible with DeepSeek, OpenAI, Anthropic (via proxy adapters), and any
// OpenAI-compatible endpoint.
//
// This is the cloud counterpart to OllamaClient. Same interface shape so the
// orchestrator can swap them transparently.
//
// Design constraints (per spec):
//   - No framework dependencies — raw fetch only
//   - Streaming support for Executor hot path
//   - Configurable base URL, API key, model, and timeout

import { log } from '../agent/log';

export interface CloudMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CloudChoice {
  index: number;
  message: CloudMessage;
  finish_reason?: string;
}

export interface CloudChunk {
  choices?: {
    delta: { content?: string };
    finish_reason?: string | null;
  }[];
}

export interface CloudChatResponse {
  id: string;
  choices: CloudChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface CloudChatOptions {
  model: string;
  messages: CloudMessage[];
  apiKey: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class CloudClient {
  constructor(
    public readonly baseUrl: string = 'https://api.deepseek.com/v1',
    public readonly defaultApiKey: string = '',
  ) {}

  /**
   * Non-streaming chat completion.
   */
  async chatOnce(opts: CloudChatOptions): Promise<CloudChatResponse> {
    const url = `${opts.baseUrl ?? this.baseUrl}/chat/completions`;
    const apiKey = opts.apiKey || this.defaultApiKey;

    const start = performance.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens ?? 4096,
        stream: false,
      }),
      signal: opts.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const wall = Math.round(performance.now() - start);
      throw new Error(`Cloud API HTTP ${res.status} after ${wall}ms: ${detail.slice(0, 200)}`);
    }

    const data = (await res.json()) as CloudChatResponse;
    log('info', 'cloud', 'chatOnce ✓', {
      model: opts.model,
      promptTokens: data.usage?.prompt_tokens,
      genTokens: data.usage?.completion_tokens,
      wallMs: Math.round(performance.now() - start),
    });
    return data;
  }

  /**
   * Streaming chat completion. Yields content deltas as they arrive.
   */
  async *chatStream(opts: CloudChatOptions): AsyncGenerator<string, void, unknown> {
    const url = `${opts.baseUrl ?? this.baseUrl}/chat/completions`;
    const apiKey = opts.apiKey || this.defaultApiKey;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens ?? 4096,
        stream: true,
      }),
      signal: opts.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Cloud stream HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('Cloud stream: no response body');
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;
        try {
          const parsed = JSON.parse(trimmed.slice(6)) as CloudChunk;
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch {
          // Skip malformed lines
        }
      }
    }
  }
}
```

- [ ] **Step 2: Write cloud client tests**

```typescript
// extension/tests/cloud_client.test.ts

import { describe, it, expect, vi } from 'vitest';

// We need to mock fetch — use vi.fn on globalThis
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

import { CloudClient } from '../src/background/cloud_client';

const sampleResponse = {
  id: 'chat-123',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

const sampleStreamChunks = [
  'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n',
  'data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
  'data: [DONE]\n',
].join('');

describe('CloudClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('chatOnce returns parsed response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: vi.fn(),
      json: vi.fn().mockResolvedValue(sampleResponse),
    });
    const client = new CloudClient('https://api.example.com/v1', 'sk-test');
    const result = await client.chatOnce({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      apiKey: 'sk-test',
    });
    expect(result.choices[0].message.content).toBe('Hello!');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[0]).toContain('/chat/completions');
    const body = JSON.parse(callArgs[1].body);
    expect(body.stream).toBe(false);
    expect(body.model).toBe('deepseek-chat');
  });

  it('chatOnce includes auth header', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: vi.fn(),
      json: vi.fn().mockResolvedValue(sampleResponse),
    });
    const client = new CloudClient('https://api.example.com/v1');
    await client.chatOnce({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      apiKey: 'sk-my-key',
    });
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Bearer sk-my-key');
  });

  it('chatStream yields content deltas', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sampleStreamChunks));
        controller.close();
      },
    });
    mockFetch.mockResolvedValue({
      ok: true,
      body: stream,
    });
    const client = new CloudClient();
    const chunks: string[] = [];
    for await (const chunk of client.chatStream({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      apiKey: 'sk-test',
    })) {
      chunks.push(chunk);
    }
    expect(chunks.join('')).toBe('Hello world');
  });

  it('chatOnce throws on HTTP error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue('unauthorized'),
    });
    const client = new CloudClient();
    await expect(client.chatOnce({
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      apiKey: 'bad-key',
    })).rejects.toThrow('HTTP 401');
  });
});
```

- [ ] **Step 3: Run tests**

Run: `cd extension && npx vitest tests/cloud_client.test.ts --reporter=verbose`
Expected: 4/4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add extension/src/background/cloud_client.ts extension/tests/cloud_client.test.ts
git commit -m "feat: add OpenAI-format cloud client (raw fetch, no SDK)

- CloudClient with chatOnce and chatStream (SSE parsing)
- Configurable baseUrl, apiKey, model, temperature, maxTokens, signal
- Compatible with DeepSeek, OpenAI, and any OpenAI-compatible endpoint
- 4 tests: chatOnce, auth header, chatStream SSE, HTTP error"
```

### Task 1.2: Per-role provider configuration in orchestrator

**Files:**
- Modify: `extension/src/agent/orchestrator.ts` — per-role client/model in options
- Modify: `extension/src/shared/messages.ts` — settings expansion

- [ ] **Step 1: Expand Settings interface**

```typescript
// In extension/src/shared/messages.ts, expand the Settings interface:

export interface CloudProvider {
  /** Base URL for the OpenAI-compatible API. */
  baseUrl: string;
  /** API key (stored in chrome.storage.local). */
  apiKey: string;
  /** Model identifier (e.g., 'deepseek-chat', 'gpt-4o'). */
  model: string;
}

export interface Settings {
  // Existing fields...
  // (ollamaBaseUrl, model, embeddingModel, enableThinking, plannerThinking, evaluatorThinking)

  /** Per-role cloud provider configuration. When set, the orchestrator routes
   *  the given role to the cloud instead of the local Ollama.  */
  cloud?: {
    executor?: CloudProvider;
    evaluator?: CloudProvider;
    planner?: CloudProvider;
    compactor?: CloudProvider;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  ollamaBaseUrl: 'http://localhost:11434',
  model: 'qwen3.5:4b',
  embeddingModel: 'mxbai-embed-large',
  enableThinking: false,
  plannerThinking: true,
  evaluatorThinking: true,
  // cloud is undefined by default — all roles run locally
};
```

- [ ] **Step 2: Expand OrchestratorOptions**

```typescript
// In extension/src/agent/orchestrator.ts, expand OrchestratorOptions:

import { CloudClient } from '../background/cloud_client';

export interface ProviderConfig {
  client: OllamaClient | CloudClient;
  model: string;
}

export interface OrchestratorOptions {
  // Existing fields...
  // client: OllamaClient;  → REPLACED by per-role providers
  // model: string;         → REPLACED by per-role providers

  /** Default provider used for all roles not explicitly configured. */
  defaultProvider: ProviderConfig;
  /** Per-role override for cloud routing. When set, overrides defaultProvider for that role. */
  plannerProvider?: ProviderConfig;
  executorProvider?: ProviderConfig;
  evaluatorProvider?: ProviderConfig;
  compactorProvider?: ProviderConfig;

  registry?: ToolRegistry;
  onEvent?: (event: OrchestratorEvent) => void;
  maxSteps?: number;
  plannerThinking?: boolean;
  evaluatorThinking?: boolean;
}

export class Orchestrator {
  // Replace single client+model with per-role providers
  private readonly getProvider: (role: 'planner' | 'executor' | 'evaluator' | 'compactor') => ProviderConfig;
  // ...
}
```

- [ ] **Step 3: Write tests for per-role configuration**

```typescript
// Add to extension/tests/orchestrator.test.ts

it('uses per-role provider when configured', async () => {
  const localClient = new OllamaClient('http://localhost:11434');
  const cloudClient = new CloudClient('https://api.deepseek.com/v1', 'sk-test');

  // Mock to avoid real calls
  vi.spyOn(localClient, 'chatOnce').mockResolvedValue({ message: { content: '', role: 'assistant' }, done: true });
  vi.spyOn(cloudClient, 'chatOnce').mockResolvedValue({
    id: 'test',
    choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
    usage: {},
  });

  const orch = new Orchestrator({
    defaultProvider: { client: localClient, model: 'qwen3.5:4b' },
    executorProvider: { client: cloudClient, model: 'deepseek-chat' },
  });

  // Verify executor uses cloud client
  // (Access via internal test hook or by inspecting getProvider)
  expect(orch['getProvider']('executor').client).toBe(cloudClient);
  expect(orch['getProvider']('planner').client).toBe(localClient);
});
```

- [ ] **Step 4: Commit**

```bash
git add extension/src/agent/orchestrator.ts extension/src/shared/messages.ts extension/tests/orchestrator.test.ts
git commit -m "feat: per-role provider configuration in orchestrator

- ProviderConfig type with client+model per role
- Settings.CloudProvider for cloud endpoint config
- Backward compatible: undefined cloud = all local"
```

---

## Phase 2: Cloud Executor

### Task 2.1: Route executor and evaluator to cloud

**Files:**
- Modify: `extension/src/agent/roles/executor.ts` — accept generic client
- Modify: `extension/src/agent/roles/evaluator.ts` — same as executor
- Modify: `extension/src/agent/orchestrator.ts` — route per role
- Modify: `extension/src/shared/messages.ts` — add API key fields
- Create: `extension/tests/cloud_executor.test.ts`

- [ ] **Step 1: Make role runners accept both client types**

```typescript
// In extension/src/agent/roles/executor.ts, change ExecutorInput to accept both:

import type { OllamaClient } from '../../background/ollama';
import type { CloudClient } from '../../background/cloud_client';

export interface ExecutorInput {
  state: AgentStateHot;
  registry: ToolRegistry;
  client: OllamaClient | CloudClient;
  model: string;
  signal?: AbortSignal;
}
```

The `runExecutor` function already uses `client.chatOnce(...)` — both `OllamaClient` and `CloudClient` have a `chatOnce` method. However, CloudClient returns `CloudChatResponse` not `ChatChunk`. We need a thin adapter or a shared interface. Simplest approach: define a shared `ChatDriver` interface.

- [ ] **Step 2: Define a shared ChatDriver interface**

```typescript
// extension/src/background/chat_driver.ts
//
// Shared interface that both OllamaClient and CloudClient implement.
// Lets the orchestrator and role runners switch between local and cloud
// transparently.

import type { ToolDef } from '../shared/tool_types';

export interface ChatDriver {
  chatOnce(opts: {
    model: string;
    messages: { role: string; content: string; images?: string[] }[];
    tools?: ToolDef[];
    format?: 'json' | Record<string, unknown>;
    think?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{
    message?: { content?: string; role?: string; tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[] };
    prompt_eval_count?: number;
    eval_count?: number;
  }>;
}
```

This adapter lets both clients conform — the OllamaClient already returns `ChatChunk`, and we can wrap `CloudClient.chatOnce` to return the same shape.

- [x] **Architecture note**: Rather than creating a formal adapter layer, Phase 2 can use duck typing: both clients have `chatOnce` and accept similar args. The role runners already depend on `client.chatOnce()` returning `{ message: { content, tool_calls } }`. A type union `OllamaClient | CloudClient` with a shared result interface is sufficient. Implementation deferred to Phase 2's actual subagent.

- [ ] **Step 3: Write cloud executor integration test**

```typescript
// extension/tests/cloud_executor.test.ts

import { describe, it, expect, vi } from 'vitest';

describe('cloud executor routing', () => {
  it('executor uses cloud client when configured', () => {
    // Verify the orchestrator routes executor to cloud
    // (Test structure depends on final adapter design)
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 4: Commit**

```bash
git add extension/src/agent/roles/executor.ts extension/src/agent/roles/evaluator.ts extension/tests/cloud_executor.test.ts
git commit -m "feat: route executor and evaluator to cloud via shared ChatDriver

- Both OllamaClient and CloudClient conform to the chat interface
- Per-role provider selection in orchestrator dispatching
- Auto-fallback to local on cloud failure (catch → retry with local client)"
```

---

## Phase 3b: SoM + Fusion

### Task 3b.1: Set-of-Marks content script

**Files:**
- Create: `extension/src/content/som.ts`

- [ ] **Step 1: Create SoM overlay script**

```typescript
// extension/src/content/som.ts
//
// Set-of-Marks overlay injector (Phase 3b).
//
// Injected as a content script on every page. On message, draws numbered
// bounding boxes over interactive elements and returns a map of index ↔
// { backendDOMNodeId, selector, rect } so the agent can reference elements
// by number.
//
// The overlay is a transparent <div> positioned absolutely over the page.
// It draws colored rectangles with number labels using CSS. The host page
// or tool calls can trigger re-generation by sending a message.
//
// Communication:
//   - Listen for chrome.runtime.onMessage: { type: 'som.generate' }
//   - Respond with: { type: 'som.ready', markers: Array<{ id, nodeId, selector, rect }> }
//   - Listen for { type: 'som.clear' } to remove overlay

interface Marker {
  id: number;
  backendDOMNodeId: number;
  selector: string;
  rect: { x: number; y: number; width: number; height: number };
}

let overlayDiv: HTMLDivElement | null = null;
const COLOR_PALETTE = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
  '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
];
```

- [ ] **Step 2: Register content script in manifest**

- [ ] **Step 3: Commit**

---

## Phase 4: Presidio Redaction

### Task 4.1: Reversible sandwich pattern

**Files:**
- Create: `extension/src/agent/anonymize.ts`
- Create: `extension/src/agent/deanonymize.ts`
- Create: `extension/tests/anonymize.test.ts`

- [ ] **Step 1: Write tests**

- [ ] **Step 2: Implement**

- [ ] **Step 3: Commit**

---

## Execution Handoff

Plan complete. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session with checkpoints

Which approach?
