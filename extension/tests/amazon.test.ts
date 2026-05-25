// Tests for the Amazon retailer adapter.
//
// Fixtures are inline constants — keeping them in-file rather than as
// JSON makes intent obvious at a glance and avoids a fixture-loading
// dance with vitest's resolve config. The simplified-tree shapes here
// mirror what `aria.simplifyAxTree` is expected to produce for an
// Amazon product page.

import { describe, expect, it } from 'vitest';
import type { SimplifiedNode } from '../src/agent/tools/browser/aria_types';
import {
  amazonAdapter,
  extractAsinFromUrl,
  parsePriceText,
  walk,
} from '../src/agent/tools/retailers/amazon';

/* ──────────────────────────────────────────────────────────────────────── *
 * Fixtures                                                                  *
 * ──────────────────────────────────────────────────────────────────────── */

/** A complete Amazon product page tree: title, price, rating, list, stock. */
const productPageTree: SimplifiedNode = {
  role: 'main',
  children: [
    { role: 'banner', name: 'Amazon header' },
    {
      role: 'heading',
      name: 'Echo Dot (5th Gen) — Smart speaker with Alexa',
    },
    {
      role: 'group',
      children: [
        { role: 'text', name: '$29.99' },
        { role: 'button', name: 'Add to Cart' },
        { role: 'text', name: '4.5 out of 5 stars' },
        { role: 'text', name: '1,234 ratings' },
      ],
    },
    {
      role: 'list',
      children: [
        { role: 'listitem', name: '• Improved bass and clearer sound' },
        { role: 'listitem', name: 'Built-in temperature sensor' },
        { role: 'listitem', name: '— Hands-free Alexa control' },
        { role: 'listitem', name: 'Eero built-in for Wi-Fi extension' },
      ],
    },
  ],
};

/** Listing page (search results) — multiple short headings, no canonical product heading. */
const listingPageTree: SimplifiedNode = {
  role: 'main',
  children: [
    { role: 'heading', name: 'Echo' }, // too short
    { role: 'text', name: 'Showing 1–48 of 2,000 results' },
    {
      role: 'list',
      children: [
        { role: 'listitem', name: 'Result 1' },
        { role: 'listitem', name: 'Result 2' },
      ],
    },
  ],
};

/** Out-of-stock product page. */
const oosPageTree: SimplifiedNode = {
  role: 'main',
  children: [
    { role: 'heading', name: 'Vintage Game Cartridge — Rare Edition' },
    { role: 'text', name: 'Currently unavailable.' },
    { role: 'text', name: '$199.00' },
  ],
};

/* ──────────────────────────────────────────────────────────────────────── *
 * matches()                                                                 *
 * ──────────────────────────────────────────────────────────────────────── */

describe('amazonAdapter.matches', () => {
  it('matches www.amazon.com product URLs', () => {
    expect(amazonAdapter.matches('https://www.amazon.com/dp/ABC1234567')).toBe(true);
  });

  it('matches bare amazon.com hosts', () => {
    expect(amazonAdapter.matches('https://amazon.com/some/path')).toBe(true);
  });

  it('matches international Amazon TLDs', () => {
    expect(amazonAdapter.matches('https://amazon.co.uk/dp/X')).toBe(true);
    expect(amazonAdapter.matches('https://www.amazon.de/dp/X')).toBe(true);
    expect(amazonAdapter.matches('https://www.amazon.ca/dp/X')).toBe(true);
    expect(amazonAdapter.matches('https://www.amazon.com.au/dp/X')).toBe(true);
    expect(amazonAdapter.matches('https://www.amazon.co.jp/dp/X')).toBe(true);
  });

  it('does not match non-Amazon retailers', () => {
    expect(amazonAdapter.matches('https://walmart.com/ip/x/123')).toBe(false);
    expect(amazonAdapter.matches('https://www.target.com/p/foo')).toBe(false);
    expect(amazonAdapter.matches('https://ebay.com/itm/123')).toBe(false);
  });

  it('does not match impostor hosts that contain "amazon" as substring', () => {
    expect(amazonAdapter.matches('https://fakeamazon.com/dp/X')).toBe(false);
    expect(amazonAdapter.matches('https://amazonfake.io/x')).toBe(false);
  });

  it('returns false on malformed URLs', () => {
    expect(amazonAdapter.matches('not-a-url')).toBe(false);
    expect(amazonAdapter.matches('')).toBe(false);
  });
});

