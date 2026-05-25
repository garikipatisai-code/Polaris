// Tests for the domain tier system (#63 — M3.5 safety floor).
//
// Verifies:
//   * unknown hosts default to 'read-only' (the safe baseline)
//   * www. prefix is stripped during canonicalization
//   * setDomainTier round-trips via chrome.storage.local mock
//   * subdomains are NOT inherited (shop.amazon.com is distinct from amazon.com)
//   * assertCanAct throws non-fatal BrowserToolError on insufficient tier
//   * removing a tier (null) reverts to default
//   * tier ordering: read-only < click-only < full-action

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getDomainTier,
  setDomainTier,
  listDomainTiers,
  assertCanAct,
  canonicalHost,
  _resetDomainTiers,
} from '../src/agent/domain_tiers';
import { BrowserToolError } from '../src/agent/tools/browser/lifecycle';
import { resetMockedStorage } from './setup';

beforeEach(async () => {
  await resetMockedStorage();
  await _resetDomainTiers();
});
afterEach(async () => await _resetDomainTiers());

describe('canonicalHost', () => {
  it('strips www. prefix', () => {
    expect(canonicalHost('https://www.amazon.com/dp/B0X1')).toBe('amazon.com');
  });
  it('preserves non-www subdomains', () => {
    expect(canonicalHost('https://shop.amazon.com')).toBe('shop.amazon.com');
  });
  it('handles ports', () => {
    expect(canonicalHost('http://localhost:11434')).toBe('localhost:11434');
  });
});

describe('getDomainTier: defaults', () => {
  it('returns read-only for unknown hosts', async () => {
    expect(await getDomainTier('https://example.com')).toBe('read-only');
  });
  it('returns read-only when storage is empty', async () => {
    expect(await getDomainTier('https://amazon.com')).toBe('read-only');
  });
  it('returns read-only for malformed URLs (graceful)', async () => {
    expect(await getDomainTier('not a url')).toBe('read-only');
  });
});

describe('setDomainTier / getDomainTier: round-trip', () => {
  it('round-trips a single host', async () => {
    await setDomainTier('amazon.com', 'full-action');
    expect(await getDomainTier('https://amazon.com/dp/B0X1')).toBe('full-action');
  });

  it('canonicalizes www. on read', async () => {
    await setDomainTier('amazon.com', 'click-only');
    expect(await getDomainTier('https://www.amazon.com/foo')).toBe('click-only');
  });

  it('treats subdomains as distinct (no inheritance)', async () => {
    await setDomainTier('amazon.com', 'full-action');
    expect(await getDomainTier('https://shop.amazon.com')).toBe('read-only');
  });

  it('overwrite preserves last-write-wins', async () => {
    await setDomainTier('amazon.com', 'click-only');
    await setDomainTier('amazon.com', 'full-action');
    expect(await getDomainTier('https://amazon.com')).toBe('full-action');
  });

  it('null reverts to default', async () => {
    await setDomainTier('amazon.com', 'full-action');
    expect(await getDomainTier('https://amazon.com')).toBe('full-action');
    await setDomainTier('amazon.com', null);
    expect(await getDomainTier('https://amazon.com')).toBe('read-only');
  });
});

describe('listDomainTiers', () => {
  it('returns the configured map (no defaults)', async () => {
    await setDomainTier('amazon.com', 'full-action');
    await setDomainTier('walmart.com', 'click-only');
    const list = await listDomainTiers();
    expect(list).toEqual({
      'amazon.com': 'full-action',
      'walmart.com': 'click-only',
    });
  });

  it('returns empty when nothing set', async () => {
    expect(await listDomainTiers()).toEqual({});
  });
});

describe('assertCanAct: tier ordering', () => {
  it('passes when tier matches required', async () => {
    await setDomainTier('amazon.com', 'click-only');
    await expect(
      assertCanAct('https://amazon.com', 'click-only'),
    ).resolves.toBeUndefined();
  });

  it('passes when tier exceeds required', async () => {
    await setDomainTier('amazon.com', 'full-action');
    await expect(
      assertCanAct('https://amazon.com', 'click-only'),
    ).resolves.toBeUndefined();
  });

  it('throws non-fatal on insufficient tier (read-only attempting click)', async () => {
    // amazon.com defaults to read-only since not configured.
    let caught: unknown = null;
    try {
      await assertCanAct('https://amazon.com', 'click-only');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BrowserToolError);
    expect((caught as BrowserToolError).fatal).toBe(false);
    expect((caught as BrowserToolError).message).toContain('read-only');
    expect((caught as BrowserToolError).message).toContain('click-only');
  });

  it('throws non-fatal on click-only attempting full-action', async () => {
    await setDomainTier('amazon.com', 'click-only');
    await expect(
      assertCanAct('https://amazon.com', 'full-action'),
    ).rejects.toThrow(BrowserToolError);
  });
});
