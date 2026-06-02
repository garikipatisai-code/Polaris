// ARIA tree extraction for the agent's primary page-understanding channel.
//
// Raw HTML is too noisy for a 4-billion-parameter local model — class names,
// inline styles, ad-network markup, and React's data-attributes all consume
// tokens without informing decisions. The ARIA accessibility tree, exposed
// by Chrome DevTools Protocol's `Accessibility.getFullAXTree`, is the same
// thing screen readers consume: a (role, name, value, children) hierarchy
// that captures semantic page structure stripped of presentational noise.
//
// `simplifyAxTree` does two passes on top of the raw CDP tree:
//
//   1. STRUCTURAL — assemble children from `childIds`, skip `ignored:true`
//      nodes (CDP marks accessibility-irrelevant entries this way) but
//      recurse into their children, and drop "wrapper" nodes whose role
//      carries no semantic value (`generic`, `none`, `presentation`,
//      `RootWebArea`, or empty) when they have no name/value of their own.
//      Their children are spliced into the parent's children list.
//
//   2. COLLAPSE — after structural pruning, single-child wrapper chains
//      can still appear (e.g., a `list` with a single `listitem`). One
//      collapse iteration replaces such a wrapper with its only child.
//      Capped at 5 iterations to keep this O(depth) on pathological trees.
//
// After simplification the tree is run through a token-cap pass. Models
// don't gracefully degrade past their context budget — they hallucinate
// or stall. We bound the serialized output at `ARIA_OUTPUT_CHAR_CAP` by
// trimming deepest leaves; if 10 passes don't suffice the outermost
// children are truncated and a synthetic `note` marker is appended so the
// model knows the tree was abridged.
//
// `ariaExtractTool` wraps the parser as a registry-compatible tool. The
// chrome.debugger lifecycle (attach → enable → fetch → detach) is wrapped
// in `withBrowserTimeout(30s)`; failures throw `BrowserToolError` so the
// circuit breaker can distinguish a permission/crash (fatal) from a
// transient timeout (recoverable).

import { z } from 'zod';
import type { ToolHandler } from '../registry';
import type { AXNode, AXTree, SimplifiedNode } from './aria_types';
import { ARIA_OUTPUT_CHAR_CAP } from './aria_types';
import { BrowserToolError, withBrowserTimeout } from './lifecycle';

/** Roles to drop when the node carries no name/value. Children get spliced
 *  into the parent's children list. */
const DROPPABLE_ROLES: ReadonlySet<string> = new Set([
  'generic',
  'none',
  'presentation',
  'RootWebArea',
  '',
]);

/** Maximum number of collapse iterations applied to single-child wrapper
 *  chains. Pathological trees should not infinite-loop the parser. */
const MAX_COLLAPSE_ITERATIONS = 5;

/** Maximum number of trim passes before falling back to outermost-children
 *  truncation. */
const MAX_TRIM_PASSES = 10;

/** Synthetic marker appended when fallback truncation fires. */
const TRUNCATION_MARKER: SimplifiedNode = {
  role: 'note',
  name: '[truncated for budget]',
};

/**
 * Convert a CDP accessibility tree into the simplified
 * (role, name, value, children) hierarchy the model consumes.
 *
 * Returns null when the input has no nodes or no discoverable root.
 */
