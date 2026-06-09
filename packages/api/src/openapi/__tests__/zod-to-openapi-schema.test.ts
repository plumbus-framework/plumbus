import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodToOpenApiSchema } from '../zod-to-openapi-schema.js';

describe('zodToOpenApiSchema', () => {
  it('handles many optional fields without Anthropic limits', () => {
    const fields: Record<string, z.ZodOptional<z.ZodString>> = {};
    for (let i = 0; i < 30; i++) {
      fields[`field${i}`] = z.string().optional();
    }
    const schema = z.object(fields);
    expect(() => zodToOpenApiSchema(schema)).not.toThrow();
    const json = zodToOpenApiSchema(schema);
    expect(json.type).toBe('object');
    expect(Object.keys((json.properties ?? {}) as object).length).toBe(30);
  });

  it('preserves string constraints', () => {
    const schema = z.object({
      code: z
        .string()
        .min(3)
        .max(10)
        .regex(/^[a-z]+$/),
      email: z.string().email(),
    });
    const json = zodToOpenApiSchema(schema);
    const props = json.properties as Record<string, Record<string, unknown>>;
    expect(props.code.minLength).toBe(3);
    expect(props.code.maxLength).toBe(10);
    expect(props.code.pattern).toBe('^[a-z]+$');
    expect(props.email.format).toBe('email');
  });

  it('preserves numeric constraints', () => {
    const schema = z.object({ limit: z.number().int().min(1).max(100) });
    const json = zodToOpenApiSchema(schema);
    const limit = (json.properties as Record<string, Record<string, unknown>>).limit;
    expect(limit.type).toBe('integer');
    expect(limit.minimum).toBe(1);
    expect(limit.maximum).toBe(100);
  });
});
