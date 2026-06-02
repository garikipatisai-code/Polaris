// Tests for the ARIA-tree extractor (M3 cornerstone).
//
// Three structural fixtures exercise the simplify pipeline:
//   A. simple form  — drops generic wrappers, keeps button + textbox
//   B. wrapper chain — collapses div > div > div > div > headline
//   C. ignored node — skipped but its children surface
//
// Plus:
//   - token-cap pass keeps output ≤ ARIA_OUTPUT_CHAR_CAP
//   - empty input → null
//   - BrowserToolError(fatal:true) → registry yields {ok:false, fatal:true}

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { simplifyAxTree } from '../src/agent/tools/browser/aria';
import type {
  AXNode,
  AXTree,
  SimplifiedNode,
} from '../src/agent/tools/browser/aria_types';
import {
  ARIA_OUTPUT_CHAR_CAP,
  cacheElements,
  getCachedBBox,
  getCachedNode,
  clearAllCaches,
} from '../src/agent/tools/browser/aria_types';
import { BrowserToolError } from '../src/agent/tools/browser/lifecycle';
import { ToolRegistry, type ToolHandler } from '../src/agent/tools/registry';

// -----------------------------------------------------------------------------
// Fixtures (inline so the entire test is reviewable in one place)
// -----------------------------------------------------------------------------

/** Fixture A: WebArea > generic("main") > generic("form") > [button, textbox].
 *  Three layers of generic wrappers should be stripped, leaving the button
 *  and textbox surfaced under whatever the simplifier elects as root. */
const FIXTURE_SIMPLE_FORM: AXTree = {
  nodes: [
    {
      nodeId: '1',
      role: { value: 'RootWebArea' },
      name: { value: '' },
      childIds: ['2'],
    },
    {
      nodeId: '2',
      parentId: '1',
      role: { value: 'generic' },
      name: { value: '' },
      childIds: ['3'],
    },
    {
      nodeId: '3',
      parentId: '2',
      role: { value: 'generic' },
      name: { value: '' },
      childIds: ['4', '5'],
    },
    {
      nodeId: '4',
      parentId: '3',
      role: { value: 'button' },
      name: { value: 'Submit' },
    },
    {
      nodeId: '5',
      parentId: '3',
      role: { value: 'textbox' },
      name: { value: 'Email' },
    },
  ],
};

/** Fixture B: WebArea > div > div > div > div > heading("Hello").
 *  Each div is a generic wrapper with no name; should collapse to just the
 *  heading. */
const FIXTURE_WRAPPER_CHAIN: AXTree = {
  nodes: [
    {
      nodeId: '1',
      role: { value: 'RootWebArea' },
      name: { value: '' },
      childIds: ['2'],
    },
    {
      nodeId: '2',
      parentId: '1',
      role: { value: 'generic' },
      name: { value: '' },
      childIds: ['3'],
    },
    {
      nodeId: '3',
      parentId: '2',
      role: { value: 'generic' },
      name: { value: '' },
      childIds: ['4'],
    },
    {
      nodeId: '4',
      parentId: '3',
      role: { value: 'generic' },
      name: { value: '' },
      childIds: ['5'],
    },
    {
      nodeId: '5',
      parentId: '4',
      role: { value: 'generic' },
      name: { value: '' },
      childIds: ['6'],
    },
    {
      nodeId: '6',
      parentId: '5',
      role: { value: 'heading' },
      name: { value: 'Hello' },
    },
  ],
};

/** Fixture C: WebArea > [ignored container] > button.
 *  The ignored node is skipped but its children surface — the button must
 *  appear in the simplified output. */
