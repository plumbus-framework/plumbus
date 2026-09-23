/** Strict, bounded JSON shared by request validation and response decoding. */
import { z } from '@plumbus/core/zod';
import type { DecisionJson } from './types.js';

export function jsonRecord<T extends z.ZodTypeAny>(schema: T) {
  return z
    .custom<Record<string, z.input<T>>>((value) => {
      if (value === null || typeof value !== 'object') return false;
      const prototype = Object.getPrototypeOf(value);
      return (
        (prototype === Object.prototype || prototype === null) && !Object.hasOwn(value, '__proto__')
      );
    }, 'Expected a plain JSON object without __proto__')
    .pipe(z.record(UnicodeString, schema));
}

// Look for isolated halves instead of repeating a whole-string regex over large inputs.
const UnicodeString = z
  .string()
  .refine(
    (value) =>
      !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value),
    'Invalid Unicode surrogate',
  );
const JsonLeaf = z.union([UnicodeString, z.number().finite(), z.boolean(), z.null()]);

function boundedJsonSchema(): z.ZodType<DecisionJson> {
  let schema: z.ZodType<DecisionJson> = JsonLeaf;
  for (let depth = 0; depth < 64; depth++) {
    const child = schema;
    schema = z.union([JsonLeaf, z.array(child), jsonRecord(child)]);
  }
  return schema;
}

/** Plain JSON with finite numbers, valid Unicode, and at most 64 nested containers. */
export const DecisionJsonSchema = boundedJsonSchema();

/** JSON.parse checks grammar; this scan additionally rejects duplicate decoded keys. */
export const DecisionJsonTextSchema = z
  .string()
  .transform((text, context): unknown => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      context.addIssue({ code: 'custom', message: 'Invalid JSON syntax' });
      return z.NEVER;
    }
    const stack: Array<
      { kind: 'array' } | { kind: 'object'; keys: Set<string>; expectKey: boolean }
    > = [];
    const tokens = /"(?:[^"\\]|\\[\s\S])*"|[{}[\],]/g;
    for (const match of text.matchAll(tokens)) {
      const token = match[0];
      const frame = stack.at(-1);
      if (token.startsWith('"') && frame?.kind === 'object' && frame.expectKey) {
        const key: string = JSON.parse(token);
        if (frame.keys.has(key)) {
          context.addIssue({ code: 'custom', message: 'Duplicate JSON key' });
          return z.NEVER;
        }
        frame.keys.add(key);
        frame.expectKey = false;
      } else if (token === '{') {
        stack.push({ kind: 'object', keys: new Set(), expectKey: true });
      } else if (token === '[') {
        stack.push({ kind: 'array' });
      } else if (token === '}' || token === ']') {
        stack.pop();
      } else if (token === ',' && frame?.kind === 'object') {
        frame.expectKey = true;
      }
      if (stack.length > 64) {
        context.addIssue({ code: 'custom', message: 'JSON nesting exceeds 64 levels' });
        return z.NEVER;
      }
    }
    return value;
  })
  .pipe(DecisionJsonSchema);
