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
//   4. If backendDOMNodeId provided:
//        DOM.resolveNode -> DOM.requestNode -> nodeId
//      If selector provided:
//        DOM.getDocument -> DOM.querySelector -> nodeId
//   5. DOM.getContentQuads -> quads
//   6. Compute click center: x0 + (offsetX ?? width/2), y0 + (offsetY ?? height/2)
//   7. Input.dispatchMouseEvent(mousePressed) -> Input.dispatchMouseEvent(mouseReleased)
//   8. chrome.debugger.detach({tabId})  (in finally block)

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

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Resolve an element to viewport coordinates via CDP.
 *
 * Two resolution paths:
 *   1. backendDOMNodeId (preferred) — uses DOM.resolveNode + DOM.requestNode
 *   2. CSS selector (fallback) — uses DOM.getDocument + DOM.querySelector
 *
 * Both paths yield a DOM nodeId which is passed to DOM.getContentQuads to
 * get the element's bounding box in viewport coordinates. The click center
 * is computed as the element origin plus either the explicit offset or
 * half the element's width/height.
 */
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
    // Path 1: resolve from backendDOMNodeId (from ARIA tree)
    const resolveResult = await chrome.debugger.sendCommand(target, 'DOM.resolveNode', {
      backendNodeId: backendDOMNodeId,
    });
    if (!resolveResult?.object?.objectId) {
      throw new BrowserToolError(
        `tab.click: could not resolve backendDOMNodeId ${backendDOMNodeId}`,
        { fatal: false },
      );
    }
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
    // Path 2: fallback to CSS selector
    const docResult = await chrome.debugger.sendCommand(target, 'DOM.getDocument', { depth: 0 });
    const documentNodeId = (docResult as { root?: { nodeId: number } })?.root?.nodeId;
    if (typeof documentNodeId !== 'number') {
      throw new BrowserToolError('tab.click: could not get document', { fatal: true });
    }
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
    // Should be unreachable because argsSchema.refine enforces at least one
    throw new BrowserToolError('tab.click: no backendDOMNodeId or selector provided', {
      fatal: false,
    });
  }

  // Get bounding box via DOM.getContentQuads
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
