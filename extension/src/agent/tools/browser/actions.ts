// Page-action tools for M3 — click, type, select.
//
// These tools use CDP (Chrome DevTools Protocol) to interact with a real browser
// page, as opposed to the earlier M2 mock tools and the M3 read-only extraction
// tools (aria.extract, search). They are domain-tier gated so that the agent
// can read any page but needs explicit user trust to mutate it.
//
// Element resolution paths (in order of preference):
//   1. backendDOMNodeId (from aria.extract) — prefer this; it avoids the DOM
//      tree walk and is resilient to page DOM renames between ARIA and action.
//   2. CSS selector — fallback when the model constructs a selector from
//      visual information.
//
// CDP flow (exactly):
//   1. chrome.tabs.get(tabId) -> url + status
//   2. assertCanAct(url, required-ter)
//   3. chrome.debugger.attach({tabId}, '1.3')
//   4. DOM.getDocument (always — initialises the DOM agent for this session)
//   5. If backendDOMNodeId provided:
//        DOM.resolveNode -> DOM.requestNode -> nodeId
//      If selector provided:
//        DOM.querySelector (using document nodeId from step 4) -> nodeId
//   6. DOM.scrollIntoViewIfNeeded (best-effort, so below-fold elements are in viewport)
//   7. DOM.getContentQuads -> quads
//   8. Compute click center: x0 + (offsetX ?? width/2), y0 + (offsetY ?? height/2)
//   9. Input.dispatchMouseEvent(mousePressed) -> Input.dispatchMouseEvent(mouseReleased)
//  10. chrome.debugger.detach({tabId})  (in finally block)

import { z } from 'zod';
import type { ToolHandler } from '../registry';
import { BrowserToolError, withBrowserTimeout } from './lifecycle';
import { assertCanAct } from '../../domain_tiers';

// ──────────────────────────────────────────────────────────────────────
// tab.click
// ──────────────────────────────────────────────────────────────────────

const tabClickArgs = z
  .object({
    tabId: z.number().int(),
    backendDOMNodeId: z.number().int().optional(),
    selector: z.string().min(1).optional(),
    button: z.enum(['left', 'right', 'middle']).optional(),
    clickCount: z.number().int().min(1).max(3).optional(),
    offsetX: z.number().int().optional(),
    offsetY: z.number().int().optional(),
  })
  .refine(
    (d) => d.backendDOMNodeId !== undefined || d.selector !== undefined,
    { message: 'must provide either backendDOMNodeId or a CSS selector' },
  );

const tabClickOutput = z.object({
  action: z.literal('click'),
  x: z.number().int(),
  y: z.number().int(),
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
      try {
        await chrome.debugger.attach(targetAttach, '1.3');

        // Resolve coordinates
        const { x, y } = await resolveElementCoords(
          args.tabId,
          args.backendDOMNodeId,
          args.selector,
          args.offsetX,
          args.offsetY,
        );

        // Dispatch click
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

        return { action: 'click' as const, x: Math.round(x), y: Math.round(y) };
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
  selector: z.string().min(1),
  text: z.string(),
  submit: z.boolean().optional(),
});

const tabTypeOutput = z.object({
  action: z.literal('type'),
  charsTyped: z.number().int(),
  submitted: z.boolean(),
});

export const tabTypeTool: ToolHandler<z.infer<typeof tabTypeArgs>, z.infer<typeof tabTypeOutput>> = {
  name: 'tab.type',
  description: 'Type text into an input element identified by CSS selector. Clears existing content first. Gated by domain tier: must be "full-action".',
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
        throw new BrowserToolError(`tab.type: tab ${args.tabId} not found: ${(e as Error).message}`, { fatal: false });
      }
      await assertCanAct(tab.url ?? '', 'full-action');

      const target: { tabId: number } = { tabId: args.tabId };
      try {
        await chrome.debugger.attach(target, '1.3');

        const docResult = await chrome.debugger.sendCommand(target, 'DOM.getDocument', { depth: 0 });
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
          throw new BrowserToolError(`tab.type: selector "${args.selector}" matched no elements`, { fatal: false });
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

        // Type each character
        for (const char of args.text) {
          await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
            type: 'char', text: char, key: char, windowsVirtualKeyCode: char.charCodeAt(0),
          });
        }

        if (args.submit) {
          await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
            type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter',
          });
          await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
            type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter',
          });
        }

        return { action: 'type', charsTyped: args.text.length, submitted: args.submit ?? false };
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
        throw new BrowserToolError(`tab.select: tab ${args.tabId} not found`, { fatal: false });
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
          throw new BrowserToolError(`tab.select: ${outcome?.error ?? 'evaluation failed'}`, { fatal: false });
        }

        return { action: 'select', selector: args.selector, value: args.value };
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