export function simplifyAxTree(tree: AXTree, viewport?: { width: number; height: number }, maxChars: number = ARIA_OUTPUT_CHAR_CAP): SimplifiedNode | null {
  if (!tree.nodes || tree.nodes.length === 0) return null;

  const byId = new Map<string, AXNode>();
  for (const node of tree.nodes) {
    byId.set(node.nodeId, node);
  }

  const root = findRoot(tree.nodes, byId);
  if (!root) return null;

  // Track visited ids to defend against cyclic / malformed CDP payloads.
  const visited = new Set<string>();
  const built = buildSimplified(root, byId, visited);
  if (built.length === 0) return null;

  let result: SimplifiedNode;
  if (built.length === 1) {
    result = built[0]!;
  } else {
    // Multiple promoted-to-root nodes (root was droppable with multiple
    // descendants). Wrap them in a synthesized `document` so the contract
    // — a single SimplifiedNode — holds.
    result = { role: 'document', children: built };
  }

  result = collapseWrapperChain(result);

  // Assign sequential indices to nodes that have a backendDOMNodeId and a
  // meaningful role. These are the elements the agent can interact with via
  // tab.click / tab.type / tab.select.
  let nextIndex = 1;
  function assignIndices(n: SimplifiedNode): void {
    if (
      n.backendDOMNodeId !== undefined &&
      !['RootWebArea', 'generic', 'none', 'presentation', '', 'document'].includes(n.role)
    ) {
      n.i = nextIndex++;
    }
    if (n.children) n.children.forEach(assignIndices);
  }
  assignIndices(result);

  // Viewport-aware visibility filtering: count interactive elements that are
  // visible, above the fold, or below the fold, and prepend a summary note.
  // Above-fold elements have bottom-edge above 0 (scrolled past); below-fold
  // elements have top-edge below viewport height.
  if (viewport && viewport.width > 0 && viewport.height > 0) {
    let visible = 0, belowFold = 0, aboveFold = 0, totalInteractive = 0;
    function countVisible(n: SimplifiedNode): void {
      if (n.i !== undefined) {
        totalInteractive++;
        if (n.bbox) {
          const above = n.bbox.y + n.bbox.height < 0;
          const below = n.bbox.y > viewport!.height;
          if (above) aboveFold++;
          else if (below) belowFold++;
          else visible++;
        }
      }
      if (n.children) n.children.forEach(countVisible);
    }
    countVisible(result);
    // Add viewport summary as first child note
    if (!result.children) result.children = [];
    result.children.unshift({
      role: 'note',
      name: `viewport: ${visible} visible, ${belowFold} below fold, ${aboveFold} above, ${totalInteractive} interactive elements total`,
    });
  }

  result = applyTokenCap(result, maxChars);
  return result;
}

/**
 * Find the root AX node: prefer a node with no `parentId`, falling back to
 * a node whose `parentId` does not resolve in the node-set (the latter
 * signals a partial / disconnected tree, which still has an effective root).
 */
function findRoot(nodes: AXNode[], byId: Map<string, AXNode>): AXNode | null {
  for (const n of nodes) {
    if (n.parentId === undefined || n.parentId === null) return n;
  }
  for (const n of nodes) {
    if (n.parentId !== undefined && !byId.has(n.parentId)) return n;
  }
  return null;
}

/**
 * Recursive build pass. Returns an array because dropping a node splices
 * its (already-simplified) children up to the caller's level.
 *
 *   - `ignored:true` → skip self, return children
 *   - droppable role + no name/value → drop self, return children
 *   - otherwise → return [{ role, name?, value?, children? }]
 */
function buildSimplified(
  node: AXNode,
  byId: Map<string, AXNode>,
  visited: Set<string>,
): SimplifiedNode[] {
  if (visited.has(node.nodeId)) return [];
  visited.add(node.nodeId);

  const childIds = node.childIds ?? [];
  const childResults: SimplifiedNode[] = [];
  for (const childId of childIds) {
    const child = byId.get(childId);
    if (!child) continue;
    childResults.push(...buildSimplified(child, byId, visited));
  }

  // Ignored nodes are skipped but their (already-simplified) children
  // surface to the caller's level.
  if (node.ignored === true) return childResults;

  const role = node.role?.value ?? '';
  const name = node.name?.value;
  const rawValue = node.value?.value;
  const valueStr = rawValue === undefined ? undefined : String(rawValue);
  const hasName = typeof name === 'string' && name.length > 0;
  const hasValue = typeof valueStr === 'string' && valueStr.length > 0;

  if (DROPPABLE_ROLES.has(role) && !hasName && !hasValue) {
    return childResults;
  }

  const simplified: SimplifiedNode = { role: role || 'unknown' };
  if (hasName) simplified.name = name;
  if (hasValue) simplified.value = valueStr;
  // Propagate backendDOMNodeId — the M4 action tools (page.click, page.type,
  // ...) resolve this through CDP `DOM.resolveNode` to obtain a clickable
  // RemoteObject without re-walking selectors. Skip when absent (synthesized
  // / ignored / partial-tree nodes).
  if (typeof node.backendDOMNodeId === 'number') {
    simplified.backendDOMNodeId = node.backendDOMNodeId;
  }
  // Populate bounding box from CDP bounds quad [x1,y1,x2,y2,x3,y3,x4,y4]
  if (node.bounds?.value && node.bounds.value.length >= 4) {
    const pts = node.bounds.value;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    simplified.bbox = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
  }
  if (childResults.length > 0) simplified.children = childResults;
  return [simplified];
}