/* ──────────────────────────────────────────────────────────────────────── *
 * extract() — full happy path                                               *
 * ──────────────────────────────────────────────────────────────────────── */

describe('amazonAdapter.extract', () => {
  it('extracts a complete ProductRecord from a product page tree', () => {
    const url = 'https://www.amazon.com/dp/B09B8V1LZ3';
    const out = amazonAdapter.extract(productPageTree, { url });
    expect(out).not.toBeNull();
    expect(out!.retailer).toBe('amazon');
    expect(out!.url).toBe(url);
    expect(out!.title).toBe('Echo Dot (5th Gen) — Smart speaker with Alexa');
    expect(out!.priceCents).toBe(2999);
    expect(out!.currency).toBe('USD');
    expect(out!.inStock).toBe(true);
    expect(out!.rating).toEqual({ score: 4.5, count: 1234 });
    expect(out!.asin).toBe('B09B8V1LZ3');
    // Bullets/dashes stripped from the listitem names.
    expect(out!.features).toEqual([
      'Improved bass and clearer sound',
      'Built-in temperature sensor',
      'Hands-free Alexa control',
      'Eero built-in for Wi-Fi extension',
    ]);
  });

  it('returns null on a listing page with no real heading', () => {
    const out = amazonAdapter.extract(listingPageTree, {
      url: 'https://www.amazon.com/s?k=echo',
    });
    expect(out).toBeNull();
  });

  it('marks an out-of-stock product as inStock:false', () => {
    const out = amazonAdapter.extract(oosPageTree, {
      url: 'https://www.amazon.com/dp/B0OOSXXXXX',
    });
    expect(out).not.toBeNull();
    expect(out!.inStock).toBe(false);
    expect(out!.priceCents).toBe(19900);
  });

  it('caps features at 10 items', () => {
    const tree: SimplifiedNode = {
      role: 'main',
      children: [
        { role: 'heading', name: 'Test product with eleven features' },
        {
          role: 'list',
          children: Array.from({ length: 15 }, (_, i) => ({
            role: 'listitem',
            name: `Feature ${i + 1}`,
          })),
        },
      ],
    };
    const out = amazonAdapter.extract(tree, { url: 'https://www.amazon.com/' });
    expect(out!.features).toHaveLength(10);
  });

  it('omits rating when no rating text present', () => {
    const tree: SimplifiedNode = {
      role: 'main',
      children: [
        { role: 'heading', name: 'A product without ratings shown' },
        { role: 'text', name: '$10.00' },
      ],
    };
    const out = amazonAdapter.extract(tree, { url: 'https://www.amazon.com/dp/B0X0X0X0X0' });
    expect(out!.rating).toBeUndefined();
  });

  it('omits inStock when neither availability signal is present', () => {
    const tree: SimplifiedNode = {
      role: 'main',
      children: [
        { role: 'heading', name: 'Digital book download bundle' },
        { role: 'text', name: '$9.99' },
      ],
    };
    const out = amazonAdapter.extract(tree, { url: 'https://www.amazon.com/' });
    expect(out!.inStock).toBeUndefined();
  });

  it('omits asin when URL has no ASIN segment', () => {
    const out = amazonAdapter.extract(productPageTree, {
      url: 'https://www.amazon.com/some-page-without-asin',
    });
    expect(out!.asin).toBeUndefined();
  });
});

/* ──────────────────────────────────────────────────────────────────────── *
 * extractAsinFromUrl()                                                      *
 * ──────────────────────────────────────────────────────────────────────── */

