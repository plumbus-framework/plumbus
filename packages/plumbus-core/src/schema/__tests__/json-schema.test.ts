import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchemaObject } from '../json-schema.js';
import {
  zodDefaultValue,
  zodEnumValues,
  zodInnerType,
  zodObjectShape,
  zodTypeName,
} from '../zod-introspection.js';

/**
 * The shapes zod-to-json-schema (zod 3) produced, which contracts and provider schemas were built
 * on; the zod 4 converter keeps each of them.
 */
describe('zodToJsonSchemaObject keeps the zod 3 output shape', () => {
  it('closes default objects, opens passthrough ones, and leaves strict ones closed', () => {
    expect(zodToJsonSchemaObject(z.object({ a: z.string() }))).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    });
    expect(
      zodToJsonSchemaObject(z.object({ a: z.string() }).passthrough()).additionalProperties,
    ).toBe(true);
    expect(zodToJsonSchemaObject(z.object({ a: z.string() }).strict()).additionalProperties).toBe(
      false,
    );
  });

  it('describes the input side of transforms and pipes', () => {
    expect(
      zodToJsonSchemaObject(z.object({ n: z.string().transform((v) => v.length) })),
    ).toMatchObject({
      properties: { n: { type: 'string' } },
    });
  });

  it('adds no safe-integer bounds and keeps declared ones', () => {
    expect(zodToJsonSchemaObject(z.number().int())).toEqual({ type: 'integer' });
    expect(zodToJsonSchemaObject(z.number().int().min(1).max(9))).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 9,
    });
  });

  it('writes standard formats without zod 4 patterns, and zod-only formats as their pattern', () => {
    const shape = zodToJsonSchemaObject(
      z.object({
        e: z.string().email(),
        u: z.guid(),
        at: z.string().datetime(),
        day: z.string().date(),
        clock: z.string().time(),
        link: z.string().url(),
        host: z.ipv4(),
        net: z.cidrv4(),
        own: z
          .string()
          .email()
          .regex(/@college\.example$/),
      }),
    ).properties as Record<string, Record<string, unknown>>;
    expect(shape.e).toEqual({ type: 'string', format: 'email' });
    expect(shape.u).toEqual({ type: 'string', format: 'uuid' });
    expect(shape.at).toEqual({ type: 'string', format: 'date-time' });
    expect(shape.day).toEqual({ type: 'string', format: 'date' });
    expect(shape.clock).toEqual({ type: 'string', format: 'time' });
    expect(shape.link).toEqual({ type: 'string', format: 'uri' });
    expect(shape.host).toEqual({ type: 'string', format: 'ipv4' });
    expect(shape.net?.format).toBeUndefined();
    expect(typeof shape.net?.pattern).toBe('string');
    expect(shape.own).toMatchObject({ format: 'email', pattern: '@college\\.example$' });
  });

  it('writes dates as date-time strings and bigints as int64 integers', () => {
    expect(zodToJsonSchemaObject(z.date())).toEqual({ type: 'string', format: 'date-time' });
    expect(zodToJsonSchemaObject(z.bigint())).toEqual({ type: 'integer', format: 'int64' });
  });

  it('does not require unknown or any properties, which accept a missing key', () => {
    expect(
      zodToJsonSchemaObject(z.object({ u: z.unknown(), a: z.any(), s: z.string() })).required,
    ).toEqual(['s']);
    expect(zodToJsonSchemaObject(z.object({ u: z.unknown() })).required).toBeUndefined();
  });

  it('writes discriminated unions as anyOf, literal unions as one enum, and records without propertyNames', () => {
    const disc = zodToJsonSchemaObject(
      z.discriminatedUnion('k', [z.object({ k: z.literal('a') }), z.object({ k: z.literal('b') })]),
    );
    expect(disc.oneOf).toBeUndefined();
    expect(Array.isArray(disc.anyOf)).toBe(true);
    expect(zodToJsonSchemaObject(z.union([z.literal(1), z.literal('2')]))).toEqual({
      type: ['number', 'string'],
      enum: [1, '2'],
    });
    expect(zodToJsonSchemaObject(z.record(z.string(), z.number()))).toEqual({
      type: 'object',
      additionalProperties: { type: 'number' },
    });
  });

  it('keeps both sides of an intersection, so neither constraint is lost', () => {
    const json = zodToJsonSchemaObject(
      z
        .object({ code: z.string().regex(/^[A-Z]+$/) })
        .and(z.object({ code: z.string().regex(/^.{3}$/) })),
    );
    expect(json.allOf).toHaveLength(2);
    expect(JSON.stringify(json)).toContain('^[A-Z]+$');
    expect(JSON.stringify(json)).toContain('^.{3}$');
  });

  it('writes an empty enum as one, so the provider check can refuse it', () => {
    expect(zodToJsonSchemaObject(z.enum([] as never))).toEqual({ type: 'string', enum: [] });
  });

  it('has no $schema key, in both targets', () => {
    expect(zodToJsonSchemaObject(z.string()).$schema).toBeUndefined();
    expect(zodToJsonSchemaObject(z.string().nullable(), 'openapi-3.0')).toEqual({
      type: 'string',
      nullable: true,
    });
  });
});