/**
 * Collapse single-child wrapper chains throughout the tree. For each node,
 * if it has exactly one child and no name/value, it is replaced by that
 * child. Applied recursively (children first), with each collapse chain
 * capped at MAX_COLLAPSE_ITERATIONS to avoid pathological recursion.
 */
function collapseWrapperChain(node: SimplifiedNode): SimplifiedNode {
  // Collapse children first so a chain like A > B > C resolves bottom-up
  // before we evaluate A's collapsibility.
  if (node.children && node.children.length > 0) {
    node.children = node.children.map(collapseWrapperChain);
  }
  let current = node;
  for (let i = 0; i < MAX_COLLAPSE_ITERATIONS; i++) {
    const hasName = typeof current.name === 'string' && current.name.length > 0;
    const hasValue = typeof current.value === 'string' && current.value.length > 0;
    const children = current.children;
    if (!hasName && !hasValue && children && children.length === 1) {
      current = children[0]!;
      continue;
    }
    break;
  }
  return current;
}

/**
 * Bound the serialized tree to ARIA_OUTPUT_CHAR_CAP. First tries up to
 * MAX_TRIM_PASSES of "remove all leaves at the current max depth"; if that
 * still doesn't fit, truncates the outermost children array and appends a
 * synthetic note so the model knows the tree was abridged.
 */
function applyTokenCap(root: SimplifiedNode, maxChars: number = ARIA_OUTPUT_CHAR_CAP): SimplifiedNode {
  if (JSON.stringify(root).length <= maxChars) return root;

  // Deep-clone so we don't mutate caller-visible state during trimming.
  const working = cloneNode(root);
  for (let pass = 0; pass < MAX_TRIM_PASSES; pass++) {
    const depth = computeMaxDepth(working);
    if (depth === 0) break; // root has no children left to trim
    pruneLeavesAtDepth(working, depth);
    if (JSON.stringify(working).length <= maxChars) return working;
  }

  // Fallback: chop the outermost children array down and append the
  // truncation marker. We grow `kept` from zero until adding one more
  // child would push the serialization back over cap.
  const trimmed = cloneNode(root);
  const originalChildren = trimmed.children ?? [];
  let kept = 0;
  while (kept < originalChildren.length) {
    const candidate: SimplifiedNode = {
      ...trimmed,
      children: [...originalChildren.slice(0, kept + 1), TRUNCATION_MARKER],
    };
    if (JSON.stringify(candidate).length > maxChars) break;
    kept++;
  }
  trimmed.children = [...originalChildren.slice(0, kept), TRUNCATION_MARKER];
  return trimmed;
}

/** Deep-clone a SimplifiedNode (children are recursively cloned). */
function cloneNode(node: SimplifiedNode): SimplifiedNode {
  const out: SimplifiedNode = { role: node.role };
  if (node.name !== undefined) out.name = node.name;
  if (node.value !== undefined) out.value = node.value;
  if (node.backendDOMNodeId !== undefined) out.backendDOMNodeId = node.backendDOMNodeId;
  if (node.i !== undefined) out.i = node.i;
  if (node.bbox !== undefined) out.bbox = { ...node.bbox };
  if (node.children) out.children = node.children.map(cloneNode);
  return out;
}

