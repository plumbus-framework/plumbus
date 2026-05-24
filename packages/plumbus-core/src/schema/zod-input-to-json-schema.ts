import type { z } from 'zod';
import { zodToProviderJsonSchema } from '../ai/zod-to-provider-schema.js';

/** Convert a Zod input schema to JSON Schema for MCP tool manifests. */
export function zodInputToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return zodToProviderJsonSchema(schema).schema;
}