describe('zod introspection', () => {
  it('names kinds as zod 3 did', () => {
    expect(zodTypeName(z.string())).toBe('ZodString');
    expect(zodTypeName(z.string().optional())).toBe('ZodOptional');
    expect(zodTypeName(z.bigint())).toBe('ZodBigInt');
    expect(zodTypeName(z.string().transform((v) => v))).toBe('ZodEffects');
    expect(zodTypeName(z.string().default('x'))).toBe('ZodDefault');
    expect(zodTypeName(z.discriminatedUnion('k', [z.object({ k: z.literal('a') })]))).toBe(
      'ZodDiscriminatedUnion',
    );
    expect(zodTypeName(z.nativeEnum({ A: 1 }))).toBe('ZodNativeEnum');
    expect(zodTypeName(z.enum(['a']))).toBe('ZodEnum');
    expect(zodTypeName('not a schema')).toBeUndefined();
  });

  it('unwraps wrappers and pipes, and reads shapes, enum values and defaults', () => {
    const inner = z.string();
    expect(zodInnerType(inner.optional())).toBe(inner);
    expect(zodInnerType(inner.transform((v) => v))).toBe(inner);
    const object = z.object({ a: z.string() });
    expect(Object.keys(zodObjectShape(object.transform((v) => v)) ?? {})).toEqual(['a']);
    expect(zodObjectShape(z.string())).toBeUndefined();
    expect(zodEnumValues(z.enum(['x', 'y']))).toEqual(['x', 'y']);
    expect(zodDefaultValue(z.number().default(3))).toEqual({ value: 3 });
    expect(zodDefaultValue(z.number())).toBeUndefined();
  });
});

describe('zodToJsonSchemaObject property order', () => {
  it('keeps the shape order of properties and required, also for names that are JSON Schema keywords', () => {
    const json = zodToJsonSchemaObject(
      z.object({
        title: z.string(),
        items: z.array(z.string()),
        type: z.string(),
        enum: z.string(),
      }),
    );
    expect(Object.keys(json.properties as object)).toEqual(['title', 'items', 'type', 'enum']);
    expect(json.required).toEqual(['title', 'items', 'type', 'enum']);
  });
});

describe('zodToJsonSchemaObject and .catch()', () => {
  it('describes .catch() as its inner schema, not required and without a default', () => {
    expect(zodToJsonSchemaObject(z.object({ a: z.boolean().catch(true), b: z.string() }))).toEqual({
      type: 'object',
      properties: { a: { type: 'boolean' }, b: { type: 'string' } },
      required: ['b'],
      additionalProperties: false,
    });
  });
});

describe('zodToJsonSchemaObject and z.null()', () => {
  it('writes null as { type: "null" }, and as the 3.0 sentinel for OpenAPI 3.0', () => {
    expect(zodToJsonSchemaObject(z.null())).toEqual({ type: 'null' });
    expect(zodToJsonSchemaObject(z.null(), 'openapi-3.0')).toEqual({
      enum: ['null'],
      nullable: true,
    });
  });
});

describe('zodToJsonSchemaObject and tuples', () => {
  it('writes tuple items positionally, with a rest element as additionalItems', () => {
    expect(zodToJsonSchemaObject(z.tuple([z.string(), z.number()]), 'openapi-3.0')).toEqual({
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: [{ type: 'string' }, { type: 'number' }],
    });
    expect(zodToJsonSchemaObject(z.tuple([z.string()]).rest(z.string()))).toEqual({
      type: 'array',
      minItems: 1,
      items: [{ type: 'string' }],
      additionalItems: { type: 'string' },
    });
  });
});
