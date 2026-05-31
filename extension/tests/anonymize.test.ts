import { describe, it, expect, beforeEach } from 'vitest';
import { anonymize, resetAnonymizeCounters, containsPlaceholders } from '../src/agent/anonymize';
import { deanonymize, reanonymize } from '../src/agent/deanonymize';

describe('anonymize + deanonymize round-trip', () => {
  beforeEach(() => resetAnonymizeCounters());

  it('replaces email with placeholder', () => {
    const result = anonymize('Contact me at alice@example.com');
    expect(result.text).toContain('<EMAIL_1>');
    expect(result.map['<EMAIL_1>']).toBe('alice@example.com');
  });

  it('round-trips email through deanonymize', () => {
    const input = 'My email is alice@example.com and I live at 123 Main St';
    const { text, map } = anonymize(input);
    const restored = deanonymize(text, map);
    expect(restored).toBe(input);
  });

  it('multiple PII of the same kind get different ids', () => {
    const { text, map } = anonymize('Call bob@a.com or alice@b.com');
    expect(text).toContain('<EMAIL_1>');
    expect(text).toContain('<EMAIL_2>');
    expect(Object.keys(map).length).toBe(2);
  });

  it('deduplicates repeated identical PII', () => {
    const { text, map } = anonymize('x@y.com is same as x@y.com');
    // Both occurrences replaced by the same placeholder
    expect(text).toContain('<EMAIL_1>');
    expect(Object.keys(map).length).toBe(1);
  });

  it('reanonymize re-applies after deanonymize', () => {
    const input = 'email: test@test.com';
    const { text, map } = anonymize(input);
    const restored = deanonymize(text, map);
    const reanoned = reanonymize(restored, map);
    expect(reanoned).toBe(text);
  });

  it('containsPlaceholders detects placeholders', () => {
    expect(containsPlaceholders('hello <EMAIL_1>')).toBe(true);
    expect(containsPlaceholders('no placeholders')).toBe(false);
  });

  it('deanonymize leaves unknown placeholders as-is', () => {
    const result = deanonymize('unknown <UNKNOWN_99>', {});
    expect(result).toBe('unknown <UNKNOWN_99>');
  });

  it('handles empty input', () => {
    expect(anonymize('').text).toBe('');
    expect(anonymize('').map).toEqual({});
    expect(deanonymize('', {})).toBe('');
  });

  it('replaces BOTH copies of repeated PII (no cleartext leak)', () => {
    const { text } = anonymize('x@y.com is same as x@y.com');
    // The literal email must not survive anywhere in the anonymized text.
    expect(text).not.toContain('x@y.com');
    // Both positions collapse to the same single placeholder.
    expect(text).toBe('<EMAIL_1> is same as <EMAIL_1>');
  });
});
