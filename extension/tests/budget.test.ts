import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  approxTokens,
  approxTokensOf,
  withinRoleBudget,
  BUDGETS,
  recordCharsPerToken,
  getCharsPerToken,
  _resetCharsPerToken,
} from '../src/agent/budget';

beforeEach(() => _resetCharsPerToken());
afterEach(() => _resetCharsPerToken());

describe('approxTokens', () => {
  it('returns 0 for null/undefined/empty', () => {
    expect(approxTokens(null)).toBe(0);
    expect(approxTokens(undefined)).toBe(0);
    expect(approxTokens('')).toBe(0);
  });
  it('uses default ratio 4 chars/token before any observations', () => {
    expect(approxTokens('abcd')).toBe(1); // 4 chars
    expect(approxTokens('abcde')).toBe(2); // ceil(5/4) = 2
    expect(approxTokens('a'.repeat(100))).toBe(25);
  });
});

describe('approxTokensOf', () => {
  it('returns 0 for null/undefined', () => {
    expect(approxTokensOf(null)).toBe(0);
    expect(approxTokensOf(undefined)).toBe(0);
  });
  it('handles strings directly', () => {
    expect(approxTokensOf('abcd')).toBe(1);
  });
  it('serializes objects to count tokens', () => {
    const obj = { a: 1, b: 'hello' };
    expect(approxTokensOf(obj)).toBe(approxTokens(JSON.stringify(obj)));
  });
});

describe('withinRoleBudget', () => {
  it('returns true at exactly the budget cap', () => {
    expect(withinRoleBudget(BUDGETS.executor, 'executor')).toBe(true);
  });
  it('returns false above the cap', () => {
    expect(withinRoleBudget(BUDGETS.executor + 1, 'executor')).toBe(false);
  });
  it('returns true at zero', () => {
    expect(withinRoleBudget(0, 'planner')).toBe(true);
  });
});

describe('chars-per-token reconciliation (M2.7.2)', () => {
  it('starts at the default ratio of 4', () => {
    expect(getCharsPerToken()).toBe(4);
  });

  it('snaps to first observation', () => {
    recordCharsPerToken(100, 50); // 2 chars/token (unicode-heavy)
    expect(getCharsPerToken()).toBe(2);
  });

  it('EWMA-smooths subsequent observations', () => {
    recordCharsPerToken(400, 100); // 4 chars/token (English baseline)
    recordCharsPerToken(200, 100); // 2 chars/token (heavy unicode)
    // After two obs with α=0.2: 4 * 0.8 + 2 * 0.2 = 3.6
    expect(getCharsPerToken()).toBeCloseTo(3.6, 5);
  });

  it('refuses pathological observations outside [1.5, 8]', () => {
    recordCharsPerToken(100, 50); // 2.0 — accepted
    expect(getCharsPerToken()).toBe(2);
    recordCharsPerToken(1000, 1); // 1000 — rejected
    expect(getCharsPerToken()).toBe(2);
    recordCharsPerToken(1, 100); // 0.01 — rejected
    expect(getCharsPerToken()).toBe(2);
  });

  it('approxTokens uses the running ratio', () => {
    recordCharsPerToken(200, 100); // 2 chars/token
    expect(approxTokens('a'.repeat(100))).toBe(50); // 100 / 2 = 50
  });

  it('ignores zero/negative inputs', () => {
    recordCharsPerToken(0, 100);
    recordCharsPerToken(100, 0);
    recordCharsPerToken(-1, 100);
    expect(getCharsPerToken()).toBe(4); // unchanged from default
  });
});
