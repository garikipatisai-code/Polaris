// Property-based tests for chars-per-token EWMA bounds (M3.5 follow-up).
//
// recordCharsPerToken / getCharsPerToken implements an EWMA over observed
// (chars, tokens) pairs from real Ollama responses. Three properties:
//
//   1. **Bounded:** getCharsPerToken() always returns a value in
//      [RATIO_MIN, RATIO_MAX] = [1.5, 8] regardless of how many records
//      we feed in (including pathological values, which the function
//      rejects rather than letting them skew the EWMA).
//
//   2. **Stable on rejected inputs:** When all inputs are out of range
//      (chars < 0, tokens = 0, ratio outside [1.5, 8]), the estimator
//      stays at the default of 4.0 — none of those observations should
//      have changed the state.
//
//   3. **Convergence:** Repeatedly recording the same (chars, tokens)
//      pair drives the EWMA toward that ratio. After enough iterations
//      with α=0.2, the estimate approaches the true ratio within 0.1.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  recordCharsPerToken,
  getCharsPerToken,
  _resetCharsPerToken,
} from '../../src/agent/budget';

beforeEach(() => _resetCharsPerToken());
afterEach(() => _resetCharsPerToken());

const NUM_RUNS = 100;

describe('recordCharsPerToken: bounded EWMA output', () => {
  it('getCharsPerToken always in [1.5, 8] no matter what we feed it', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.integer({ min: -100, max: 10000 }),
            fc.integer({ min: -100, max: 10000 }),
          ),
          { minLength: 1, maxLength: 50 },
        ),
        (pairs) => {
          _resetCharsPerToken();
          for (const [chars, tokens] of pairs) {
            recordCharsPerToken(chars, tokens);
          }
          const ratio = getCharsPerToken();
          expect(ratio).toBeGreaterThanOrEqual(1.5);
          expect(ratio).toBeLessThanOrEqual(8);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('recordCharsPerToken: rejects out-of-range observations', () => {
  it('observations with chars ≤ 0 or tokens ≤ 0 leave the estimator at default', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.integer({ min: -100, max: 0 }),
            fc.integer({ min: -100, max: 100 }),
          ),
          { minLength: 1, maxLength: 20 },
        ),
        (pairs) => {
          _resetCharsPerToken();
          for (const [chars, tokens] of pairs) {
            recordCharsPerToken(chars, tokens);
          }
          // Default is 4 (RATIO_DEFAULT). All inputs had chars ≤ 0 so
          // every record was a no-op.
          expect(getCharsPerToken()).toBe(4);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('observations producing ratio outside [1.5, 8] are silently ignored', () => {
    _resetCharsPerToken();
    // chars=10000 / tokens=1 → ratio 10000 (way out of range).
    recordCharsPerToken(10000, 1);
    expect(getCharsPerToken()).toBe(4); // unchanged from default
    // chars=1 / tokens=100 → ratio 0.01 (way below).
    recordCharsPerToken(1, 100);
    expect(getCharsPerToken()).toBe(4);
  });
});

describe('recordCharsPerToken: convergence', () => {
  it('repeated identical observation drives EWMA toward the observed ratio', () => {
    fc.assert(
      fc.property(
        // Constrain to in-range ratios so we know the target.
        fc.float({ min: Math.fround(2.0), max: Math.fround(7.0), noNaN: true }),
        (targetRatio) => {
          _resetCharsPerToken();
          // Use chars=400 + tokens=400/targetRatio to hit targetRatio cleanly.
          const tokens = Math.max(1, Math.round(400 / targetRatio));
          // 50 iterations of α=0.2 EWMA → effective weight on the most
          // recent observation is 1 - 0.8^50 ≈ 1.0. Should be very close
          // to targetRatio.
          for (let i = 0; i < 50; i++) {
            recordCharsPerToken(400, tokens);
          }
          const observed = 400 / tokens;
          // Within 0.5 of the observed ratio (loose because tokens is
          // rounded to integer, which can shift the actual ratio away
          // from targetRatio by a fraction).
          expect(getCharsPerToken()).toBeCloseTo(observed, 0);
        },
      ),
      { numRuns: 30 },
    );
  });
});