const FIXTURE_IGNORED_NODE: AXTree = {
  nodes: [
    {
      nodeId: '1',
      role: { value: 'RootWebArea' },
      name: { value: '' },
      childIds: ['2'],
    },
    {
      nodeId: '2',
      parentId: '1',
      role: { value: 'section' },
      name: { value: 'unimportant wrapper' },
      ignored: true,
      childIds: ['3'],
    },
    {
      nodeId: '3',
      parentId: '2',
      role: { value: 'button' },
      name: { value: 'Click me' },
    },
  ],
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const DROPPABLE_ROLES = new Set([
  'generic',
  'none',
  'presentation',
  'RootWebArea',
  '',
]);

/** Walk a SimplifiedNode tree and run `visit` on every node. */
function walk(node: SimplifiedNode, visit: (n: SimplifiedNode) => void): void {
  visit(node);
  if (node.children) for (const c of node.children) walk(c, visit);
}

/** Find the first descendant (inclusive) matching the predicate. */
function find(
  node: SimplifiedNode,
  predicate: (n: SimplifiedNode) => boolean,
): SimplifiedNode | null {
  if (predicate(node)) return node;
  if (!node.children) return null;
  for (const c of node.children) {
    const m = find(c, predicate);
    if (m) return m;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Structural tests
// -----------------------------------------------------------------------------

describe('simplifyAxTree — fixture A: simple form', () => {
  it('drops generic wrappers and surfaces button + textbox with names', () => {
    const result = simplifyAxTree(FIXTURE_SIMPLE_FORM);
    expect(result).not.toBeNull();
    const root = result!;

    // No node anywhere in the tree should carry a droppable role — those
    // wrappers should have been spliced out.
    walk(root, (n) => {
      expect(DROPPABLE_ROLES.has(n.role)).toBe(false);
    });

    const button = find(root, (n) => n.role === 'button');
    expect(button).not.toBeNull();
    expect(button!.name).toBe('Submit');

    const textbox = find(root, (n) => n.role === 'textbox');
    expect(textbox).not.toBeNull();
    expect(textbox!.name).toBe('Email');
  });
});

describe('simplifyAxTree — fixture B: deeply nested wrapper chain', () => {
  it('collapses four generic wrappers down to the headline', () => {
    const result = simplifyAxTree(FIXTURE_WRAPPER_CHAIN);
    expect(result).not.toBeNull();
    expect(result).toEqual({ role: 'heading', name: 'Hello' });
  });
});

describe('simplifyAxTree — fixture C: ignored container', () => {
  it('skips the ignored node and surfaces its child', () => {
    const result = simplifyAxTree(FIXTURE_IGNORED_NODE);
    expect(result).not.toBeNull();
    expect(result).toEqual({ role: 'button', name: 'Click me' });
  });
});

// -----------------------------------------------------------------------------
// Edge cases
// -----------------------------------------------------------------------------

describe('simplifyAxTree — edge cases', () => {
  it('returns null for empty input', () => {
    expect(simplifyAxTree({ nodes: [] })).toBeNull();
  });

  it('returns null when no root can be discovered (all parentIds resolve)', () => {
    // Cyclic — every node points to a real other node as parent.
    const cyclic: AXTree = {
      nodes: [
        { nodeId: '1', parentId: '2', role: { value: 'button' }, name: { value: 'A' } },
        { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'B' } },
      ],
    };
    expect(simplifyAxTree(cyclic)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Token-cap test
// -----------------------------------------------------------------------------

describe('simplifyAxTree — token cap', () => {
  it('bounds output ≤ ARIA_OUTPUT_CHAR_CAP for a tree that would exceed it', () => {
    // Synthetic tree: one root + 1000 named-button leaves. Each leaf
    // serializes to roughly `{"role":"button","name":"button-NNN"}` ≈ 38
    // chars; 1000 * 38 ≈ 38_000 chars, well over the 4_000 char cap.
    const nodes: AXNode[] = [
      {
        nodeId: 'root',
        role: { value: 'main' },
        name: { value: 'big page' },
        childIds: Array.from({ length: 1000 }, (_, i) => `c${i}`),
      },
      ...Array.from({ length: 1000 }, (_, i) => ({
        nodeId: `c${i}`,
        parentId: 'root',
        role: { value: 'button' },
        name: { value: `button-${i.toString().padStart(4, '0')}` },
      })) satisfies AXNode[],
    ];
    const tree: AXTree = { nodes };

    // Sanity: the un-bounded serialization (just the leaves) is well over cap.
    const rawSize = JSON.stringify(nodes).length;
    expect(rawSize).toBeGreaterThan(ARIA_OUTPUT_CHAR_CAP);

    const result = simplifyAxTree(tree);
    expect(result).not.toBeNull();

    const serialized = JSON.stringify(result);
    // Allow a small slack for the truncation marker if the fallback path
    // fired — the marker itself is ~50 chars.
    expect(serialized.length).toBeLessThanOrEqual(ARIA_OUTPUT_CHAR_CAP + 80);
  });
});

// -----------------------------------------------------------------------------
// BrowserToolError → registry plumbing
// -----------------------------------------------------------------------------

describe('BrowserToolError propagation through ToolRegistry', () => {
  it('surfaces fatal:true on dispatch result when the handler throws fatal', async () => {
    const reg = new ToolRegistry();
    const throwingHandler: ToolHandler<{ x: number }, { ok: true }> = {
      name: 'aria.fake',
      description: 'fake aria-like tool that always throws fatally',
      argsSchema: z.object({ x: z.number() }),
      outputSchema: z.object({ ok: z.literal(true) }),
      parametersJSON: {
        type: 'object',
        properties: { x: { type: 'number' } },
        required: ['x'],
      },
      execute: async () => {
        throw new BrowserToolError('boom', { fatal: true });
      },
    };
    reg.register(throwingHandler);

    const result = await reg.dispatch(
      { function: { name: 'aria.fake', arguments: { x: 1 } } },
      { taskId: 't', stepId: null },
    );
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(true);
    expect(result.error).toMatch(/boom/);
  });

  it('surfaces fatal:false when the handler throws non-fatal', async () => {
    const reg = new ToolRegistry();
    const recoverableHandler: ToolHandler<{ x: number }, { ok: true }> = {
      name: 'aria.flake',
      description: 'fake aria-like tool that throws recoverably',
      argsSchema: z.object({ x: z.number() }),
      outputSchema: z.object({ ok: z.literal(true) }),
      parametersJSON: {
        type: 'object',
        properties: { x: { type: 'number' } },
        required: ['x'],
      },
      execute: async () => {
        throw new BrowserToolError('try again', { fatal: false });
      },
    };
    reg.register(recoverableHandler);

    const result = await reg.dispatch(
      { function: { name: 'aria.flake', arguments: { x: 1 } } },
      { taskId: 't', stepId: null },
    );
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(false);
  });
});

describe('simplifyAxTree: backendDOMNodeId propagation (M3.5 — unblocks M4 actions)', () => {
  it('preserves backendDOMNodeId on a normal node', () => {
    const tree: AXTree = {
      nodes: [
        { nodeId: '1', role: { value: 'main' }, childIds: ['2'] },
        {
          nodeId: '2',
          parentId: '1',
          role: { value: 'button' },
          name: { value: 'Add to Cart' },
          backendDOMNodeId: 4242,
        },
      ],
    };
    const out = simplifyAxTree(tree);
    expect(out).not.toBeNull();
    // root collapsed (main with single button child) → button surfaces
    expect(out?.role).toBe('button');
    expect(out?.name).toBe('Add to Cart');
    expect(out?.backendDOMNodeId).toBe(4242);
  });

  it('uses the surviving inner node id when collapsing single-child wrappers', () => {
    // wrapper has its own id (1001) but no name/value; inner button (2002)
    // is the actionable target. After collapse, the surviving node's id
    // must be 2002 so M4 actions click the button, not the empty wrapper.
    const tree: AXTree = {
      nodes: [
        { nodeId: '1', role: { value: 'main' }, childIds: ['2'] },
        {
          nodeId: '2',
          parentId: '1',
          role: { value: 'generic' }, // droppable
          backendDOMNodeId: 1001,
          childIds: ['3'],
        },
        {
          nodeId: '3',
          parentId: '2',
          role: { value: 'button' },
          name: { value: 'Buy Now' },
          backendDOMNodeId: 2002,
        },
      ],
    };
    const out = simplifyAxTree(tree);
    expect(out?.role).toBe('button');
    expect(out?.backendDOMNodeId).toBe(2002);
  });

  it('omits backendDOMNodeId when AXNode lacks it', () => {
    const tree: AXTree = {
      nodes: [
        {
          nodeId: '1',
          role: { value: 'button' },
          name: { value: 'Submit' },
          // no backendDOMNodeId
        },
      ],
    };
    const out = simplifyAxTree(tree);
    expect(out?.role).toBe('button');
    expect(out).not.toHaveProperty('backendDOMNodeId');
  });

  it('survives token-cap trimming with backendDOMNodeId intact on retained children', () => {
    // Force the leaf-pruning pass: each button has a verbose nested icon
    // (heavy text payload pushes us over cap). After pass 1 the icons are
    // stripped (they're leaves at depth 2), the buttons are now leaves at
    // depth 1, the tree fits under cap, and we return. The buttons must
    // retain their backendDOMNodeIds — that's the contract M4 actions need.
    const flat: AXNode[] = [
      {
        nodeId: 'root',
        role: { value: 'main' },
        name: { value: 'Page' },
        childIds: Array.from({ length: 30 }, (_, i) => `c${i}`),
      },
    ];
    for (let i = 0; i < 30; i++) {
      flat.push({
        nodeId: `c${i}`,
        parentId: 'root',
        role: { value: 'button' },
        name: { value: `B${i}` }, // short — buttons survive pass 1
        backendDOMNodeId: 1000 + i,
        childIds: [`g${i}`],
      });
      flat.push({
        nodeId: `g${i}`,
        parentId: `c${i}`,
        role: { value: 'image' },
        // Verbose name to push tree over cap so leaf-pruning fires.
        name: { value: `icon for button ${i} with very long descriptive label that consumes budget` },
        backendDOMNodeId: 5000 + i,
      });
    }
    const out = simplifyAxTree({ nodes: flat });
    expect(out).not.toBeNull();
    expect(out?.children).toBeDefined();
    expect(out!.children!.length).toBeGreaterThan(0);
    // Every surviving non-marker child must retain its backendDOMNodeId.
    for (const child of out!.children!) {
      if (child.role === 'note' && child.name === '[truncated for budget]') continue;
      expect(typeof child.backendDOMNodeId).toBe('number');
      expect(child.backendDOMNodeId).toBeGreaterThanOrEqual(1000);
      expect(child.backendDOMNodeId).toBeLessThan(2000); // top-level button ids
    }
    // And the resulting JSON is under the cap.
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(ARIA_OUTPUT_CHAR_CAP);
  });
});

describe('element cache staleness (URL-stamped)', () => {
  beforeEach(() => clearAllCaches());

  const tree: SimplifiedNode = {
    role: 'main',
    children: [{ role: 'button', name: 'Buy', i: 1, bbox: { x: 10, y: 20, width: 100, height: 40 } }],
  };

  it('returns the bbox when the current URL matches the stamped URL', () => {
    cacheElements(7, tree, 'https://site.test/a');
    expect(getCachedBBox(7, 1, 'https://site.test/a')).toEqual({ x: 10, y: 20, width: 100, height: 40 });
    expect(getCachedNode(7, 1, 'https://site.test/a')?.name).toBe('Buy');
  });

  it('MISSES when the current URL differs (page navigated)', () => {
    cacheElements(7, tree, 'https://site.test/a');
    expect(getCachedBBox(7, 1, 'https://site.test/b')).toBeUndefined();
    expect(getCachedNode(7, 1, 'https://site.test/b')).toBeUndefined();
  });

  it('returns the bbox when currentUrl is omitted (back-compat)', () => {
    cacheElements(7, tree, 'https://site.test/a');
    expect(getCachedBBox(7, 1)).toEqual({ x: 10, y: 20, width: 100, height: 40 });
  });

  it('never misses when no URL was stamped (cacheElements called without url)', () => {
    cacheElements(8, tree);
    expect(getCachedBBox(8, 1, 'https://anything.test/x')).toEqual({ x: 10, y: 20, width: 100, height: 40 });
  });
});
