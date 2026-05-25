// DuckDuckGo HTML search tool.
//
// Hits https://html.duckduckgo.com/html/?q=… and parses the resulting page
// with targeted regex (no cheerio/jsdom). DDG's "noscript" HTML endpoint
// returns server-rendered results suitable for scraping without a JS
// runtime, which means it works equally well from a service worker fetch
// and from Node tests.
//
// Output is a list of { title, url, snippet?, rank } records. URLs are
// de-redirected: DDG wraps every result link in `/l/?uddg=<encoded-target>`,
// and we pull the inner URL out of the `uddg` query param. If extraction
// fails we keep the raw href so the model can still try it (better partial
// answer than no answer).
//
// We deliberately do NOT use DOMParser here — it's not available in the
// Node test env without polyfilling, and pulling in a polyfill would add
// weight. Regex on DDG's stable result markup is brittle in the abstract
// but acceptable in practice for the noscript endpoint, which has been
// markup-stable for years.

import { z } from 'zod';
import type { ToolHandler } from '../registry';
import { BrowserToolError, withBrowserTimeout } from './lifecycle';

const DDG_HTML_ENDPOINT = 'https://html.duckduckgo.com/html/';
const DEFAULT_LIMIT = 10;
const MAX_RESULTS = 10;
const FETCH_TIMEOUT_MS = 15_000;

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  rank: number;
}

/**
 * Pure parser. Given DDG HTML, returns up to `MAX_RESULTS` SearchResults
 * (or fewer if the optional `limit` is smaller).
 *
 * Tolerant of malformed input: missing closing tags, extra whitespace,
 * truncated pages all degrade gracefully — we return whatever we could
 * extract rather than throwing. An unparseable page yields `[]`.
 */
export function parseDuckDuckGoResults(html: string, limit?: number): SearchResult[] {
  if (typeof html !== 'string' || html.length === 0) return [];

  // Match anchors carrying class="result__a". DDG's noscript page has
  // these on every result row; the href points at the /l/?uddg=... redirect
  // and the inner text is the title (which itself may contain nested tags
  // like <b> for query highlights — strip those after capture).
  //
  // We allow:
  //   - any attribute order (href before/after class)
  //   - extra attributes (rel, target, data-*)
  //   - either single or double quotes around attribute values
  //   - inner text spanning newlines
  //
  // The regex is intentionally lenient on the closing side: we look for
  // either `</a>` or the start of the next anchor / known sentinel, so a
  // missing `</a>` in malformed input doesn't swallow the rest of the page.
  const titleAnchors = matchResultAnchors(html, 'result__a');
  if (titleAnchors.length === 0) return [];

  const snippetAnchors = matchResultAnchors(html, 'result__snippet');

  // DDG emits results in document order; pair the i-th title with the
  // i-th snippet. If counts disagree (rare, e.g. ad rows or truncation),
  // we just leave the snippet undefined for unpaired titles.
  const cappedLimit = Math.max(0, Math.min(limit ?? MAX_RESULTS, MAX_RESULTS));
  const results: SearchResult[] = [];
  for (let i = 0; i < titleAnchors.length && results.length < cappedLimit; i++) {
    const t = titleAnchors[i];
    const title = stripTags(t.inner).trim();
    if (!title) continue; // skip empty rows
    const url = decodeDuckDuckGoRedirect(t.href);
    const snippetText = snippetAnchors[i] ? stripTags(snippetAnchors[i].inner).trim() : '';
    const rec: SearchResult = {
      title,
      url,
      rank: results.length + 1,
    };
    if (snippetText) rec.snippet = snippetText;
    results.push(rec);
  }
  return results;
}

interface AnchorMatch {
  href: string;
  inner: string;
}

/**
 * Find `<a ... class="...<className>...">INNER</a>`-shaped anchors in the
 * input. Returns href + inner text for each one. Tolerant of:
 *   - attributes appearing in either order
 *   - single OR double quoted attributes
 *   - extra classes alongside the target one
 *   - missing closing `</a>` (we then take inner text up to the next `<a `
 *     occurrence or a chunk cap)
 *
 * Implemented as a manual scan over `<a ` tokens rather than a single
 * monster regex, because DDG's anchors sometimes contain nested tags
 * (`<b>` highlights) and the lazy-match form `(.*?)</a>` would over-match
 * on malformed HTML where a closing `</a>` is absent.
 */
function matchResultAnchors(html: string, className: string): AnchorMatch[] {
  const out: AnchorMatch[] = [];
  // Find each opening <a ...> tag and inspect its attributes.
  const openRe = /<a\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html)) !== null) {
    const attrs = m[1];
    if (!attrAdvertisesClass(attrs, className)) continue;
    const href = extractHref(attrs) ?? '';
    const innerStart = openRe.lastIndex;
    // Find the inner text. Search for the matching `</a>`; if absent within
    // a sane window, fall back to the next `<a ` opening or 4 KB.
    const closeIdx = findClose(html, innerStart);
    const inner = html.slice(innerStart, closeIdx);
    out.push({ href, inner });
  }
  return out;
}

