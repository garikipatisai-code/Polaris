import { describe, expect, it } from 'vitest';
import { ulid } from '../src/agent/ulid';

describe('ulid', () => {
  it('returns a 26-char Crockford-base32 string', () => {
    const id = ulid();
    expect(id.length).toBe(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
  });

  it('produces unique values', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(ulid());
    expect(ids.size).toBe(1000);
  });

  it('is sortable by creation time (later > earlier)', () => {
    const a = ulid(1_000_000_000);
    const b = ulid(2_000_000_000);
    expect(b > a).toBe(true);
  });

  it('encodes the timestamp in the first 10 chars', () => {
    const t1 = 1_700_000_000_000;
    const id1 = ulid(t1);
    const id2 = ulid(t1); // same timestamp, different randomness
    expect(id1.slice(0, 10)).toBe(id2.slice(0, 10));
    expect(id1.slice(10)).not.toBe(id2.slice(10));
  });
});
