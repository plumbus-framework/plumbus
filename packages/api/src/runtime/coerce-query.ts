import type { z } from 'zod';

/** Unwrap ZodOptional / ZodDefault / ZodNullable to find the inner type name. */
function getExpectedType(field: z.ZodTypeAny | undefined): string | undefined {
  if (!field) return undefined;
  const typeName = (field as { _def?: { typeName?: string } })._def?.typeName;
  if (typeName === 'ZodNumber') return 'number';
  if (typeName === 'ZodBoolean') return 'boolean';
  if (typeName === 'ZodOptional' || typeName === 'ZodDefault' || typeName === 'ZodNullable') {
    const inner = (field as { _def: { innerType: z.ZodTypeAny } })._def.innerType;
    return getExpectedType(inner);
  }
  return typeName;
}

/** Extract the shape from a ZodObject, unwrapping ZodEffects if needed. */
function getSchemaShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> | undefined {
  const def = (
    schema as { _def?: { typeName?: string; shape?: () => Record<string, z.ZodTypeAny> } }
  )._def;
  if (!def) return undefined;
  if (def.typeName === 'ZodObject') {
    return typeof def.shape === 'function' ? def.shape() : undefined;
  }
  if (def.typeName === 'ZodEffects') {
    const inner = (schema as { _def: { schema: z.ZodTypeAny } })._def.schema;
    return getSchemaShape(inner);
  }
  return undefined;
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
