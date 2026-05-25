// Tests for the DuckDuckGo search tool — pure parser + mocked tool execute.
// We never hit the real DDG endpoint here; the tool's network path is
// validated against a stubbed global.fetch so the suite is deterministic
// and can run offline.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseDuckDuckGoResults,
  searchTool,
  type SearchResult,
} from '../src/agent/tools/browser/search';

// ──────────────────────────────────────────────────────────────────────
// Fixtures (inline strings, kept here for reviewability rather than as
// external HTML files — small enough to read and reason about in place).
// ──────────────────────────────────────────────────────────────────────

/** 5 realistic DDG-shaped results with encoded /l/?uddg=... redirects + snippets. */
const FIXTURE_FIVE_RESULTS = `
<!DOCTYPE html>
<html>
  <head><title>q at DuckDuckGo</title></head>
  <body>
    <div class="results">
      <div class="result">
        <h2 class="result__title">
          <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2F1&rut=abc">Title 1</a>
        </h2>
        <a class="result__snippet" href="/l/?uddg=https%3A%2F%2Fexample.com%2F1">Snippet text for result one with some <b>highlighted</b> words.</a>
      </div>
      <div class="result">
        <h2 class="result__title">
          <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2F2&rut=def">Title <b>2</b></a>
        </h2>
        <a class="result__snippet" href="/l/?uddg=https%3A%2F%2Fexample.com%2F2">Second snippet — explains the second page.</a>
      </div>
      <div class="result">
        <h2 class="result__title">
          <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2F3">Title 3</a>
        </h2>
        <a class="result__snippet" href="/l/?uddg=https%3A%2F%2Fexample.com%2F3">Third snippet describes the third hit.</a>
      </div>
      <div class="result">
        <h2 class="result__title">
          <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2F4">Title 4</a>
        </h2>
        <a class="result__snippet" href="/l/?uddg=https%3A%2F%2Fexample.com%2F4">Fourth snippet text here, a little longer to exercise whitespace handling.</a>
      </div>
      <div class="result">
        <h2 class="result__title">
          <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2F5">Title 5</a>
        </h2>
        <a class="result__snippet" href="/l/?uddg=https%3A%2F%2Fexample.com%2F5">Fifth snippet rounds out the page.</a>
      </div>
    </div>
  </body>
</html>
`;

/** DDG "no results" page — no result__a anchors anywhere. */
const FIXTURE_EMPTY = `
<!DOCTYPE html>
<html>
  <head><title>no results at DuckDuckGo</title></head>
  <body>
    <div class="results">
      <div class="no-results">
        <p>No results found for your query. Try a different search term.</p>
      </div>
    </div>
  </body>
</html>
`;

// ──────────────────────────────────────────────────────────────────────
// parseDuckDuckGoResults — pure parser tests
// ──────────────────────────────────────────────────────────────────────

