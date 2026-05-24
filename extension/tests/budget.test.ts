import { describe, expect, it } from 'vitest';
import { approxTokens, approxTokensOf, withinRoleBudget, BUDGETS } from '../src/agent/budget';

describe('approxTokens', () => {
  it('returns 0 for null/undefined/empty', () => {
    expect(approxTokens(null)).toBe(0);
    expect(approxTokens(undefined)).toBe(0);
    expect(approxTokens('')).toBe(0);
  });
  it('uses chars/4 ceiling', () => {
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
