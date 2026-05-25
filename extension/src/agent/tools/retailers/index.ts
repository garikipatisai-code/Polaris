// Retailer adapter registry / dispatcher.
//
// The single entry point used by browser-side tools (e.g. a future
// `product.extract` tool or the agent's site-aware reader). Looks up
// the right adapter for a URL and delegates extraction to it.
//
// Adapter ordering matters only for overlap (e.g. if a retailer ran a
// promo on `*.amazon.com/<thirdparty>` URLs we'd pin the more-specific
// adapter first). For now adapters are mutually exclusive on host, so
// the array's order is informational only.
//
// New retailer? Add an adapter file under this directory, import it,
// and append to ADAPTERS. No changes elsewhere — the agent calls
// `extractProduct(tree, url)` and gets the right shape back.

import type { SimplifiedNode } from '../browser/aria_types';
import type { ProductRecord, RetailerAdapter } from './types';
import { amazonAdapter } from './amazon';

const ADAPTERS: RetailerAdapter[] = [amazonAdapter];

/**
 * Return the first adapter whose `matches(url)` returns true, or null
 * if no registered adapter handles this host.
 *
 * O(N) over the adapter list; N is small (≤10 over the lifetime of the
 * project) so we don't pre-build a host index.
 */
export function findAdapter(url: string): RetailerAdapter | null {
  for (const adapter of ADAPTERS) {
    if (adapter.matches(url)) return adapter;
  }
  return null;
}

/**
 * Run the matching adapter's extractor.
 *
 * Returns null when:
 *   - no adapter matches the URL (unsupported retailer), OR
 *   - the matched adapter returns null (URL is on a supported host but
 *     the page isn't a product page — listing, search, 404, etc.).
 *
 * Callers cannot distinguish those two cases from the return value
 * alone; if they need to, they can call `findAdapter(url)` first.
 */
export function extractProduct(tree: SimplifiedNode, url: string): ProductRecord | null {
  const adapter = findAdapter(url);
  if (!adapter) return null;
  return adapter.extract(tree, { url });
}

export type { ProductRecord, RetailerAdapter } from './types';
export { amazonAdapter } from './amazon';
