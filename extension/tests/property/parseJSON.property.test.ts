// Property-based tests for parseJSONPermissive (planner role helper).
//
// parseJSONPermissive(s) — direct JSON.parse first, then a balanced-brace
// scan from the first `{` if direct parse fails. Throws if no balanced
// object can be extracted.
//
// Properties verified:
//  - Round-trip on object-shaped JSON values
//  - Tolerates leading/trailing whitespace
//  - Tolerates leading prose / trailing prose
//  - Tolerates markdown code fences
//  - Throws on input with no `{`
//  - Doesn't crash (only throws or returns) on adversarially-balanced input

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseJSONPermissive } from '../../src/agent/roles/planner';

const NUM_RUNS = 50;

// Object-shaped JSON arbitrary: top-level is `Record<string, JsonValue>` so
// the result, once stringified, starts with `{` (the brace-scan branch's
// precondition for the leading-prose / fences cases).
const jsonObjectArb: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 6 }),
  fc.jsonValue(),
  { minKeys: 0, maxKeys: 4, size: 'xsmall' },
) as fc.Arbitrary<Record<string, unknown>>;

describe('parseJSONPermissive — property tests', () => {
  it('round-trips arbitrary object-shaped JSON values via JSON.stringify', () => {
    fc.assert(
      fc.property(jsonObjectArb, (obj) => {
        const serialized = JSON.stringify(obj);
        const parsed = parseJSONPermissive(serialized);
        expect(parsed).toEqual(obj);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('tolerates arbitrary leading/trailing whitespace', () => {
    const wsArb = fc.stringMatching(/^[ \t\n\r]*$/, { size: 'xsmall' });
    fc.assert(
      fc.property(jsonObjectArb, wsArb, wsArb, (obj, leading, trailing) => {
        const serialized = JSON.stringify(obj);
        const padded = `${leading}${serialized}${trailing}`;
        expect(parseJSONPermissive(padded)).toEqual(obj);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('tolerates leading prose before the JSON object', () => {
    // Prose must NOT contain `{` (else first-brace position would be wrong);
    // also restrict to printable ASCII so we don't sweep up control chars
    // or unicode that JSON.parse handles inconsistently across hosts. The
    // contract under test is "leading prose tolerated", not "any byte
    // sequence tolerated."
    const proseArb = fc
      .string({ maxLength: 40 })
      .filter((s) => !s.includes('{') && /^[\x20-\x7e]*$/.test(s));
    fc.assert(
      fc.property(jsonObjectArb, proseArb, (obj, prose) => {
        const serialized = JSON.stringify(obj);
        const wrapped = `${prose} ${serialized}`;
        expect(parseJSONPermissive(wrapped)).toEqual(obj);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('tolerates trailing prose after the JSON object', () => {
    const proseArb = fc
      .string({ maxLength: 40 })
      .filter((s) => /^[\x20-\x7e]*$/.test(s));
    fc.assert(
      fc.property(jsonObjectArb, proseArb, (obj, prose) => {
        const serialized = JSON.stringify(obj);
        const wrapped = `${serialized} ${prose}`;
        expect(parseJSONPermissive(wrapped)).toEqual(obj);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('tolerates markdown code fences around the JSON', () => {
    // Behaviour confirmed by reading source + existing parseJSONPermissive
    // unit test: ```json\n{...}\n``` — direct JSON.parse fails, brace scan
    // skips the leading fence (no `{` until the JSON), finds the balanced
    // object, parses it. Triple-backticks alone (no ```json prefix) work
    // identically.
    fc.assert(
      fc.property(jsonObjectArb, (obj) => {
        const serialized = JSON.stringify(obj);
        const fenced = '```json\n' + serialized + '\n```';
        expect(parseJSONPermissive(fenced)).toEqual(obj);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('throws on input with no `{` and that is not parseable as standalone JSON', () => {
    // The implementation tries direct JSON.parse first, so a string like "42"
    // or "null" or "[1,2]" parses successfully even with no `{`. Filter those
    // out — only strings where BOTH the direct parse fails AND there's no `{`
    // can hit the "no { in output" throw branch.
    const noBraceUnparseable = fc
      .string({ minLength: 1, maxLength: 100 })
      .filter((s) => {
        if (s.includes('{')) return false;
        try {
          JSON.parse(s.trim());
          return false; // standalone-parseable; not a candidate.
        } catch {
          return true;
        }
      });
    fc.assert(
      fc.property(noBraceUnparseable, (s) => {
        expect(() => parseJSONPermissive(s)).toThrow();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('does not infinite-loop or crash on adversarially-balanced text — either parses or throws', () => {
    // Build inputs that look like JSON but mix balanced/unbalanced braces.
    // The contract is: the call returns within a few ms (no infinite loop)
    // and either yields a value OR throws with a string message — never a
    // RangeError, never a stack overflow.
    const adversarial = fc.oneof(
      fc.constant('{...}}}}}}'),
      fc.constant('}}}{...{}'),
      fc.constant('{{{{{{{}'),
      fc.constant('{"a":1}}}}'),
      fc.constant('}}}{"a":1}'),
      fc.constant('{"unclosed":'),
      fc.constant('{"x":"\\"}'),
      // Random brace soup.
      fc.string({ maxLength: 60 }).map((s) => `${s}{${s}}${s}`),
      // Unbalanced — only `{`s.
      fc.string({ maxLength: 30 }).map((s) => `${s}{`),
    );
    fc.assert(
      fc.property(adversarial, (s) => {
        // Wrap the call in a try/catch — any sync throw is acceptable; what
        // we forbid is a RangeError (stack overflow) or hangs.
        try {
          parseJSONPermissive(s);
          // Success path: parsed something. No further assertion — we just
          // want the absence of a crash.
        } catch (e) {
          // Any thrown value must be an Error with a string message.
          expect(e).toBeInstanceOf(Error);
          expect(typeof (e as Error).message).toBe('string');
          // Stack-overflow / out-of-range is the failure mode we're guarding.
          expect((e as Error).name).not.toBe('RangeError');
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