/**
 * Does `attrs` (the bytes between `<a` and `>`) include the given class
 * token? Handles class lists like `class="result__a js-result"`, single
 * quotes, and missing quotes (e.g. `class=result__a`).
 */
function attrAdvertisesClass(attrs: string, className: string): boolean {
  const re = new RegExp(
    `\\bclass\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i',
  );
  const m = re.exec(attrs);
  if (!m) return false;
  const value = m[1] ?? m[2] ?? m[3] ?? '';
  // Tokenize on whitespace and look for an exact match. Avoid substring
  // matches so `result__a_extra` doesn't satisfy `result__a`.
  return value.split(/\s+/).includes(className);
}

function extractHref(attrs: string): string | null {
  const m = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  if (!m) return null;
  return decodeHtmlEntities(m[1] ?? m[2] ?? m[3] ?? '');
}

/**
 * Locate the `</a>` that closes an anchor opened at index 0 of the given
 * substring. We search forward from `innerStart`. If not found within a
 * generous window, fall back to the start of the next `<a ` opening (so we
 * don't swallow subsequent results) or a 4 KB cap. The window guards
 * against a stray `</a>` thousands of lines down accidentally pairing.
 */
function findClose(html: string, innerStart: number): number {
  const window = 4096;
  const end = Math.min(html.length, innerStart + window);
  const slice = html.slice(innerStart, end);
  const closeIdx = slice.search(/<\/a\s*>/i);
  if (closeIdx >= 0) return innerStart + closeIdx;
  // No close — fall back to the next opening anchor in the slice, so we
  // don't bleed into subsequent results.
  const nextOpen = slice.search(/<a\b/i);
  if (nextOpen >= 0) return innerStart + nextOpen;
  return end;
}

/** Strip HTML tags from a chunk of inner text (e.g. the `<b>` highlights DDG injects in titles). */
function stripTags(s: string): string {
  return decodeHtmlEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ');
}

/**
 * DDG result links look like `/l/?uddg=https%3A%2F%2Fexample.com%2F1` (and
 * occasionally `//duckduckgo.com/l/?uddg=...`). Pull the `uddg` param,
 * URI-decode it, and return the underlying URL. On any failure, return the
 * raw href so the model can still try it.
 */
function decodeDuckDuckGoRedirect(href: string): string {
  if (!href) return href;
  // Quick reject: if there's no `uddg=` token, it's not a DDG redirect.
  if (!/[?&]uddg=/i.test(href)) return href;
  const m = /[?&]uddg=([^&#]*)/i.exec(href);
  if (!m) return href;
  const encoded = m[1];
  try {
    const decoded = decodeURIComponent(encoded);
    // Sanity check: the decoded value should look URL-shaped. If it
    // doesn't, fall back to raw.
    if (/^https?:\/\//i.test(decoded)) return decoded;
    return href;
  } catch {
    // Malformed percent-encoding — keep the raw href.
    return href;
  }
}

/**
 * Decode a small set of HTML entities commonly present in DDG output.
 * We don't pull in a full entity table; the noscript endpoint uses very
 * few entity references in titles/URLs (mostly `&amp;`).
 */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ');
}

const argsSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(MAX_RESULTS).optional(),
});

const outputSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      snippet: z.string().optional(),
      rank: z.number().int(),
    }),
  ),
});

type SearchArgs = z.infer<typeof argsSchema>;
type SearchOutput = z.infer<typeof outputSchema>;

export const searchTool: ToolHandler<SearchArgs, SearchOutput> = {
  name: 'search',
  description:
    'Search DuckDuckGo for the given query. Returns up to N web results with title, url, and snippet. Use for finding pages to inspect with `tab.open` + `aria.extract`.',
  argsSchema,
  outputSchema,
  parametersJSON: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description: 'The search query.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_RESULTS,
        description: `Max results to return (default ${DEFAULT_LIMIT}, max ${MAX_RESULTS}).`,
      },
    },
    required: ['query'],
  },
  execute: async (args) => {
    const limit = args.limit ?? DEFAULT_LIMIT;
    const url = new URL(DDG_HTML_ENDPOINT);
    url.searchParams.set('q', args.query);

    const html = await withBrowserTimeout(
      async () => {
        let response: Response;
        try {
          response = await fetch(url.toString(), {
            method: 'GET',
            headers: {
              // DDG's noscript page returns a leaner body to bot-shaped UAs;
              // a normal browser-ish UA plus accepting HTML keeps the markup
              // we rely on for parsing.
              Accept: 'text/html,application/xhtml+xml',
            },
          });
        } catch (e) {
          // Network-layer failure (DNS, refused, offline). Non-fatal so the
          // model can retry with a different query / wait.
          throw new BrowserToolError(
            `search network error: ${(e as Error).message}`,
            { fatal: false },
          );
        }
        if (!response.ok) {
          throw new BrowserToolError(
            `DuckDuckGo HTTP ${response.status}`,
            { fatal: false },
          );
        }
        return response.text();
      },
      FETCH_TIMEOUT_MS,
      'search',
    );

    const all = parseDuckDuckGoResults(html, limit);
    // parseDuckDuckGoResults already truncates to `limit` and assigns
    // contiguous 1..N ranks, so no further re-ranking is needed.
    return { results: all };
  },
};
