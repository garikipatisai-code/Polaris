// Amazon retailer adapter.
//
// Extracts a ProductRecord from a simplified ARIA tree of an Amazon
// product page. We do NOT parse raw HTML or query the DOM directly —
// upstream `aria.simplifyAxTree` has already collapsed the page into
// a small (≤ 4000 chars JSON) role/name/value/children tree. This
// adapter walks that tree and looks for the role+text patterns Amazon
// emits consistently across A/B variants and locales.
//
// Locale support: matches the major Amazon TLDs (.com, .co.uk, .de, .ca,
// .fr, .it, .es, .com.au, .com.mx, .co.jp, .in, etc.). Currency detection
// keys off the symbol present in the price text rather than the TLD —
// works for cases where amazon.de sometimes renders prices with "$" for
// US-listed third-party items, or where amazon.co.uk uses "£" alongside
// "GBP" descriptions.
//
// Extraction strategy is deliberately tolerant: every field is optional
// in ProductRecord, and adapters return null only when no title can be
// found (which we use as the signal "this isn't a product page"). A
// listing page or a logged-out wall on amazon.com therefore returns
// null and the agent moves on, rather than emitting a garbage record.

import type { SimplifiedNode } from '../browser/aria_types';
import type { ProductRecord, RetailerAdapter } from './types';

/* ──────────────────────────────────────────────────────────────────────── *
 * Tree walking                                                              *
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Depth-first generator over a SimplifiedNode tree.
 *
 * The tree is small (parser caps it at ARIA_OUTPUT_CHAR_CAP = 4000 JSON
 * chars), so a generator is a reasonable shape: callers can `for-of`
 * once per pattern they're hunting, and the cost is dominated by the
 * regex/predicate they apply per node, not the traversal itself.
 *
 * We do NOT bail early — multiple consumers want to scan the whole tree
 * for different roles, so the generator visits every node every time.
 */
export function* walk(node: SimplifiedNode): Iterable<SimplifiedNode> {
  yield node;
  if (node.children) {
    for (const child of node.children) {
      yield* walk(child);
    }
  }
}

/* ──────────────────────────────────────────────────────────────────────── *
 * URL helpers                                                               *
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * True iff the URL's host is an Amazon domain.
 *
 * We're generous: any host that contains "amazon." followed by a TLD-
 * like suffix matches. This covers .com, .co.uk, .de, .ca, .fr, .it,
 * .es, .com.au, .com.mx, .co.jp, .in, .nl, .se, .pl, .com.tr, etc.
 * without enumerating the full list. We deliberately match
 * `smile.amazon.com`, `aws.amazon.com` (rare but possible), and the
 * `m.` mobile subdomain too — the adapter will return null for any
 * page that turns out not to be a product page.
 *
 * Returns false on malformed input (URL constructor throws) so callers
 * don't have to wrap.
 */
function isAmazonHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return false;
  }
  // Strip any port. Match `amazon.<tld>` somewhere in the host.
  // Use a regex that requires either start-of-string or a `.` before
  // `amazon.` so we don't match e.g. "fakeamazon.com".
  return /(^|\.)amazon\.[a-z]{2,}(\.[a-z]{2,})?$/.test(host);
}

/**
 * Pull the ASIN out of an Amazon URL. ASINs are 10-character upper-case
 * alphanumerics (often start with B0…). Two canonical paths:
 *   - /dp/<ASIN>
 *   - /gp/product/<ASIN>
 *
 * Returns undefined when the URL doesn't carry one (e.g., search
 * results, category browse pages).
 */
export function extractAsinFromUrl(url: string): string | undefined {
  // /dp/ASIN or /gp/product/ASIN. ASIN is always 10 alphanumerics.
  // We anchor on the path delimiter to avoid matching e.g. "ABCDEF0123"
  // as a query value or fragment.
  const m = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?#]|$)/.exec(url);
  return m ? m[1] : undefined;
}

