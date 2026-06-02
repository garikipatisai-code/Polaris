// Page-action tools for M3 — click, type, select.
//
// These tools use CDP (Chrome DevTools Protocol) to interact with a real browser
// page, as opposed to the earlier M2 mock tools and the M3 read-only extraction
// tools (aria.extract, search). They are domain-tier gated so that the agent
// can read any page but needs explicit user trust to mutate it.
//
// Element resolution paths (in order of preference):
//   1. index (from aria.extract) — prefer this; uses cached bounding box directly,
//      skipping the DOM tree walk entirely. Fastest and most reliable.
//   2. backendDOMNodeId (from aria.extract) — avoids the DOM tree walk and is
//      resilient to page DOM renames between ARIA and action.
//   3. CSS selector — fallback when the model constructs a selector from
//      visual information.
//
// CDP flow (exactly):
//   1. chrome.tabs.get(tabId) -> url + status
//   2. assertCanAct(url, required-tier)
//   3. If index provided: look up cached bbox from aria_types -> compute center
//      -> dispatch mouse events directly (no DOM resolution)
//   4. Otherwise: chrome.debugger.attach -> DOM resolution -> scrollIntoView ->
//      getContentQuads -> dispatch -> detach
//   5. Non-fatal errors return { ok: false, error: "..." } instead of throwing

import { z } from 'zod';
import type { ToolHandler } from '../registry';
import { BrowserToolError, withBrowserTimeout } from './lifecycle';
import { assertCanAct } from '../../domain_tiers';
import { getCachedBBox } from './aria_types';

// ──────────────────────────────────────────────────────────────────────
// tab.click
// ──────────────────────────────────────────────────────────────────────

const tabClickArgs = z
  .object({
    tabId: z.number().int(),
    index: z.number().int().positive().optional(),
    backendDOMNodeId: z.number().int().optional(),
    selector: z.string().min(1).optional(),
    button: z.enum(['left', 'right', 'middle']).optional(),
    clickCount: z.number().int().min(1).max(3).optional(),
    offsetX: z.number().int().optional(),
    offsetY: z.number().int().optional(),
  })
  .refine(
    (d) => d.index !== undefined || d.backendDOMNodeId !== undefined || d.selector !== undefined,
    { message: 'must provide index, backendDOMNodeId, or a CSS selector' },
  );

const tabClickOutput = z.object({
  action: z.literal('click'),
  x: z.number().int(),
  y: z.number().int(),
  ok: z.boolean(),
  error: z.string().optional(),
});

export const tabClickTool: ToolHandler<
  z.infer<typeof tabClickArgs>,
  z.infer<typeof tabClickOutput>
