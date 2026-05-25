// Tests for the PII redaction module (M3.5).
//
// Each pattern gets coverage:
//   * matches expected substrings
//   * leaves unrelated text alone
//   * mixed-content strings get all PII redacted in one pass
//   * appendFinding integration: persisted value is redacted

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  redactPII,
  containsPII,
  findPII,
} from '../src/agent/redact';
import { startTask, appendFinding, findingByKey } from '../src/agent/state_store';
import { resetMockedStorage } from './setup';

beforeEach(async () => await resetMockedStorage());
afterEach(async () => await resetMockedStorage());

describe('redactPII: credit-card pattern', () => {
  it('redacts dashed 16-digit cards', () => {
    expect(redactPII('Card: 4111-1111-1111-1111')).toBe('Card: [CC]');
  });
  it('redacts space-grouped cards', () => {
    expect(redactPII('Card: 4111 1111 1111 1111')).toBe('Card: [CC]');
  });
  it('redacts unspaced 16-digit runs', () => {
    expect(redactPII('Card: 4111111111111111')).toBe('Card: [CC]');
  });
  it('redacts Amex-style 15 digits', () => {
    // Loose pattern matches 13–19 digits.
    expect(redactPII('Card: 3782 822463 10005')).toBe('Card: [CC]');
  });
  it('does not redact 12-or-fewer digits', () => {
    expect(redactPII('id: 12345 67890')).toBe('id: 12345 67890');
  });
});

describe('redactPII: SSN pattern', () => {
  it('redacts dashed SSN', () => {
    expect(redactPII('SSN 123-45-6789 on file')).toBe('SSN [SSN] on file');
  });
  it('redacts space-separated SSN', () => {
    expect(redactPII('SSN 123 45 6789')).toBe('SSN [SSN]');
  });
  it('does not redact unrelated 9-digit runs (no separator)', () => {
    expect(redactPII('id 123456789')).toBe('id 123456789');
  });
});

describe('redactPII: phone pattern', () => {
  it('redacts US-style phone with parens', () => {
    expect(redactPII('Call (555) 867-5309')).toBe('Call [PHONE]');
  });
  it('redacts hyphenated phone', () => {
    expect(redactPII('Call 555-867-5309')).toBe('Call [PHONE]');
  });
  it('redacts +1-prefixed phone', () => {
    expect(redactPII('Call +1 555 867 5309')).toBe('Call [PHONE]');
  });
  it('does not redact short numbers', () => {
    expect(redactPII('extension 1234')).toBe('extension 1234');
  });
});

describe('redactPII: email pattern', () => {
  it('redacts standard email', () => {
    expect(redactPII('Reach me at jane@example.com')).toBe('Reach me at [EMAIL]');
  });
  it('redacts plus-addressed email', () => {
    expect(redactPII('jane+filter@sub.example.com')).toBe('[EMAIL]');
  });
  it('does not redact non-email at-shapes', () => {
    expect(redactPII('@username on twitter')).toBe('@username on twitter');
  });
});

describe('redactPII: address pattern', () => {
  it('redacts simple street address', () => {
    expect(redactPII('Ship to 123 Main Street')).toBe('Ship to [ADDRESS]');
  });
  it('redacts abbreviated street types', () => {
    expect(redactPII('Ship to 10 W Maple Ave')).toBe('Ship to [ADDRESS]');
  });
  it('redacts addresses with NW/NE suffix', () => {
    expect(redactPII('1600 Pennsylvania Avenue NW')).toBe('[ADDRESS]');
  });
  it('does not redact bare numbered text', () => {
    expect(redactPII('Order 123 Wireless')).toBe('Order 123 Wireless');
  });
});

describe('redactPII: composite + edge cases', () => {
  it('redacts multiple PII kinds in one pass', () => {
    const input = 'Email jane@x.com or call 555-867-5309 from 123 Main Street';
    const out = redactPII(input);
    expect(out).toContain('[EMAIL]');
    expect(out).toContain('[PHONE]');
    expect(out).toContain('[ADDRESS]');
    expect(out).not.toContain('jane@x.com');
    expect(out).not.toContain('555-867-5309');
    expect(out).not.toContain('123 Main Street');
  });

  it('passes through clean text unchanged', () => {
    const input = 'Find the cheapest 4K monitor under $400 from Amazon';
    expect(redactPII(input)).toBe(input);
  });

  it('handles empty/null/undefined gracefully', () => {
    expect(redactPII('')).toBe('');
    expect(redactPII(undefined as unknown as string)).toBe(undefined);
    expect(redactPII(null as unknown as string)).toBe(null);
  });
});

describe('containsPII', () => {
  it('detects a single PII match', () => {
    expect(containsPII('email me at x@y.com')).toBe(true);
  });
  it('returns false for clean text', () => {
    expect(containsPII('shopping for headphones')).toBe(false);
  });
  it('returns false for empty/null', () => {
    expect(containsPII('')).toBe(false);
    expect(containsPII(undefined as unknown as string)).toBe(false);
  });
});

describe('findPII (per-pattern enumeration)', () => {
  it('returns each match with its kind', () => {
    const matches = findPII('Reach jane@x.com or call 555-867-5309');
    const kinds = matches.map((m) => m.kind).sort();
    expect(kinds).toEqual(['EMAIL', 'PHONE']);
  });

  it('returns empty array on clean text', () => {
    expect(findPII('shopping')).toEqual([]);
  });
});

describe('appendFinding integration: persists redacted value', () => {
  it('redacts PII before writing to IDB', async () => {
    const state = await startTask('test');
    const f = await appendFinding({
      taskId: state.taskId,
      source: 'compactor',
      stepId: null,
      kind: 'fact',
      key: 'shipping_addr',
      value: 'Ship to 123 Main Street, contact jane@x.com',
      evidence: 'phone 555-867-5309',
    });
    expect(f.value).not.toContain('123 Main Street');
    expect(f.value).not.toContain('jane@x.com');
    expect(f.value).toContain('[ADDRESS]');
    expect(f.value).toContain('[EMAIL]');
    expect(f.evidence).toBe('phone [PHONE]');

    // Verify what's in IDB matches.
    const fetched = await findingByKey(state.taskId, 'shipping_addr');
    expect(fetched?.value).toBe(f.value);
  });

  it('leaves clean values unchanged', async () => {
    const state = await startTask('test');
    const f = await appendFinding({
      taskId: state.taskId,
      source: 'compactor',
      stepId: null,
      kind: 'fact',
      key: 'price',
      value: '$298 for the Sony WH-1000XM5',
    });
    expect(f.value).toBe('$298 for the Sony WH-1000XM5');
  });
});