/* ──────────────────────────────────────────────────────────────────────── *
 * Title                                                                     *
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Find the product title.
 *
 * Strategy: examine the FIRST 5 heading-role nodes encountered in document
 * order. Among those whose name length is ≥ 20 chars (real product titles
 * are long; banner phrases like "Amazon's Choice" or "Frequently bought
 * together" are short), pick the longest. If none meet the 20-char floor,
 * fall back to the first heading whose name length is > 5.
 *
 * The two-tier approach addresses the failure mode the M3 swarm flagged:
 * Amazon test variants sometimes inject a banner H1 ("Frequently bought
 * together — Amazon's Choice — Quick look") BEFORE the product H1, and a
 * naive first-heading-only adapter would silently emit the wrong title.
 *
 * Returns undefined if the simplified tree contains no heading >5 chars
 * within the first 5 heading nodes — almost certainly not a product page.
 */
function findTitle(tree: SimplifiedNode): string | undefined {
  const candidates: string[] = [];
  for (const node of walk(tree)) {
    if (node.role !== 'heading') continue;
    const name = (node.name ?? '').trim();
    if (name.length === 0) continue;
    candidates.push(name);
    if (candidates.length >= 5) break;
  }
  if (candidates.length === 0) return undefined;
  // Tier 1: longest among candidates that meet the product-title length
  // floor. Real Amazon product titles are reliably 20+ chars (often 60+);
  // banners are reliably <20.
  const meaty = candidates.filter((c) => c.length >= 20);
  if (meaty.length > 0) {
    return meaty.reduce((a, b) => (a.length >= b.length ? a : b));
  }
  // Tier 2: fall back to first non-trivial heading. Covers minimal pages
  // and tests where titles are intentionally shorter.
  const fallback = candidates.find((c) => c.length > 5);
  return fallback;
}

/* ──────────────────────────────────────────────────────────────────────── *
 * Price                                                                     *
 * ──────────────────────────────────────────────────────────────────────── */

const PRICE_REGEX = /([$£€])\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/;

/**
 * Map a currency symbol to ISO-4217 code.
 *
 * Default to USD if no symbol was present but a number was extracted —
 * matches the brief's contract: "Default USD if symbol absent but a
 * number is detected." We never reach this branch from `parsePriceText`
 * (the regex requires a symbol), but `extract` falls through to USD as
 * the default in `ProductRecord.currency` when needed.
 */
function symbolToCurrency(sym: string): string {
  if (sym === '£') return 'GBP';
  if (sym === '€') return 'EUR';
  // '$' or anything else → USD. (Multiple TLDs use $ — AUD, CAD, MXN —
  // but the adapter doesn't have enough signal from a bare symbol to
  // disambiguate, and Phase 1 is US-first.)
  return 'USD';
}

/**
 * Parse a single price-bearing string into { cents, currency }.
 *
 * Accepts US-style ("$1,234.56") and bare integers ("$29"). Returns
 * undefined for malformed input ("$abc", "$"), which is the contract
 * the brief specifies for the test "$abc → undefined".
 *
 * Cents math: we don't use `Number.parseFloat * 100` because
 * `29.99 * 100` is `2998.9999…` in IEEE-754. Instead, split on the
 * decimal point and reassemble as integer cents. This keeps every
 * currency we currently support (USD/GBP/EUR — all 2-decimal) exact.
 */
export function parsePriceText(
  text: string,
): { cents: number; currency: string } | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  const m = PRICE_REGEX.exec(text);
  if (!m) return undefined;
  const symbol = m[1]!;
  const numStr = m[2]!.replace(/,/g, '');
  // Split on '.' to avoid floating-point rounding when going to cents.
  const dotIdx = numStr.indexOf('.');
  let cents: number;
  if (dotIdx < 0) {
    const whole = Number.parseInt(numStr, 10);
    if (!Number.isFinite(whole)) return undefined;
    cents = whole * 100;
  } else {
    const wholeStr = numStr.slice(0, dotIdx);
    const fracStrRaw = numStr.slice(dotIdx + 1);
    if (fracStrRaw.length === 0) return undefined;
    // Normalize fractional part to exactly 2 digits (pad or truncate).
    const fracStr = fracStrRaw.length === 1 ? fracStrRaw + '0' : fracStrRaw.slice(0, 2);
    const whole = Number.parseInt(wholeStr === '' ? '0' : wholeStr, 10);
    const frac = Number.parseInt(fracStr, 10);
    if (!Number.isFinite(whole) || !Number.isFinite(frac)) return undefined;
    cents = whole * 100 + frac;
  }
  return { cents, currency: symbolToCurrency(symbol) };
}

