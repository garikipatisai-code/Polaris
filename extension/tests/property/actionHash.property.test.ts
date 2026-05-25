// Property-based tests for actionHash / stableStringify.
//
// actionHash(name, args) builds `${name}::${stableStringify(args)}` where
// stableStringify recursively sorts object keys but preserves array order.
// These properties pin down the canonicalisation contract that the circuit
// breaker relies on for stuck-loop detection.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { actionHash } from '../../src/agent/circuit_breaker';

const NUM_RUNS = 100;

/** Re-build a record with its keys in a different (specifically, reversed) order. */
function reorderKeys<T extends Record<string, unknown>>(obj: T): T {
  const reversed: Record<string, unknown> = {};
  const keys = Object.keys(obj).reverse();
  for (const k of keys) reversed[k] = obj[k];
  return reversed as T;
}

/** Recursive deep-clone that walks objects/arrays; cheap because tests stay small. */
function deepClone<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => deepClone(x)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = deepClone(val);
  }
  return out as T;
}

/**
 * Recursively reorder all object keys in a value (objects only — arrays keep
 * their order). Used to test deep key-order invariance.
 */
function deepReorderKeys<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => deepReorderKeys(x)) as unknown as T;
  const reordered: Record<string, unknown> = {};
  const keys = Object.keys(v as Record<string, unknown>).reverse();
  for (const k of keys) {
    reordered[k] = deepReorderKeys((v as Record<string, unknown>)[k]);
  }
  return reordered as T;
}

// JSON-safe primitive arbitrary (no NaN / Infinity / undefined surprises that
// JSON.stringify silently coerces).
const jsonPrimitive = fc.oneof(
  fc.integer(),
  fc.boolean(),
  fc.string({ maxLength: 20 }),
  fc.constant(null),
);

// JSON-safe value arbitrary, bounded depth so 100 runs stay fast.
const jsonSafeValue = fc.letrec((tie) => ({
  value: fc.oneof(
    { maxDepth: 4 },
    jsonPrimitive,
    fc.array(tie('value'), { maxLength: 5 }),
    fc.dictionary(fc.string({ maxLength: 5 }), tie('value'), { maxKeys: 5 }),
  ),
})).value;

const jsonSafeRecord = fc.dictionary(fc.string({ maxLength: 5 }), jsonSafeValue, {
  minKeys: 0,
  maxKeys: 5,
});

describe('actionHash — property tests', () => {
  it('is invariant under top-level object key reordering', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 20 }),
        jsonSafeRecord,
        (name, obj) => {
          return actionHash(name, obj) === actionHash(name, reorderKeys(obj));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('is invariant under deep (nested) object key reordering', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 20 }),
        jsonSafeRecord,
        (name, obj) => {
          return actionHash(name, obj) === actionHash(name, deepReorderKeys(obj));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('produces equal hashes for deep-equal but distinct argument objects', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 20 }),
        jsonSafeValue,
        (name, args) => {
          const cloned = deepClone(args);
          // Ensure they're really distinct refs (when objects/arrays).
          if (typeof args === 'object' && args !== null) {
            expect(cloned).not.toBe(args);
          }
          return actionHash(name, args) === actionHash(name, cloned);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('produces different hashes when the tool name differs', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 20 }),
        fc.string({ maxLength: 20 }),
        jsonSafeValue,
        (name1, name2, args) => {
          fc.pre(name1 !== name2);
          return actionHash(name1, args) !== actionHash(name2, args);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('is deterministic — same input twice yields the same hash', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 20 }),
        jsonSafeValue,
        (name, args) => {
          return actionHash(name, args) === actionHash(name, args);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('treats arrays as order-sensitive (reverse changes the hash)', () => {
    // Pick non-trivial arrays: at least 2 distinct elements so reversing
    // yields a genuinely different sequence.
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 2, maxLength: 8 }).filter((arr) => {
          // Need at least one position where a[i] !== a[reversed_i].
          const rev = [...arr].reverse();
          return arr.some((x, i) => x !== rev[i]);
        }),
        (arr) => {
          const reversed = [...arr].reverse();
          return actionHash('t', arr) !== actionHash('t', reversed);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('does not throw on adversarial / edge-case inputs', () => {
    // anything() may emit Date/Map/Set/typed arrays/etc; the implementation
    // delegates to JSON.stringify for non-objects/non-arrays which can yield
    // odd-but-defined output. The contract here is: never throws, always
    // produces a string that starts with `${name}::`.
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), fc.anything(), (name, args) => {
        const h = actionHash(name, args);
        expect(typeof h).toBe('string');
        expect(h.startsWith(`${name}::`)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('handles explicit corner cases without throwing', () => {
    // Hand-written corners that the random generators may miss reliably.
    const corners: unknown[] = [
      undefined,
      null,
      '',
      [],
      {},
      0,
      false,
      // Deep nesting (10+ levels) — exercises stableStringify recursion.
      (() => {
        let v: unknown = 'leaf';
        for (let i = 0; i < 12; i++) v = { wrap: v };
        return v;
      })(),
      // Mixed array of mixed nesting.
      [{ a: [1, { b: [2, { c: 3 }] }] }],
    ];
    for (const c of corners) {
      const h = actionHash('tool', c);
      expect(typeof h).toBe('string');
      expect(h.startsWith('tool::')).toBe(true);
      // Stable: a second call gives the same result.
      expect(actionHash('tool', c)).toBe(h);
    }
  });
});
