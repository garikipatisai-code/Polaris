// Shared types for retailer adapters.
//
// Retailer adapters consume the simplified ARIA tree extracted by the
// browser layer (`src/agent/tools/browser/aria_types.ts`) and emit a
// uniform, retailer-agnostic ProductRecord that the agent loop and the
// shopping-domain UI can consume without caring which site it came from.
//
// The shape of ProductRecord is intentionally narrow: only fields that
// are *both* meaningful across retailers AND extractable from a typical
// product page. Site-specific identifiers (asin, sku, item id, etc.)
// live as optional fields rather than in a free-form `extras` map so
// the type system catches typos at the call site rather than at runtime.
//
// Currency is stored separately from `priceCents` so callers can do
// arithmetic on the integer cents without first parsing a localized
// string ("$29.99" vs "29,99 €"). priceCents is *always* the smallest
// unit of the currency — i.e. cents for USD/GBP/EUR. We don't model
// zero-decimal currencies (JPY, KRW) yet because Phase 1 is US-first;
// adding them later means adding a per-currency divisor here.

import type { SimplifiedNode } from '../browser/aria_types';

/**
 * A normalized product extracted from a retailer page.
 *
 * Only `retailer` and `title` are required. Everything else is optional
 * because adapters degrade gracefully when a field can't be located in
 * the simplified tree (heading-text changed, list moved, etc.) — better
 * to return a partial record than fail outright.
 */
export interface ProductRecord {
  /** Retailer identifier, e.g. 'amazon', 'walmart'. Stable across page variants. */
  retailer: string;
  /** Page URL the record was extracted from. Optional — adapter may not always have it. */
  url?: string;
  /** Product title, typically the first <h1> on the page. */
  title: string;
  /** Price in the smallest unit of `currency` (e.g. cents for USD). Integer. */
  priceCents?: number;
  /** ISO-4217 currency code. Defaults to 'USD' when adapter sees a $ symbol. */
  currency?: string;
  /** True if the page advertises availability ("Add to Cart", "In Stock"); false on "Out of Stock"; undefined on either-or. */
  inStock?: boolean;
  /** Shipping cost in the smallest unit of currency. */
  shippingCents?: number;
  /** Aggregate rating: numeric score (0..5 typical) plus the count of underlying reviews. */
  rating?: { score: number; count: number };
  /** Amazon Standard Identification Number — 10-char alphanumeric. */
  asin?: string;
  /** Generic stock-keeping unit; for non-Amazon retailers. */
  sku?: string;
  /** Primary product image URL, when discoverable. */
  imageUrl?: string;
  /** Bullet-point feature list, capped at 10 entries to keep downstream prompts compact. */
  features?: string[];
}

/**
 * One adapter per retailer. The orchestrator picks an adapter via
 * `findAdapter(url)` and then calls `extract(tree, ctx)` to produce a
 * ProductRecord (or null if the page isn't a product page on a matched
 * site — e.g. a search-results listing on amazon.com).
 *
 * `matches` is intentionally cheap (URL host inspection) so the dispatch
 * loop can short-circuit to the right adapter without parsing.
 */
export interface RetailerAdapter {
  /** Stable retailer identifier; written into ProductRecord.retailer. */
  name: string;
  /** True iff this adapter can extract from the given URL/host. */
  matches(url: string): boolean;
  /**
   * Extract the product record from a simplified ARIA tree.
   *
   * Return null if the page matched the host but no extractable product
   * is present (e.g. a category page, a logged-out wall, a 404 body).
   * Returning null is *not* an error — the agent treats it as "wrong
   * URL, try a deeper one" rather than as a hard failure.
   */
  extract(tree: SimplifiedNode, ctx: { url: string }): ProductRecord | null;
}