/**
 * Sweep the tree for the first node whose name OR value contains a
 * price pattern. Returns both cents and currency.
 *
 * Tree-walk caveat: Amazon sometimes splits a price across multiple
 * sibling nodes in the simplified tree — `<span>$</span><span>29</span>
 * <sup>99</sup>` collapses to three sibling text nodes, and the regex
 * won't catch them individually. Phase 1 accepts this loss — typical
 * product detail pages also emit a combined `aria-label="$29.99"` on
 * the price block, which the simplifier preserves as a node `name`.
 */
function findPrice(tree: SimplifiedNode): { cents: number; currency: string } | undefined {
  for (const node of walk(tree)) {
    const candidates: string[] = [];
    if (node.name) candidates.push(node.name);
    if (node.value) candidates.push(node.value);
    for (const c of candidates) {
      const parsed = parsePriceText(c);
      if (parsed) return parsed;
    }
  }
  return undefined;
}

/* ──────────────────────────────────────────────────────────────────────── *
 * Stock                                                                     *
 * ──────────────────────────────────────────────────────────────────────── */

const IN_STOCK_PATTERNS = /\b(?:In Stock|Available|Add to Cart|Buy Now)\b/i;
const OUT_OF_STOCK_PATTERNS = /\b(?:Currently unavailable|Out of Stock|Sold Out)\b/i;

/**
 * Detect availability via keyword sweep.
 *
 * Order matters: we scan the WHOLE tree for both signals before deciding,
 * so an "Add to Cart" button later in the tree doesn't get pre-empted by
 * a stale "Currently unavailable" banner earlier (or vice versa).
 *
 * If both signals are present (rare — usually only on listing-of-variants
 * pages where one variant is OOS), we prefer the positive signal because
 * Amazon never shows "Add to Cart" on a fully OOS item.
 *
 * Returns undefined when neither signal fires — e.g., on a digital-only
 * product where neither bucket of strings appears literally.
 */
function findInStock(tree: SimplifiedNode): boolean | undefined {
  let sawIn = false;
  let sawOut = false;
  for (const node of walk(tree)) {
    const text = `${node.name ?? ''} ${node.value ?? ''}`;
    if (IN_STOCK_PATTERNS.test(text)) sawIn = true;
    if (OUT_OF_STOCK_PATTERNS.test(text)) sawOut = true;
  }
  if (sawIn) return true;
  if (sawOut) return false;
  return undefined;
}

/* ──────────────────────────────────────────────────────────────────────── *
 * Rating                                                                    *
 * ──────────────────────────────────────────────────────────────────────── */

const RATING_SCORE_REGEX = /(\d(?:\.\d)?)\s*out of\s*5/i;
const RATING_COUNT_REGEX = /([\d,]+)\s*(?:global\s+)?ratings?/i;

/**
 * Detect "X.Y out of 5" + "[\d,]+ ratings" anywhere in the tree.
 *
 * Both patterns can appear in the same node ("4.5 out of 5 stars,
 * 1,234 ratings") or in separate nodes — we accept either. If we find
 * a score but no count, we still emit `rating` with count=0; if we
 * find neither, we return undefined entirely.
 *
 * If the spec changes to "score only" (no count text), bumping count
 * to optional in ProductRecord would let us drop the count fallback
 * here — for now the field is structurally required when score is set.
 */