describe('extractAsinFromUrl', () => {
  it('extracts ASIN from /dp/ASIN URLs', () => {
    expect(extractAsinFromUrl('https://www.amazon.com/dp/B09B8V1LZ3')).toBe('B09B8V1LZ3');
  });

  it('extracts ASIN from /gp/product/ASIN URLs', () => {
    expect(extractAsinFromUrl('https://amazon.co.uk/gp/product/B0ABCDEFGH')).toBe('B0ABCDEFGH');
  });

  it('handles trailing path segments and query strings', () => {
    expect(
      extractAsinFromUrl(
        'https://www.amazon.com/Echo-Dot/dp/B09B8V1LZ3/ref=sr_1_1?keywords=echo',
      ),
    ).toBe('B09B8V1LZ3');
    expect(
      extractAsinFromUrl('https://amazon.com/dp/B09B8V1LZ3?th=1&psc=1'),
    ).toBe('B09B8V1LZ3');
  });

  it('returns undefined when no ASIN segment present', () => {
    expect(extractAsinFromUrl('https://www.amazon.com/s?k=echo')).toBeUndefined();
    expect(extractAsinFromUrl('https://www.amazon.com/')).toBeUndefined();
  });

  it('does not match short or lower-case sequences', () => {
    expect(extractAsinFromUrl('https://amazon.com/dp/short')).toBeUndefined();
    expect(extractAsinFromUrl('https://amazon.com/dp/abcdefghij')).toBeUndefined();
  });
});

/* ──────────────────────────────────────────────────────────────────────── *
 * parsePriceText()                                                          *
 * ──────────────────────────────────────────────────────────────────────── */

describe('parsePriceText', () => {
  it('parses a plain dollar price', () => {
    expect(parsePriceText('$29.99')).toEqual({ cents: 2999, currency: 'USD' });
  });

  it('parses a thousands-separated dollar price', () => {
    expect(parsePriceText('$1,234.56')).toEqual({ cents: 123456, currency: 'USD' });
  });

  it('parses a pound price as GBP', () => {
    expect(parsePriceText('£10.00')).toEqual({ cents: 1000, currency: 'GBP' });
  });

  it('parses a euro price as EUR', () => {
    expect(parsePriceText('€42.00')).toEqual({ cents: 4200, currency: 'EUR' });
  });

  it('parses an integer price (no decimal)', () => {
    expect(parsePriceText('$199')).toEqual({ cents: 19900, currency: 'USD' });
  });

  it('parses a single-decimal price by padding to 2 places', () => {
    expect(parsePriceText('$5.1')).toEqual({ cents: 510, currency: 'USD' });
  });

  it('returns undefined for "$abc"', () => {
    expect(parsePriceText('$abc')).toBeUndefined();
  });

  it('returns undefined for empty input', () => {
    expect(parsePriceText('')).toBeUndefined();
  });

  it('returns undefined for input with no currency symbol', () => {
    expect(parsePriceText('29.99')).toBeUndefined();
  });

  it('finds a price embedded in surrounding text', () => {
    expect(parsePriceText('List Price: $19.99 Save 20%')).toEqual({
      cents: 1999,
      currency: 'USD',
    });
  });
});

/* ──────────────────────────────────────────────────────────────────────── *
 * In-stock parsing direct                                                   *
 * ──────────────────────────────────────────────────────────────────────── */

describe('inStock detection', () => {
  it('treats "Add to Cart" as in stock', () => {
    const tree: SimplifiedNode = {
      role: 'main',
      children: [
        { role: 'heading', name: 'A product on sale right now' },
        { role: 'button', name: 'Add to Cart' },
      ],
    };
    const out = amazonAdapter.extract(tree, { url: 'https://amazon.com/' });
    expect(out!.inStock).toBe(true);
  });

  it('treats "In Stock" as in stock', () => {
    const tree: SimplifiedNode = {
      role: 'main',
      children: [
        { role: 'heading', name: 'A product currently available' },
        { role: 'text', name: 'In Stock' },
      ],
    };
    const out = amazonAdapter.extract(tree, { url: 'https://amazon.com/' });
    expect(out!.inStock).toBe(true);
  });

  it('treats "Currently unavailable" as out of stock', () => {
    const tree: SimplifiedNode = {
      role: 'main',
      children: [
        { role: 'heading', name: 'Vintage cartridge — limited edition' },
        { role: 'text', name: 'Currently unavailable.' },
      ],
    };
    const out = amazonAdapter.extract(tree, { url: 'https://amazon.com/' });
    expect(out!.inStock).toBe(false);
  });

  it('treats "Sold Out" as out of stock', () => {
    const tree: SimplifiedNode = {
      role: 'main',
      children: [
        { role: 'heading', name: 'A discontinued limited edition product' },
        { role: 'text', name: 'Sold Out' },
      ],
    };
    const out = amazonAdapter.extract(tree, { url: 'https://amazon.com/' });
    expect(out!.inStock).toBe(false);
  });
});

