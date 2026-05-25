// Shared types for the simplified ARIA tree extracted via chrome.debugger
// (`Accessibility.getFullAXTree`). Locked in advance so retailer adapters and
// tab tools can typecheck against the contract while the parser is built in
// parallel.
//
// The "simplified" tree drops nodes that carry no semantic value (generic
// containers without name/value, deeply-nested wrappers) and is token-bounded
// before serialization for the model.

/** A single node in the simplified tree. Output of aria.simplifyAxTree. */
export interface SimplifiedNode {
  /** ARIA role: "button", "link", "textbox", "heading", "main", etc. */
  role: string;
  /** Accessible name. Optional — many structural nodes have none. */
  name?: string;
  /** Current value (text-input contents, slider position, etc.). */
  value?: string;
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
}

/** Wraps the raw CDP response. */
export interface AXTree {
  nodes: AXNode[];
}

/** Default output cap, in serialized JSON chars. */
export const ARIA_OUTPUT_CHAR_CAP = 4000;