/** Maximum depth of the tree (root alone = 0). */
function computeMaxDepth(node: SimplifiedNode, depth = 0): number {
  if (!node.children || node.children.length === 0) return depth;
  let m = depth;
  for (const c of node.children) {
    const d = computeMaxDepth(c, depth + 1);
    if (d > m) m = d;
  }
  return m;
}

/**
 * Mutating walk: at every node whose children sit at exactly `target`
 * depth, drop the children that are themselves leaves. Parents whose
 * children all became empty have their `children` field deleted so they
 * become leaves on the next pass.
 */
function pruneLeavesAtDepth(node: SimplifiedNode, target: number, depth = 0): void {
  if (!node.children || node.children.length === 0) return;
  if (depth + 1 === target) {
    node.children = node.children.filter(
      (c) => c.children !== undefined && c.children.length > 0,
    );
    if (node.children.length === 0) delete node.children;
    return;
  }
  for (const c of node.children) {
    pruneLeavesAtDepth(c, target, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/** SimplifiedNode mirrored as a Zod schema. Recursive — uses z.lazy. */
const SimplifiedNodeSchema: z.ZodType<SimplifiedNode> = z.lazy(() =>
  z.object({
    role: z.string(),
    name: z.string().optional(),
    value: z.string().optional(),
    i: z.number().int().positive().optional(),
    bbox: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      })
      .optional(),
    backendDOMNodeId: z.number().int().nonnegative().optional(),
    children: z.array(SimplifiedNodeSchema).optional(),
  }),
);

const AriaExtractArgsSchema = z.object({
  tabId: z.number().int().positive(),
});

const AriaExtractOutputSchema = z.object({
  tree: SimplifiedNodeSchema.nullable(),
});

type AriaExtractArgs = z.infer<typeof AriaExtractArgsSchema>;
type AriaExtractOutput = z.infer<typeof AriaExtractOutputSchema>;

/**
 * Execute the chrome.debugger lifecycle and return the simplified tree.
 *
 * The four-step CDP dance — attach, enable, getFullAXTree, detach — runs
 * inside withBrowserTimeout(30s). The detach call is wrapped in its own
 * try/catch so a fetch failure doesn't leave the debugger orphaned.
 *
 * Failures throw BrowserToolError:
 *   - chrome.debugger unavailable (test env) → fatal:true (cannot retry)
 *   - attach/enable/detach errors                → fatal:false
 *   - getFullAXTree throwing                     → fatal:false
 */
async function runExtraction(tabId: number, maxChars?: number): Promise<AriaExtractOutput> {
  const debuggerApi = (
    globalThis as unknown as {
      chrome?: { debugger?: typeof chrome.debugger };
    }
  ).chrome?.debugger;
  if (!debuggerApi) {
    throw new BrowserToolError('chrome.debugger unavailable', { fatal: true });
  }

  const target: chrome.debugger.Debuggee = { tabId };
  let attached = false;
  try {
    await callDebugger<void>((cb) => debuggerApi.attach(target, '1.3', cb));
    attached = true;
    await callDebugger<unknown>((cb) =>
      debuggerApi.sendCommand(target, 'Accessibility.enable', undefined, cb),
    );
    // Get viewport dimensions for visibility filtering
    let viewportWidth = 0, viewportHeight = 0;
    try {
      const metrics = await callDebugger<{ contentSize?: { width: number; height: number } }>((cb) =>
        debuggerApi.sendCommand(target, 'Page.getLayoutMetrics', undefined, cb),
      );
      if (metrics?.contentSize) {
        viewportWidth = Math.round(metrics.contentSize.width);
        viewportHeight = Math.round(metrics.contentSize.height);
      }
    } catch { /* best-effort */ }

    const raw = await callDebugger<unknown>((cb) =>
      debuggerApi.sendCommand(target, 'Accessibility.getFullAXTree', undefined, cb),
    );
    const axTree = coerceAXTree(raw);
    const simplified = simplifyAxTree(axTree, viewportWidth > 0 ? { width: viewportWidth, height: viewportHeight } : undefined, maxChars);
    if (simplified) {
      // Stamp the source URL so cached bounding boxes / nodes are invalidated
      // when the tab later navigates (e.g. after a search submit). Best-effort:
      // an unreadable URL stays undefined (then reads never claim staleness).
      let url: string | undefined;
      try {
        const tab = await (globalThis as unknown as { chrome?: { tabs?: { get?: (id: number) => Promise<{ url?: string }> } } })
          .chrome?.tabs?.get?.(tabId);
        url = tab?.url;
      } catch { /* best-effort */ }
      const { cacheElements } = await import('./aria_types');
      cacheElements(tabId, simplified, url);
    }
    return { tree: simplified };
  } catch (e) {
    if (e instanceof BrowserToolError) throw e;
    const msg = (e as Error).message;
    const hint = /no tab with given id/i.test(msg) ? ' — call tab.list() to discover active tabs' : '';
    throw new BrowserToolError(`aria.extract failed: ${msg}${hint}`, { fatal: false });
  } finally {
    if (attached) {
      try {
        await callDebugger<void>((cb) => debuggerApi.detach(target, cb));
      } catch {
        // Best-effort detach. A failed detach is bad but not fatal — the
        // tab will be cleaned up by Chrome on close.
      }
    }
  }
}

/**
 * Promisify a chrome.debugger callback-style call. Resolves with the
 * passed value (or undefined for void calls); rejects when
 * `chrome.runtime.lastError` is set.
 */
function callDebugger<T>(invoke: (cb: (result?: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    invoke((result) => {
      const lastError = (
        globalThis as unknown as { chrome?: { runtime?: { lastError?: { message?: string } } } }
      ).chrome?.runtime?.lastError;
      if (lastError) {
        reject(new Error(lastError.message ?? 'chrome.debugger error'));
        return;
      }
      resolve(result as T);
    });
  });
}

/** Narrow `unknown` returned by sendCommand into an AXTree. */
function coerceAXTree(raw: unknown): AXTree {
  if (raw && typeof raw === 'object' && 'nodes' in raw) {
    const nodes = (raw as { nodes: unknown }).nodes;
    if (Array.isArray(nodes)) return { nodes: nodes as AXNode[] };
  }
  return { nodes: [] };
}

/**
 * Shared fresh-extraction helper used by both aria.extract and page.extract.
 * Runs runExtraction through the 30s browser timeout and returns just the
 * simplified tree (or null). Always hits the live DOM, so callers never serve
 * stale cached data after a navigation.
 */
export async function freshAriaTree(tabId: number, maxChars?: number): Promise<SimplifiedNode | null> {
  const { tree } = await withBrowserTimeout(() => runExtraction(tabId, maxChars), 30_000, 'aria.extract');
  return tree;
}

export const ariaExtractTool: ToolHandler<AriaExtractArgs, AriaExtractOutput> = {
  name: 'aria.extract',
  description:
    'Extract a simplified ARIA accessibility tree from a tab. Each interactive element gets an index [1], [2], ... and a bounding box. ' +
    'FIRST tool to call on any new page — use it to discover elements and their indices for click/type by index.',
  argsSchema: AriaExtractArgsSchema,
  outputSchema: AriaExtractOutputSchema,
  parametersJSON: {
    type: 'object',
    properties: {
      tabId: {
        type: 'integer',
        minimum: 1,
        description: 'Chrome tab id (positive integer).',
      },
    },
    required: ['tabId'],
  },
  execute: async (args) => ({ tree: await freshAriaTree(args.tabId) }),
};