> = {
  name: 'tab.click',
  description:
    'Click on an element by its index from aria.extract (e.g. index:12). ' +
    'PREFERRED — uses cached bounding box for coordinate-based click. ' +
    'Gated by domain tier: must be at least "click-only".',
  argsSchema: tabClickArgs,
  outputSchema: tabClickOutput,
  parametersJSON: {
    type: 'object',
    properties: {
      tabId: { type: 'integer', description: 'Tab id from tab.open or tab.list.' },
      index: {
        type: 'integer',
        description: 'Element index from aria.extract output. PREFERRED — uses cached bounding box directly.',
      },
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
        return { action: 'click' as const, x: 0, y: 0, ok: false, error: `tab.click: tab ${args.tabId} not found: ${(e as Error).message}` };
      }
      const url = tab.url ?? '';
      await assertCanAct(url, 'click-only');

      // Path 1: index-based — use cached bounding box directly (no DOM resolution)
      if (args.index !== undefined) {
        const bbox = getCachedBBox(args.tabId, args.index, url);
        if (!bbox) {
          return { action: 'click' as const, x: 0, y: 0, ok: false, error: `element [${args.index}] is stale or not cached (the page may have changed) — call aria.extract again` };
        }
        const cx = Math.round(bbox.x + bbox.width / 2);
        const cy = Math.round(bbox.y + bbox.height / 2);

        const targetAttach: { tabId: number } = { tabId: args.tabId };
        try {
          await chrome.debugger.attach(targetAttach, '1.3');
          await chrome.debugger.sendCommand(targetAttach, 'Input.dispatchMouseEvent', {
            type: 'mousePressed', x: cx, y: cy, button: args.button ?? 'left', clickCount: args.clickCount ?? 1,
          });
          await chrome.debugger.sendCommand(targetAttach, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: cx, y: cy, button: args.button ?? 'left', clickCount: args.clickCount ?? 1,
          });
          return { action: 'click' as const, x: cx, y: cy, ok: true };
        } finally {
          try { await chrome.debugger.detach(targetAttach); } catch { /* best-effort */ }
        }
      }

      // Path 2: backendDOMNodeId or selector — requires CDP DOM resolution
      const targetAttach: { tabId: number } = { tabId: args.tabId };
      try {
        await chrome.debugger.attach(targetAttach, '1.3');

        try {
          const { x, y } = await resolveElementCoords(
            args.tabId,
            args.backendDOMNodeId,
            args.selector,
            args.offsetX,
            args.offsetY,
          );

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

          return { action: 'click' as const, x: Math.round(x), y: Math.round(y), ok: true };
        } catch (e) {
          if (e instanceof BrowserToolError && !e.fatal) {
            return { action: 'click' as const, x: 0, y: 0, ok: false, error: e.message };
          }
          throw e;
        }
      } finally {
        try {
          await chrome.debugger.detach(targetAttach);
        } catch {
          /* best-effort: the tab may have been closed in the meantime */
        }
      }
    }, 15_000, 'tab.click');
  },
};

// ──────────────────────────────────────────────────────────────────────────
// tab.type
// ──────────────────────────────────────────────────────────────────────────

const tabTypeArgs = z.object({
  tabId: z.number().int(),
  index: z.number().int().positive().optional(),
  selector: z.string().min(1).optional(),
  text: z.string(),
  submit: z.boolean().optional(),
});

const tabTypeOutput = z.object({
  action: z.literal('type'),
  charsTyped: z.number().int(),
  submitted: z.boolean(),
  ok: z.boolean(),
  error: z.string().optional(),
});