describe('parseDuckDuckGoResults', () => {
  it('returns 5 records with sequential ranks 1..5 from a 5-result fixture', () => {
    const out = parseDuckDuckGoResults(FIXTURE_FIVE_RESULTS);
    expect(out).toHaveLength(5);
    expect(out.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it('decodes the /l/?uddg=... redirect into the underlying URL', () => {
    const out = parseDuckDuckGoResults(FIXTURE_FIVE_RESULTS);
    expect(out.map((r) => r.url)).toEqual([
      'https://example.com/1',
      'https://example.com/2',
      'https://example.com/3',
      'https://example.com/4',
      'https://example.com/5',
    ]);
  });

  it('strips inline highlight tags (<b>) from titles', () => {
    const out = parseDuckDuckGoResults(FIXTURE_FIVE_RESULTS);
    expect(out[1].title).toBe('Title 2');
  });

  it('extracts snippets paired with each result', () => {
    const out = parseDuckDuckGoResults(FIXTURE_FIVE_RESULTS);
    for (const r of out) {
      expect(r.snippet).toBeTypeOf('string');
      expect((r.snippet ?? '').length).toBeGreaterThan(0);
    }
    expect(out[0].snippet).toContain('result one');
  });

  it('returns an empty array on a no-results page', () => {
    const out = parseDuckDuckGoResults(FIXTURE_EMPTY);
    expect(out).toEqual([]);
  });

  it('tolerates malformed HTML with all closing </a> tags removed and still returns at least 4 results', () => {
    const broken = FIXTURE_FIVE_RESULTS.replace(/<\/a>/g, '');
    const out = parseDuckDuckGoResults(broken);
    expect(out.length).toBeGreaterThanOrEqual(4);
    // Each parsed record should still have a usable title and url.
    for (const r of out) {
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.url.length).toBeGreaterThan(0);
    }
  });

  it('respects the optional limit argument (5 results, limit=3 → 3 records)', () => {
    const out = parseDuckDuckGoResults(FIXTURE_FIVE_RESULTS, 3);
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(out.map((r) => r.url)).toEqual([
      'https://example.com/1',
      'https://example.com/2',
      'https://example.com/3',
    ]);
  });

  it('falls back to the raw href when /l/?uddg= is malformed (does not crash)', () => {
    // Two flavors of broken redirects:
    //   - uddg= present but with un-decodable percent-encoding
    //   - uddg= entirely missing (the link points somewhere else)
    const malformed = `
      <a class="result__a" href="/l/?uddg=%E0%A4%A">Bad encoding</a>
      <a class="result__snippet">snippet a</a>
      <a class="result__a" href="/some/other/path?foo=bar">No uddg param</a>
      <a class="result__snippet">snippet b</a>
    `;
    const out = parseDuckDuckGoResults(malformed);
    expect(out).toHaveLength(2);
    // The first should keep the raw href because percent-decoding fails.
    expect(out[0].url).toBe('/l/?uddg=%E0%A4%A');
    // The second has no uddg param at all → keep the raw path.
    expect(out[1].url).toBe('/some/other/path?foo=bar');
  });

  it('returns an empty array for empty / non-string inputs without throwing', () => {
    expect(parseDuckDuckGoResults('')).toEqual([]);
    // Cast through unknown to test the runtime guard explicitly.
    const notAString = parseDuckDuckGoResults(undefined as unknown as string);
    expect(notAString).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// searchTool.execute — mocked global.fetch
// ──────────────────────────────────────────────────────────────────────

describe('searchTool.execute (mocked fetch)', () => {
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (originalFetch !== undefined) {
      globalThis.fetch = originalFetch;
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
    vi.restoreAllMocks();
  });

  it('fetches the DDG endpoint with the query encoded and returns the parsed records', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => FIXTURE_FIVE_RESULTS,
    }) as unknown as Response);
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const out = await searchTool.execute(
      { query: 'best wireless headphones 2026' },
      { taskId: 't1', stepId: null },
    );

    expect(out.results).toHaveLength(5);
    const expectedRecords: SearchResult[] = [
      { title: 'Title 1', url: 'https://example.com/1', rank: 1 },
      { title: 'Title 2', url: 'https://example.com/2', rank: 2 },
      { title: 'Title 3', url: 'https://example.com/3', rank: 3 },
      { title: 'Title 4', url: 'https://example.com/4', rank: 4 },
      { title: 'Title 5', url: 'https://example.com/5', rank: 5 },
    ];
    for (let i = 0; i < expectedRecords.length; i++) {
      expect(out.results[i].title).toBe(expectedRecords[i].title);
      expect(out.results[i].url).toBe(expectedRecords[i].url);
      expect(out.results[i].rank).toBe(expectedRecords[i].rank);
      expect(out.results[i].snippet).toBeTypeOf('string');
    }

    // Verify the URL used contained the URL-encoded query.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchSpy.mock.calls[0][0]);
    expect(calledUrl.startsWith('https://html.duckduckgo.com/html/')).toBe(true);
    // URLSearchParams encodes spaces as `+` — accept either `+` or `%20`.
    expect(
      calledUrl.includes('q=best+wireless+headphones+2026') ||
        calledUrl.includes('q=best%20wireless%20headphones%202026'),
    ).toBe(true);
  });

  it('respects the limit argument when invoked through the tool', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      text: async () => FIXTURE_FIVE_RESULTS,
    }) as unknown as Response) as unknown as typeof fetch;

    const out = await searchTool.execute(
      { query: 'test', limit: 2 },
      { taskId: 't1', stepId: null },
    );
    expect(out.results).toHaveLength(2);
    expect(out.results.map((r) => r.rank)).toEqual([1, 2]);
  });

  it('throws a non-fatal BrowserToolError on a non-OK HTTP response', async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 503,
      text: async () => 'service unavailable',
    }) as unknown as Response) as unknown as typeof fetch;

    await expect(
      searchTool.execute({ query: 'x' }, { taskId: 't1', stepId: null }),
    ).rejects.toMatchObject({
      name: 'BrowserToolError',
      fatal: false,
      message: expect.stringContaining('503'),
    });
  });

  it('throws a non-fatal BrowserToolError on a network-layer failure', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    await expect(
      searchTool.execute({ query: 'x' }, { taskId: 't1', stepId: null }),
    ).rejects.toMatchObject({
      name: 'BrowserToolError',
      fatal: false,
    });
  });
});
