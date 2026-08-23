/**
 * Top-level `{{key}}` fill for prompt templates.
 *
 * Walks the original template once. Inserted values are literal: `$`, `$'`,
 * `` $` ``, `$&`, `$1`, and `{{otherKey}}` inside a value are not treated as
 * JavaScript replacement patterns or as further placeholders.
 */
export function fillPromptTemplate(
  template: string,
  input: Record<string, unknown>,
): { text: string; substitutedKeys: Set<string> } {
  const substitutedKeys = new Set<string>();
  const text = template.replace(/\{\{([^{}]+)\}\}/g, (full, key: string) => {
    if (!Object.hasOwn(input, key)) {
      return full;
    }
    substitutedKeys.add(key);
    return String(input[key]);
  });
  return { text, substitutedKeys };
}
