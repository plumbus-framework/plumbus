import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DEFAULT_INPUT_ARRAY_MAX_ITEMS,
  findCollectionBoundViolation,
  resolveInputArrayMaxItems,
  safeParseBounded,
} from '../bounded-parse.js';

const junk = (n: number) => Array(n).fill(0);

describe('safeParseBounded', () => {
  it('refuses an array over its .max() before zod walks it (GHSA-mrhx-c7xc-m3w5)', () => {
    const schema = z.object({ ids: z.array(z.string().guid()).max(100) });
    const started = performance.now();
    const result = safeParseBounded(schema, { ids: junk(2_000_000) });
    const elapsed = performance.now() - started;
    expect(result.success).toBe(false);
    if (result.success) return;
    // Plain zod 3 builds 2 000 001 issues here (~1.8 s, ~530 MB).
    expect(result.error.issues).toEqual([
      expect.objectContaining({ code: 'too_big', maximum: 100, origin: 'array', path: ['ids'] }),
    ]);
    expect(elapsed).toBeLessThan(200);
  });

  it('applies .length() as an exact bound', () => {
    const result = safeParseBounded(z.array(z.number()).length(3), junk(4));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]).toMatchObject({ exact: true, maximum: 3 });
  });

  it('caps an array the schema leaves unbounded, and lets a declared .max() above the cap win', () => {
    const unbounded = safeParseBounded(
      z.object({ rows: z.array(z.string()) }),
      { rows: junk(11) },
      10,
    );
    expect(unbounded.success).toBe(false);
    if (!unbounded.success)
      expect(unbounded.error.issues[0]).toMatchObject({ maximum: 10, path: ['rows'] });
    const declared = safeParseBounded(z.array(z.number()).max(20), junk(15), 10);
    expect(declared.success).toBe(true);
  });

  it('follows nested objects, arrays, records, tuples, intersections and wrappers', () => {
    const schema = z
      .object({
        groups: z.array(z.object({ members: z.array(z.string()).max(2) })).max(5),
        byKey: z.record(z.string(), z.array(z.number()).max(1)).optional(),
        pair: z.tuple([z.string()]).rest(z.array(z.number()).max(1)),
        both: z.intersection(
          z.object({ a: z.array(z.number()).max(1) }),
          z.object({ b: z.string() }),
        ),
      })
      .transform((v) => v);
    expect(
      findCollectionBoundViolation(schema, { groups: [{ members: ['a', 'b', 'c'] }] }, 100),
    ).toEqual({
      path: ['groups', 0, 'members'],
      maximum: 2,
      exact: false,
    });
    expect(findCollectionBoundViolation(schema, { byKey: { k: [1, 2] } }, 100)?.path).toEqual([
      'byKey',
      'k',
    ]);
    expect(findCollectionBoundViolation(schema, { pair: ['x', [1, 2]] }, 100)?.path).toEqual([
      'pair',
      1,
    ]);
    expect(
      findCollectionBoundViolation(schema, { both: { a: [1, 2], b: 'x' } }, 100)?.path,
    ).toEqual(['both', 'a']);
  });

  it('caps arrays where the schema cannot be followed: unions, any, unknown keys, lazy', () => {
    const union = z.union([
      z.object({ a: z.string() }),
      z.object({ b: z.array(z.number()).max(1000) }),
    ]);
    expect(findCollectionBoundViolation(union, { b: junk(11) }, 10)?.maximum).toBe(10);
    expect(findCollectionBoundViolation(z.any(), [[junk(11)]], 10)?.path).toEqual([0, 0]);
    expect(
      findCollectionBoundViolation(z.object({}).passthrough(), { extra: junk(11) }, 10)?.path,
    ).toEqual(['extra']);
    const lazy: z.ZodTypeAny = z.lazy(() => z.array(lazy));
    expect(findCollectionBoundViolation(lazy, [junk(11)], 10)?.path).toEqual([0]);
  });

  it('parses normally, with zod issues as before, when every array is within bounds', () => {
    const schema = z.object({ ids: z.array(z.string().guid()).max(3) });
    const ok = safeParseBounded(schema, { ids: ['3b241101-e2bb-4255-8caf-4136c566a962'] });
    expect(ok.success).toBe(true);
    const bad = safeParseBounded(schema, { ids: ['nope'] });
    expect(bad.success).toBe(false);
    if (!bad.success)
      expect(bad.error.issues[0]).toMatchObject({
        code: 'invalid_format',
        format: 'guid',
        path: ['ids', 0],
      });
  });

  it('reads PLUMBUS_INPUT_ARRAY_MAX_ITEMS and refuses a malformed value', () => {
    expect(resolveInputArrayMaxItems({})).toBe(DEFAULT_INPUT_ARRAY_MAX_ITEMS);
    expect(resolveInputArrayMaxItems({ PLUMBUS_INPUT_ARRAY_MAX_ITEMS: '500' })).toBe(500);
    expect(() => resolveInputArrayMaxItems({ PLUMBUS_INPUT_ARRAY_MAX_ITEMS: '0' })).toThrow(
      /positive integer/,
    );
    expect(() => resolveInputArrayMaxItems({ PLUMBUS_INPUT_ARRAY_MAX_ITEMS: 'many' })).toThrow(
      /positive integer/,
    );
  });
});
