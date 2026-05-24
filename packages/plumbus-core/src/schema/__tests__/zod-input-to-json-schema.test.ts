import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodInputToJsonSchema } from '../zod-input-to-json-schema.js';

describe('zodInputToJsonSchema', () => {
  it('converts a Zod object schema to JSON Schema', () => {
    const schema = z.object({ id: z.string(), count: z.number().optional() });
    const json = zodInputToJsonSchema(schema);
    expect(json.type).toBe('object');
    expect(json.properties).toBeDefined();
  });
});