export const tabTypeTool: ToolHandler<z.infer<typeof tabTypeArgs>, z.infer<typeof tabTypeOutput>> = {
  name: 'tab.type',
  description:
    'Type text into an input element by index from aria.extract (e.g. index:12). ' +
    'Clicks the element first to focus. Gated by domain tier: must be "full-action".',
  argsSchema: tabTypeArgs,
  outputSchema: tabTypeOutput,
  parametersJSON: {
    type: 'object',
    properties: {
      tabId: { type: 'integer', description: 'Tab id.' },
      index: {
        type: 'integer',
        description: 'Element index from aria.extract. PREFERRED — clicks to focus before typing.',
      },
      selector: { type: 'string', description: 'CSS selector for the input element (fallback).' },
      text: { type: 'string', description: 'Text to type.' },
      submit: { type: 'boolean', description: 'Press Enter after typing. Default false.' },
    },
    required: ['tabId', 'text'],
  },
  execute: async (args) => {
    return withBrowserTimeout(async () => {
      let tab: chrome.tabs.Tab;
      try {
        tab = await chrome.tabs.get(args.tabId);
      } catch (e) {
        return { action: 'type' as const, charsTyped: 0, submitted: false, ok: false, error: `tab.type: tab ${args.tabId} not found: ${(e as Error).message}` };
      }
      await assertCanAct(tab.url ?? '', 'full-action');

      const target: { tabId: number } = { tabId: args.tabId };

      // Path 1: index-based — focus by clicking cached bbox, then type
      if (args.index !== undefined) {
        const bbox = getCachedBBox(args.tabId, args.index, tab.url ?? '');
        if (!bbox) {
          return { action: 'type' as const, charsTyped: 0, submitted: false, ok: false, error: `element [${args.index}] is stale or not cached (the page may have changed) — call aria.extract again` };
        }
        const cx = Math.round(bbox.x + bbox.width / 2);
        const cy = Math.round(bbox.y + bbox.height / 2);

        try {
          await chrome.debugger.attach(target, '1.3');

          // Click to focus
          await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
            type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1,
          });
          await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1,
          });

          // Type via Input.insertText — inserts text into the focused element
          // without depending on key-event processing pipelines. More reliable
          // than dispatchKeyEvent(type:'char') across Chrome versions.
          await chrome.debugger.sendCommand(target, 'Input.insertText', {
            text: args.text,
          });

          if (args.submit) {
            await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
              type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter',
            });
            await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
              type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter',
            });
          }

          return { action: 'type' as const, charsTyped: args.text.length, submitted: args.submit ?? false, ok: true };
        } finally {
          try { await chrome.debugger.detach(target); } catch { /* best-effort */ }
        }
      }

      // Path 2: selector-based — existing DOM query + evaluate logic
      if (!args.selector) {
        return { action: 'type' as const, charsTyped: 0, submitted: false, ok: false, error: 'tab.type: must provide index or selector' };
      }
      try {
        await chrome.debugger.attach(target, '1.3');

        try {
          const docResult = await chrome.debugger.sendCommand(target, 'DOM.getDocument', { depth: 0 });
          const documentNodeId = (docResult as { root?: { nodeId: number } })?.root?.nodeId;
          if (typeof documentNodeId !== 'number') {
            throw new BrowserToolError('tab.type: could not get document', { fatal: true });
          }
          const queryResult = await chrome.debugger.sendCommand(target, 'DOM.querySelector', {
            nodeId: documentNodeId,
            selector: args.selector!,
          });
          let elNodeId = (queryResult as { nodeId: number }).nodeId;
          if (!elNodeId) {
            // Fallback: try common search/input selectors when the model guesses wrong
            const fallbackSelectors = [
              'input[type="search"]',
              'input[type="text"]',
              '#twotabsearchtextbox',
              '[role="combobox"]',
              '[role="searchbox"]',
              'input:not([type="hidden"])',
            ];
            for (const fb of fallbackSelectors) {
              const fbResult = await chrome.debugger.sendCommand(target, 'DOM.querySelector', {
                nodeId: documentNodeId,
                selector: fb,
              });
              const fbNodeId = (fbResult as { nodeId: number }).nodeId;
              if (fbNodeId) {
                elNodeId = fbNodeId;
                console.warn(`[polaris] tab.type: selector "${args.selector}" not found; fell back to "${fb}"`);
                break;
              }
            }
            if (!elNodeId) {
              throw new BrowserToolError(`tab.type: selector "${args.selector}" matched no elements`, { fatal: false });
            }
          }

          // Clear existing content via Runtime.evaluate (handles both empty
          // and pre-filled inputs), then focus the element.
          await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
            expression: `(() => {
              const el = document.querySelector(${JSON.stringify(args.selector)});
              if (!el) return;
              if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
                el.value = '';
              } else if (el.isContentEditable) {
                el.textContent = '';
              }
              el.focus();
            })()`,
          });

          // Type via Input.insertText — inserts text into the focused element
          // without depending on key-event processing pipelines. More reliable
          // than dispatchKeyEvent(type:'char') across Chrome versions.
          await chrome.debugger.sendCommand(target, 'Input.insertText', {
            text: args.text,
          });

          if (args.submit) {
            await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
              type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter',
            });
            await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
              type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter',
            });
          }

          return { action: 'type' as const, charsTyped: args.text.length, submitted: args.submit ?? false, ok: true };
        } catch (e) {
          if (e instanceof BrowserToolError && !e.fatal) {
            return { action: 'type' as const, charsTyped: 0, submitted: false, ok: false, error: e.message };
          }
          throw e;
        }
      } finally {
        try { await chrome.debugger.detach(target); } catch { /* best-effort */ }
      }
    }, 15_000, 'tab.type');
  },
};

