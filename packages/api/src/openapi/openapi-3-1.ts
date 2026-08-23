/**
 * Partner OpenAPI 3.1 conversion lives in `@plumbus/core` so `plumbus generate`
 * and `plumbus api generate openapi --openapi-version 3.1.0` rewrite nullability
 * the same way. This module re-exports that pass and keeps the `@plumbus/api`
 * `OpenApiDocument` type on the document helper.
 */

import {
  toJsonSchema2020 as convertToJsonSchema2020,
  toOpenApi31Document as convertToOpenApi31,
} from '@plumbus/core';
import type { OpenApiDocument } from './types.js';

export function toJsonSchema2020(schema: unknown): unknown {
  return convertToJsonSchema2020(schema);
}

export function toOpenApi31Document(doc: OpenApiDocument): OpenApiDocument {
  return convertToOpenApi31(doc);
}