function findRating(tree: SimplifiedNode): { score: number; count: number } | undefined {
  let score: number | undefined;
  let count: number | undefined;
  for (const node of walk(tree)) {
    const text = `${node.name ?? ''} ${node.value ?? ''}`;
    if (score === undefined) {
      const m = RATING_SCORE_REGEX.exec(text);
      if (m) {
        const parsed = Number.parseFloat(m[1]!);
        if (Number.isFinite(parsed)) score = parsed;
      }
    }
    if (count === undefined) {
      const m = RATING_COUNT_REGEX.exec(text);
      if (m) {
        const parsed = Number.parseInt(m[1]!.replace(/,/g, ''), 10);
        if (Number.isFinite(parsed)) count = parsed;
      }
    }
    if (score !== undefined && count !== undefined) break;
  }
  if (score === undefined) return undefined;
  return { score, count: count ?? 0 };
}

/* ──────────────────────────────────────────────────────────────────────── *
 * Features                                                                  *
 * ──────────────────────────────────────────────────────────────────────── */

const LEADING_BULLET_REGEX = /^[\s•·∙⋅◦▪▫●○■□–—-]+/;

/**
 * Strip leading bullet glyphs / dashes from a feature string.
 *
 * Amazon's feature lists are typically rendered as a `<ul>` of `<li>`s,
 * which the simplifier preserves as a `list` containing `listitem`
 * children. The `name` on a listitem sometimes includes the visible
 * bullet character at the start, sometimes doesn't, depending on the
 * page template — strip whichever bullets are present.
 */
function stripBullet(s: string): string {
  return s.replace(LEADING_BULLET_REGEX, '').trim();
}

/**
 * Collect up to 10 listitem names from the FIRST list found in the tree.
 *
 * "First list" is approximate but works in practice: Amazon's product
 * page emits the feature bullets near the top of the main content, and
 * other lists (cross-sells, reviews) appear later. If the first list is
 * empty, we move on to the next — but cap the search at the first list
 * with any content to avoid pulling unrelated lists when features are
 * absent on the page.
 */
function findFeatures(tree: SimplifiedNode): string[] | undefined {
  for (const node of walk(tree)) {
    if (node.role !== 'list') continue;
    if (!node.children) continue;
    const items: string[] = [];
    for (const child of node.children) {
      if (child.role !== 'listitem') continue;
      const raw = (child.name ?? '').trim();
      if (!raw) continue;
      const cleaned = stripBullet(raw);
      if (cleaned) items.push(cleaned);
      if (items.length >= 10) break;
    }
    if (items.length > 0) return items;
    // Empty list — keep looking for the next non-empty one.
  }
  return undefined;
}

/* ──────────────────────────────────────────────────────────────────────── *
 * Adapter                                                                   *
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The Amazon adapter. Singleton — adapters are stateless, so a single
 * exported instance is enough.
 */
export const amazonAdapter: RetailerAdapter = {
  name: 'amazon',
  matches(url: string): boolean {
    return isAmazonHost(url);
  },
  extract(tree: SimplifiedNode, ctx: { url: string }): ProductRecord | null {
    const title = findTitle(tree);
    // No title → not a product page on a matched site. Returning null
    // lets the agent treat this as "wrong URL, look deeper" rather than
    // "site is broken, abort task".
    if (title === undefined) return null;

    const record: ProductRecord = {
      retailer: 'amazon',
      url: ctx.url,
      title,
    };

    const price = findPrice(tree);
    if (price !== undefined) {
      record.priceCents = price.cents;
      record.currency = price.currency;
    }

    const inStock = findInStock(tree);
    if (inStock !== undefined) record.inStock = inStock;

    const rating = findRating(tree);
    if (rating !== undefined) record.rating = rating;

    const features = findFeatures(tree);
    if (features !== undefined) record.features = features;

    const asin = extractAsinFromUrl(ctx.url);
    if (asin !== undefined) record.asin = asin;

    return record;
  },
};