// ──────────────────────────────────────────────────────────────────────────
// tab.select
// ──────────────────────────────────────────────────────────────────────────

const tabSelectArgs = z.object({
  tabId: z.number().int(),
  selector: z.string().min(1),
  value: z.string().min(1),
});

const tabSelectOutput = z.object({
  action: z.literal('select'),
  selector: z.string(),
  value: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
});

export const tabSelectTool: ToolHandler<z.infer<typeof tabSelectArgs>, z.infer<typeof tabSelectOutput>> = {
  name: 'tab.select',
  description: 'Select an option in a <select> dropdown. Gated by domain tier: "click-only".',
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
        return { action: 'select' as const, selector: args.selector, value: args.value, ok: false, error: `tab.select: tab ${args.tabId} not found: ${(e as Error).message}` };
      }
      await assertCanAct(tab.url ?? '', 'click-only');

      const target: { tabId: number } = { tabId: args.tabId };
      try {
        await chrome.debugger.attach(target, '1.3');

        const expr = `(() => {
          const el = document.querySelector(${JSON.stringify(args.selector)});
          if (!el) return { ok: false, error: 'element not found' };
          if (el.tagName !== 'SELECT') return { ok: false, error: 'element is not a <select>' };
          (el as HTMLSelectElement).value = ${JSON.stringify(args.value)};
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, selectedValue: ${JSON.stringify(args.value)} };
        })()`;

        const result = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
          expression: expr,
          returnByValue: true,
        });

        const outcome = (result as { result?: { value?: { ok: boolean; error?: string } } })?.result?.value;
        if (!outcome?.ok) {
          return { action: 'select' as const, selector: args.selector, value: args.value, ok: false, error: `tab.select: ${outcome?.error ?? 'evaluation failed'}` };
        }

        return { action: 'select' as const, selector: args.selector, value: args.value, ok: true };
      } finally {
        try { await chrome.debugger.detach(target); } catch { /* best-effort */ }
      }
    }, 10_000, 'tab.select');
  },
};

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Resolve an element to viewport coordinates via CDP.
 *
 * Called only by tab.click, so all error messages are prefixed 'tab.click:'.
 *
 * DOM.getDocument is always called first to initialise the DOM agent for this
 * debugger session; without it, DOM.requestNode and DOM.querySelector both fail
 * with "Could not find node with given id" on a real page.
 *
 * Two resolution paths (both share the document node from getDocument):
 *   1. backendDOMNodeId (preferred) — DOM.resolveNode + DOM.requestNode
 *   2. CSS selector (fallback) — DOM.querySelector against the document node
 *
 * After obtaining a nodeId, DOM.scrollIntoViewIfNeeded runs before
 * DOM.getContentQuads so that off-screen elements are scrolled into the
 * viewport; getContentQuads returns viewport-relative coordinates, so a
 * below-fold element would otherwise yield a quad the mouse event misses.
 * scrollIntoViewIfNeeded is best-effort and failures are swallowed.
 *
 * The click center is the element origin plus either the explicit offset or
 * half the element's width/height (Math.floor).
 */
async function resolveElementCoords(
  tabId: number,
  backendDOMNodeId?: number,
  selector?: string,
  offsetX?: number,
  offsetY?: number,
): Promise<{ x: number; y: number }> {
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

  const quad = quads[0]!;
  if (!quad || quad.length < 4) {
    throw new BrowserToolError('tab.click: empty quad data', { fatal: false });
  }
  // Quad format: [x1, y1, x2, y2, x3, y3, x4, y4] where corners are
  // top-left, top-right, bottom-right, bottom-left in viewport coordinates.
  const x0 = quad[0]!;
  const y0 = quad[1]!;
  const x2 = quad[4]!;
  const y2 = quad[5]!;

  const cx = x0 + (offsetX ?? Math.floor((x2 - x0) / 2));
  const cy = y0 + (offsetY ?? Math.floor((y2 - y0) / 2));

  return { x: cx, y: cy };
}
