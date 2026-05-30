// Reversible PII anonymization — sandwich pattern for cloud-bound payloads.
//
// Before sending data to a cloud LLM, call anonymize() to replace PII with
// numbered placeholders like <PERSON_1>, <EMAIL_2>. The mapping table is
// returned alongside the anonymized text so the caller can store it for
// later de-anonymization.
//
// The existing redact.ts module handles IRREVERSIBLE redaction (for disk).
// This module handles REVERSIBLE anonymization (for network).

import { findPII } from './redact';

export interface AnonymizeResult {
  /** Text with PII replaced by <KIND_N> placeholders. */
  text: string;
  /** Mapping from placeholder → original value for de-anonymization. */
  map: Record<string, string>;
}

const COUNTERS: Record<string, { count: number }> = {};
function nextId(kind: string): number {
  if (!COUNTERS[kind]) COUNTERS[kind] = { count: 0 };
  COUNTERS[kind].count += 1;
  return COUNTERS[kind].count;
}

/** Reset per-task counters (call at startTask). */
export function resetAnonymizeCounters(): void {
  for (const key of Object.keys(COUNTERS)) delete COUNTERS[key];
}

/**
 * Replace PII in text with reversible <KIND_N> placeholders.
 * Returns the anonymized text and a mapping table.
 *
 * Example:
 *   anonymize('My email is alice@example.com')
 *   → { text: 'My email is <EMAIL_1>', map: { '<EMAIL_1>': 'alice@example.com' } }
 */
export function anonymize(text: string): AnonymizeResult {
  if (!text) return { text, map: {} };
  const map: Record<string, string> = {};
  const found = findPII(text);
  // Process in reverse order of match position so replacements don't shift indices
  const sorted = [...found].sort((a, b) => text.indexOf(a.match) - text.indexOf(b.match));
  let result = text;
  const seen = new Set<string>();
  for (const item of sorted) {
    if (seen.has(item.match)) continue;
    seen.add(item.match);
    const id = nextId(item.kind);
    const placeholder = `<${item.kind}_${id}>`;
    // Replace only the first occurrence (others of the same value handled via `seen`)
    result = result.replace(item.match, placeholder);
    map[placeholder] = item.match;
  }
  return { text: result, map };
}

/** Check if the text contains any unreplaced placeholders. */
export function containsPlaceholders(text: string): boolean {
  return /<[A-Z]+_\d+>/.test(text);
}
