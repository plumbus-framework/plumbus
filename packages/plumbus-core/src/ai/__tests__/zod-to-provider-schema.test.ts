import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProviderJsonSchemaError, zodToProviderJsonSchema } from '../zod-to-provider-schema.js';

describe('zodToProviderJsonSchema', () => {
  it('converts Zod objects into provider-safe JSON Schema', () => {
    const result = zodToProviderJsonSchema(
      z.object({
        title: z.string(),
        url: z.string().url(),
        count: z.number().min(1).max(10),
        tags: z.array(z.string()).min(2).max(5),
        optionalNote: z.string().optional(),
      }),
      { promptName: 'test.prompt' },
    );

    expect(result.schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['title', 'url', 'count', 'tags'],
    });
    expect(result.optionalParameterCount).toBe(1);
    expect(result.unionParameterCount).toBe(0);
    expect(result.schema.properties).toMatchObject({
      url: { type: 'string', format: 'uri' },
      count: {
        type: 'number',
        description: 'Must be at least 1. Must be at most 10.',
      },
      tags: {
        type: 'array',
        minItems: 1,
        description: 'Must contain at least 2 items. Must contain at most 5 items.',
      },
    });
  });

  it('rejects unsupported regex patterns before provider calls', () => {
    expect(() =>
      zodToProviderJsonSchema(z.object({ value: z.string().regex(/^(a)\1$/) })),
    ).not.toThrow();
    const converted = zodToProviderJsonSchema(z.object({ value: z.string().regex(/^(a)\1$/) }));
    expect(converted.schema.properties).toMatchObject({
      value: {
        type: 'string',
        description: 'Must match pattern: ^(a)\\1$.',
      },
    });
  });

  it('throws locally when Anthropic complexity limits are exceeded', () => {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (let index = 0; index < 25; index += 1) {
      shape[`field${index}`] = z.string().optional();
    }

    expect(() => zodToProviderJsonSchema(z.object(shape), { promptName: 'too.optional' })).toThrow(
      ProviderJsonSchemaError,
    );
    expect(() => zodToProviderJsonSchema(z.object(shape), { promptName: 'too.optional' })).toThrow(
      'too.optional',
    );
  });

  it('counts union parameters and rejects empty enums', () => {
    const result = zodToProviderJsonSchema(
      z.object({
        maybe: z.union([z.string(), z.number()]),
        nullable: z.string().nullable(),
      }),
    );
    expect(result.unionParameterCount).toBe(2);

    expect(() => zodToProviderJsonSchema(z.object({ none: z.enum([] as never) }))).toThrow(
      'empty enum',
    );
  });
});
