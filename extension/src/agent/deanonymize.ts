// De-anonymize cloud responses by replacing placeholders with original values.
//
// After the cloud returns a response containing <PERSON_1>, <EMAIL_2> etc.,
// call deanonymize(response, map) to restore the original values.

/**
 * Replace <KIND_N> placeholders with their original values from the mapping.
 * If a placeholder has no mapping entry, it's left as-is (conservative).
 */
export function deanonymize(text: string, map: Record<string, string>): string {
  if (!text) return text;
  return text.replace(/<([A-Z]+_\d+)>/g, (_match, key: string) => {
    const full = `<${key}>`;
    return map[full] ?? _match;
  });
}

/**
 * Re-anonymize (re-apply) after re-processing. If the mapping is still
 * available, calling this on text that came from an already-deanonymized
 * source will re-replace the same patterns.
 */
export function reanonymize(text: string, map: Record<string, string>): string {
  if (!text) return text;
  let result = text;
  for (const [placeholder, original] of Object.entries(map)) {
    result = result.split(original).join(placeholder);
  }
  return result;
}
