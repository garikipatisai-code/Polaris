// Shared types for the simplified ARIA tree extracted via chrome.debugger
// (`Accessibility.getFullAXTree`). Locked in advance so retailer adapters and
// tab tools can typecheck against the contract while the parser is built in
// parallel.
//
// The "simplified" tree drops nodes that carry no semantic value (generic
// containers without name/value, deeply-nested wrappers) and is token-bounded
// before serialization for the model.
//
// Element indices (`i` field) are assigned by simplifyAxTree to every
// interactive/focusable node, providing stable references for tool dispatch
// (click by index, type at index). Bounding boxes (`bbox`) are populated from
// CDP's DOM.getContentQuads when available.

/** Bounding box in viewport coordinates. */
export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A single node in the simplified tree. Output of aria.simplifyAxTree. */
export interface SimplifiedNode {
  /** ARIA role: "button", "link", "textbox", "heading", "main", etc. */
  role: string;
  /** Element index for tool dispatch (click/type by index). Assigned sequentially. */
  i?: number;
  /** Accessible name. Optional — many structural nodes have none. */
  name?: string;
  /** Current value (text-input contents, slider position, etc.). */
  value?: string;
  /** Bounding box relative to viewport, derived from CDP content quads. */
  bbox?: BBox;
  /**
   * CDP backend DOM node id, propagated from `AXNode.backendDOMNodeId`.
   * This is the cheapest stable handle for downstream action tools (M4):
   * `chrome.debugger.sendCommand({tabId}, 'DOM.resolveNode', {backendNodeId})`
   * yields a CDP RemoteObject we can dispatch clicks / typing through
   * without re-walking selectors. Preserved across `collapseWrapperChain`
   * (the surviving inner node's id wins) and `applyTokenCap` clones.
   *
   * Optional because synthesized nodes (the `document` wrapper in
   * `simplifyAxTree`, the `[truncated]` marker) have no DOM backing.
   */
  backendDOMNodeId?: number;
  /** Children, after generic-container collapse. */
  children?: SimplifiedNode[];
}

/**
 * The flat-tree shape Chrome DevTools Protocol returns from
 * Accessibility.getFullAXTree. We only model the fields the parser needs.
 * (Fields like frameId, ignored, etc. are intentionally ignored —
 * they're not actionable at the agent level.)
 */
export interface AXNode {
  nodeId: string;
  parentId?: string;
  childIds?: string[];
  role?: { value: string };
  name?: { value: string };
  value?: { value: string | number | boolean };
  /** CDP-emitted DOM-side handle. Required for action-tool dispatch in M4. */
  backendDOMNodeId?: number;
  ignored?: boolean;
  /** Bounding box in CDP format [x1,y1,x2,y2,x3,y3,x4,y4]. */
  bounds?: { value: { x: number; y: number }[] };
}

/** Wraps the raw CDP response. */
export interface AXTree {
  nodes: AXNode[];
}

/** Default output cap, in serialized JSON chars. With Gemma 4's 128K context. */
export const ARIA_OUTPUT_CHAR_CAP = 8000;

/**
 * In-memory cache: tabId → flattend array of indexed SimplifiedNodes.
 * Populated by aria.extract, consumed by tab.click / tab.type / tab.select.
 * The cache is scoped to a single agent task and cleared on tab close.
 */
const elementCache = new Map<number, { nodes: SimplifiedNode[]; tree: SimplifiedNode; url?: string }>();

export function cacheElements(tabId: number, tree: SimplifiedNode, url?: string): void {
  const flat: SimplifiedNode[] = [];
  function walk(n: SimplifiedNode) {
    if (n.i !== undefined) flat.push(n);
    if (n.children) n.children.forEach(walk);
  }
  walk(tree);
  elementCache.set(tabId, { nodes: flat, tree, url });
  // Cap cache at 10 entries to avoid unbounded growth across many tabs
  if (elementCache.size > 10) {
    const first = elementCache.keys().next().value;
    if (first !== undefined) elementCache.delete(first);
  }
}

/**
 * A cache entry is stale when it was stamped with a URL and the caller's
 * current URL differs (the tab navigated since extraction). When either URL
 * is unknown we cannot prove staleness, so we serve the entry (back-compat).
 */
function isStale(entry: { url?: string } | undefined, currentUrl?: string): boolean {
  return (
    entry !== undefined &&
    entry.url !== undefined &&
    currentUrl !== undefined &&
    entry.url !== currentUrl
  );
}

export function getCachedBBox(tabId: number, index: number, currentUrl?: string): BBox | undefined {
  const entry = elementCache.get(tabId);
  if (!entry || isStale(entry, currentUrl)) return undefined;
  return entry.nodes.find((n) => n.i === index)?.bbox;
}

export function getCachedNode(tabId: number, index: number, currentUrl?: string): SimplifiedNode | undefined {
  const entry = elementCache.get(tabId);
  if (!entry || isStale(entry, currentUrl)) return undefined;
  return entry.nodes.find((n) => n.i === index);
}

export function clearElementCache(tabId: number): void {
  elementCache.delete(tabId);
}

export function clearAllCaches(): void {
  elementCache.clear();
}
