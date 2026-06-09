import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Convert a Zod schema to OpenAPI-compatible JSON Schema.
 * Uses unconstrained zod-to-json-schema (not Anthropic provider limits).
 * Zod object schemas strip unknown keys at runtime by default; we do not
 * force additionalProperties:false beyond what zod-to-json-schema emits.
 */
export function zodToOpenApiSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return zodToJsonSchema(schema, {
    $refStrategy: 'none',
    target: 'openApi3',
  }) as Record<string, unknown>;
}
