import type { z } from 'zod';
import { zodToJsonSchemaObject } from '@plumbus/core';

/**
 * Convert a Zod schema to OpenAPI-compatible JSON Schema.
 * Uses core's unconstrained converter (not Anthropic provider limits), which keeps
 * zod-to-json-schema's output shape: default (strip) objects carry
 * `additionalProperties: false`, as they always did.
 */
export function zodToOpenApiSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return zodToJsonSchemaObject(schema, 'openapi-3.0');
}
