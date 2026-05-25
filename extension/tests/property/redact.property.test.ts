// Property-based tests for redactPII (M3.5).
//
// Two invariants that are specifically valuable as fuzz-driven properties:
//
//   1. **Idempotence:** redact(redact(x)) === redact(x). After PII is
//      replaced with stable tokens like [CC], a second pass produces no
//      further changes — the tokens themselves don't match any pattern.
//      This holds because:
//        * Token character class `[A-Za-z]+` (e.g., "CC") doesn't match
//          digit-heavy patterns (CC, SSN, PHONE).
//        * Square brackets break word boundaries in EMAIL and ADDRESS.
//
//   2. **Output is bounded by input length** (modulo expansion from
//      replacement tokens). Pathological inputs can't make redaction
//      blow up disproportionately — the longest token is `[ADDRESS]`
//      (9 chars). For the worst case where the entire input is one
//      pattern, output length ≤ input_length + 9 (token replaces
//      content but token is at most 9 chars, content is ≥ ~10).

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { redactPII, containsPII } from '../../src/agent/redact';

const NUM_RUNS = 100;

// Bounded text to avoid generating gigabytes through fast-check.
const textArb = fc.string({ minLength: 0, maxLength: 200 });

describe('redactPII property: idempotence', () => {
  it('redact(redact(x)) === redact(x) for arbitrary text', () => {
    fc.assert(
      fc.property(textArb, (text) => {
        const once = redactPII(text);
        const twice = redactPII(once);
        expect(twice).toBe(once);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('redact(redact(x)) === redact(x) for synthesized PII-rich strings', () => {
    // Compose strings that DEFINITELY contain PII so the property
    // exercises the redaction path, not the trivial empty-input path.
    const piiyArb = fc.tuple(
      fc.constantFrom(
        '4111-1111-1111-1111',
        '123-45-6789',
        '555-867-5309',
        'jane@example.com',
        '123 Main Street',
      ),
      fc.string({ minLength: 0, maxLength: 50 }),
      fc.constantFrom(
        '4111111111111111',
        'jane+filter@x.co.uk',
        '1600 Pennsylvania Avenue NW',
      ),
    );
    fc.assert(
      fc.property(piiyArb, ([a, mid, b]) => {
        const text = `${a} -- ${mid} -- ${b}`;
        const once = redactPII(text);
        const twice = redactPII(once);
        expect(twice).toBe(once);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('redactPII property: post-redaction is PII-free for the patterns we know', () => {
  // After redaction, containsPII should be false IF the redacted string
  // doesn't itself contain a pattern. Synthesized PII-only strings are
  // a fair test bed; arbitrary text might generate accidental hits we
  // don't redact (e.g., 12-digit run that's not a CC) and confuse this.
  it('synthesized PII-rich strings have no detectable PII after redaction', () => {
    const piiyArb = fc.constantFrom(
      'Card 4111-1111-1111-1111',
      'SSN 123-45-6789',
      'Phone 555-867-5309',
      'Email jane@example.com',
      'Address 123 Main Street',
      'Multi: 4111-1111-1111-1111 with 555-867-5309 and jane@x.com at 123 Main Street',
    );
    fc.assert(
      fc.property(piiyArb, (text) => {
        const redacted = redactPII(text);
        // Sanity: actually changed.
        expect(redacted).not.toBe(text);
        // After redaction, no PII pattern matches.
        expect(containsPII(redacted)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('redactPII property: bounded output growth', () => {
  it('output length ≤ input length + reasonable token overhead', () => {
    // The longest replacement token is "[ADDRESS]" (9 chars). The
    // shortest input that triggers it is ~10 chars ("1 a Street").
    // So replacement is roughly net-neutral. We bound at input + 100
    // to allow for many small replacements where each replaces a longer
    // string with a shorter token (net-shrink) but headroom covers the
    // rare case of expansion.
    fc.assert(
      fc.property(textArb, (text) => {
        const out = redactPII(text);
        expect(out.length).toBeLessThanOrEqual(text.length + 100);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
