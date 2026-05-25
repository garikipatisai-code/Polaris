// Tests for the retailer registry/dispatcher (`src/agent/tools/retailers/index.ts`).

import { describe, expect, it } from 'vitest';
import type { SimplifiedNode } from '../src/agent/tools/browser/aria_types';
import {
  amazonAdapter,
  extractProduct,
  findAdapter,
} from '../src/agent/tools/retailers';

/* ──────────────────────────────────────────────────────────────────────── *
 * Fixtures                                                                  *
 * ──────────────────────────────────────────────────────────────────────── */

const minimalAmazonTree: SimplifiedNode = {
  role: 'main',
  children: [
    {
      role: 'heading',
      name: 'A simple Amazon product for the dispatcher test',
    },
    { role: 'text', name: '$15.00' },
  ],
};

/* ──────────────────────────────────────────────────────────────────────── *
 * findAdapter()                                                             *
 * ──────────────────────────────────────────────────────────────────────── */

describe('findAdapter', () => {
  it('returns the Amazon adapter for an Amazon URL', () => {
    const a = findAdapter('https://www.amazon.com/dp/B09B8V1LZ3');
    expect(a).not.toBeNull();
    expect(a).toBe(amazonAdapter);
  });

  it('returns null for non-Amazon retailers', () => {
    expect(findAdapter('https://walmart.com/ip/x/123')).toBeNull();
    expect(findAdapter('https://www.target.com/p/foo')).toBeNull();
  });

  it('returns null for malformed URLs', () => {
    expect(findAdapter('not-a-url')).toBeNull();
  });

  it('matches across Amazon TLDs', () => {
    expect(findAdapter('https://amazon.co.uk/dp/X')).toBe(amazonAdapter);
    expect(findAdapter('https://amazon.de/dp/X')).toBe(amazonAdapter);
  });
});

/* ──────────────────────────────────────────────────────────────────────── *
 * extractProduct()                                                          *
 * ──────────────────────────────────────────────────────────────────────── */

describe('extractProduct', () => {
  it('delegates to the matched adapter and returns its ProductRecord', () => {
    const url = 'https://www.amazon.com/dp/B09B8V1LZ3';
    const out = extractProduct(minimalAmazonTree, url);
    expect(out).not.toBeNull();
    expect(out!.retailer).toBe('amazon');
    expect(out!.title).toBe('A simple Amazon product for the dispatcher test');
    expect(out!.priceCents).toBe(1500);
    expect(out!.currency).toBe('USD');
    expect(out!.asin).toBe('B09B8V1LZ3');
    expect(out!.url).toBe(url);
  });

  it('returns null when no adapter matches the URL', () => {
    expect(extractProduct(minimalAmazonTree, 'https://walmart.com/x')).toBeNull();
  });

  it('returns null when adapter matches but page has no extractable product', () => {
    const tree: SimplifiedNode = {
      role: 'main',
      children: [
        // No heading at all → adapter returns null even though URL matches.
        { role: 'text', name: 'You have been logged out. Please sign in.' },
      ],
    };
    expect(extractProduct(tree, 'https://amazon.com/dp/B0X')).toBeNull();
  });
});
