import { describe, expect, it } from 'vitest';
import { parseJSONPermissive } from '../src/agent/roles/planner';

describe('parseJSONPermissive', () => {
  it('parses a raw JSON object', () => {
    expect(parseJSONPermissive('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses with leading/trailing whitespace', () => {
    expect(parseJSONPermissive('  \n{"a":1}\n  ')).toEqual({ a: 1 });
  });

  it('extracts JSON wrapped in a markdown code fence', () => {
    const input = '```json\n{"a":1,"b":2}\n```';
    expect(parseJSONPermissive(input)).toEqual({ a: 1, b: 2 });
  });

  it('extracts JSON with prose preamble', () => {
    const input = 'Here is the result: {"verdict":"done","reason":"ok"}';
    expect(parseJSONPermissive(input)).toEqual({ verdict: 'done', reason: 'ok' });
  });

  it('extracts JSON with prose suffix', () => {
    const input = '{"x":42} that\'s the answer';
    expect(parseJSONPermissive(input)).toEqual({ x: 42 });
  });

  it('handles nested objects', () => {
    expect(parseJSONPermissive('{"outer":{"inner":[1,2,3]}}')).toEqual({
      outer: { inner: [1, 2, 3] },
    });
  });

  it('handles strings containing braces', () => {
    expect(parseJSONPermissive('{"text":"contains {} braces"}')).toEqual({
      text: 'contains {} braces',
    });
  });

  it('handles escaped quotes inside strings', () => {
    expect(parseJSONPermissive('{"q":"a \\"quoted\\" word"}')).toEqual({
      q: 'a "quoted" word',
    });
  });

  it('throws on input with no JSON object', () => {
    expect(() => parseJSONPermissive('no JSON here')).toThrow();
  });

  it('throws on unbalanced braces', () => {
    expect(() => parseJSONPermissive('{"a": {"b": 1}')).toThrow();
  });
});
