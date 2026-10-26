import { zodInnerType, zodObjectShape, zodTypeName } from '@plumbus/core';
import type { z } from 'zod';

/** Unwrap ZodOptional / ZodDefault / ZodNullable to find the inner type name. */
function getExpectedType(field: unknown): string | undefined {
  if (!field) return undefined;
  const typeName = zodTypeName(field);
  if (typeName === 'ZodNumber') return 'number';
  if (typeName === 'ZodBoolean') return 'boolean';
  if (typeName === 'ZodOptional' || typeName === 'ZodDefault' || typeName === 'ZodNullable') {
    return getExpectedType(zodInnerType(field));
  }
  return typeName;
}

/** Extract the shape from a ZodObject, looking through transforms and pipes. */
function getSchemaShape(schema: unknown): Record<string, unknown> | undefined {
  return zodObjectShape(schema);
}

/**
 * Coerce query-string values (always strings) to the types expected by the Zod schema.
 * Mirrors core route-generator behavior for partner GET routes.
 */
export function coerceQueryParams(query: unknown, schema: z.ZodTypeAny): Record<string, unknown> {
  const raw = (query ?? {}) as Record<string, unknown>;
  const shape = getSchemaShape(schema);
  if (!shape) return raw;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      result[key] = value;
      continue;
    }
    const expectedType = getExpectedType(shape[key]);
    if (expectedType === 'number') {
      const n = Number(value);
      result[key] = Number.isNaN(n) ? value : n;
    } else if (expectedType === 'boolean') {
      result[key] = value === 'true' ? true : value === 'false' ? false : value;
    } else {
      result[key] = value;
    }
  }
  return result;
}
