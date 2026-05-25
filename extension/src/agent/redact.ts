// PII redaction (M3.5).
//
// Microsoft-Presidio-style regex catalogue, applied at persistence
// boundaries (state_store.appendFinding) so that long-term archives never
// include credit cards, SSNs, phones, emails, or street addresses verbatim.
// Scratchpad entries flow through with PII intact (they're ephemeral and
// the model legitimately needs them to act on a given turn); only what the
// Compactor archives gets redacted.
//
// Trade-offs taken:
//   * False positives are acceptable; false negatives are not. We err on
//     the side of redacting.
//   * No Luhn validation on credit cards — the regex is intentionally
//     loose (any 13–19-digit run with optional separators).
//   * Address detection is keyword-based, not ML-based. Misses unusual
//     formats; correctly catches the common US "123 Main Street"-style.
//   * `containsPII` returns true when ANY pattern matches; useful for
//     gating "should this even be shown to the user" decisions later.
//
// Replacement tokens are stable (`[CC]`, `[SSN]`, etc.) so downstream
// retrieval can still reason about "the user has stored a credit card"
// without exposing the digits.

export type PIIKind = 'CC' | 'SSN' | 'PHONE' | 'EMAIL' | 'ADDRESS';

interface Pattern {
  kind: PIIKind;
  re: RegExp;
  /** Replacement token; e.g. `[CC]`. */
  token: string;
}

// Order matters — earlier patterns take precedence so e.g. an SSN-shaped
// substring inside a longer credit-card-shaped run is captured by CC first.
const PATTERNS: readonly Pattern[] = [
  // Credit card: 13–19 digits with optional spaces or dashes between groups.
  // Examples matched:
  //   4111-1111-1111-1111   ->  [CC]
  //   4111 1111 1111 1111   ->  [CC]
  //   4111111111111111      ->  [CC]
  //   3782 822463 10005     ->  [CC] (Amex)
  {
    kind: 'CC',
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    token: '[CC]',
  },
  // SSN: ddd-dd-dddd. Loose: any of `-`, ` `, no separator.
  {
    kind: 'SSN',
    re: /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g,
    token: '[SSN]',
  },
  // Phone: optional `+1` or `(`-prefix, three groups of 3-3-4 digits with
  // common separators. Doesn't match raw 10-digit runs (those would
  // collide with longer numerics).
  {
    kind: 'PHONE',
    re: /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g,
    token: '[PHONE]',
  },
  // Email: standard local@domain.tld. Permits subdomains + plus addressing.
  {
    kind: 'EMAIL',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    token: '[EMAIL]',
  },
  // Street address (US-leaning): N digits + street-name + street-type
  // keyword. Catches "123 Main Street", "10 W Maple Ave", "1600 Pennsylvania
  // Avenue NW". Misses non-numbered or international formats. Note: in
  // alternation `NE|NW|SE|SW` MUST precede `[NSEW]\.?` or the single-letter
  // branch matches "N" and leaves "W" trailing.
  {
    kind: 'ADDRESS',
    re: /\b\d{1,5}\s+(?:[NSEW]\.?\s+)?[A-Za-z][A-Za-z0-9'.-]*(?:\s+[A-Za-z][A-Za-z0-9'.-]*)?\s+(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Drive|Dr\.?|Lane|Ln\.?|Way|Court|Ct\.?|Place|Pl\.?|Parkway|Pkwy\.?|Terrace|Ter\.?|Highway|Hwy\.?)\b(?:\s+(?:NE|NW|SE|SW|North|South|East|West|[NSEW]\.?))?/gi,
    token: '[ADDRESS]',
  },
];

/**
 * Replace PII-shaped substrings with stable redaction tokens. Empty input
 * is returned unchanged. Patterns are applied in priority order (CC first
 * so a long digit run isn't wrongly captured by a narrower pattern).
 */
export function redactPII(text: string): string {
  if (!text) return text;
  let out = text;
  for (const p of PATTERNS) {
    out = out.replace(p.re, p.token);
  }
  return out;
}

/** True if any PII pattern matches the input. Cheap one-shot scan. */
export function containsPII(text: string): boolean {
  if (!text) return false;
  for (const p of PATTERNS) {
    p.re.lastIndex = 0; // global regexes carry state
    if (p.re.test(text)) return true;
  }
  return false;
}

/** Per-pattern detection — returns an array of (kind, match) pairs. Useful
 *  for telemetry ("we redacted 3 PHONE matches in this finding"). */
export function findPII(text: string): { kind: PIIKind; match: string }[] {
  if (!text) return [];
  const results: { kind: PIIKind; match: string }[] = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(text)) !== null) {
      results.push({ kind: p.kind, match: m[0] });
    }
  }
  return results;
}