/* ──────────────────────────────────────────────────────────────────────── *
 * Rating parsing direct                                                     *
 * ──────────────────────────────────────────────────────────────────────── */

describe('rating detection', () => {
  it('extracts {score, count} from separate nodes', () => {
    const tree: SimplifiedNode = {
      role: 'main',
      children: [
        { role: 'heading', name: 'A nicely-reviewed product line' },
        { role: 'text', name: '4.5 out of 5 stars' },
        { role: 'text', name: '1,234 ratings' },
      ],
    };
    const out = amazonAdapter.extract(tree, { url: 'https://amazon.com/' });
    expect(out!.rating).toEqual({ score: 4.5, count: 1234 });
  });

  it('returns undefined when neither score nor count text present', () => {
    const tree: SimplifiedNode = {
      role: 'main',
      children: [
        { role: 'heading', name: 'An unreviewed product no rating data' },
      ],
    };
    const out = amazonAdapter.extract(tree, { url: 'https://amazon.com/' });
    expect(out!.rating).toBeUndefined();
  });

  it('extracts score with count=0 when only score present', () => {
    const tree: SimplifiedNode = {
      role: 'main',
      children: [
        { role: 'heading', name: 'A product with score but no count yet' },
        { role: 'text', name: '3.7 out of 5' },
      ],
    };
    const out = amazonAdapter.extract(tree, { url: 'https://amazon.com/' });
    expect(out!.rating).toEqual({ score: 3.7, count: 0 });
  });
});

/* ──────────────────────────────────────────────────────────────────────── *
 * walk()                                                                    *
 * ──────────────────────────────────────────────────────────────────────── */

describe('walk', () => {
  it('yields every node depth-first', () => {
    const tree: SimplifiedNode = {
      role: 'a',
      children: [
        {
          role: 'b',
          children: [{ role: 'c' }],
        },
        { role: 'd' },
      ],
    };
    const roles = [...walk(tree)].map((n) => n.role);
    expect(roles).toEqual(['a', 'b', 'c', 'd']);
  });

  it('handles a leaf node with no children', () => {
    const tree: SimplifiedNode = { role: 'leaf', name: 'x' };
    const nodes = [...walk(tree)];
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.name).toBe('x');
  });
});


describe("amazonAdapter.findTitle (#5: banner-heading robustness)", () => {
  // The arch-nemesis flagged that an Amazon-style page with a banner H1
  // ("Frequently bought together — Amazon's Choice — Quick look") preceding
  // the product H1 would defeat a "first heading >5 chars" rule. The
  // post-fix heuristic ranks among the first 5 headings by length when
  // any candidate clears 20 chars.
  it("picks the longest of the first 5 headings when banner precedes product", () => {
    const tree: SimplifiedNode = {
      role: "main",
      children: [
        { role: "heading", name: "Frequently bought together" },
        { role: "heading", name: "Amazon's Choice" },
        {
          role: "heading",
          name: "Sony WH-1000XM5 Wireless Noise Cancelling Headphones",
        },
        { role: "heading", name: "Customer reviews" },
      ],
    };
    const product = amazonAdapter.extract(tree, {
      url: "https://www.amazon.com/dp/B09Y2MXYZ1",
    });
    expect(product?.title).toBe(
      "Sony WH-1000XM5 Wireless Noise Cancelling Headphones",
    );
  });

  it("falls back to first heading >5 chars when no candidate clears 20 chars", () => {
    const tree: SimplifiedNode = {
      role: "main",
      children: [
        { role: "heading", name: "Hi" },        // <=5, skipped at fallback
        { role: "heading", name: "Mug Set" },   // first non-trivial
        { role: "heading", name: "Reviews" },
      ],
    };
    const product = amazonAdapter.extract(tree, {
      url: "https://www.amazon.com/dp/B0AAAAAAAA",
    });
    expect(product?.title).toBe("Mug Set");
  });

  it("returns null when no heading clears 5 chars (not a product page)", () => {
    const tree: SimplifiedNode = {
      role: "main",
      children: [
        { role: "heading", name: "Ad" },
        { role: "heading", name: "Hi" },
      ],
    };
    const product = amazonAdapter.extract(tree, {
      url: "https://www.amazon.com/dp/B0XXXXXXXX",
    });
    expect(product).toBeNull();
  });
});
