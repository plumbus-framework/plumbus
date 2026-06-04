import type { CapabilityContract } from '@plumbus/core';

function getZodDef(schema: unknown): Record<string, unknown> | null {
  if (schema && typeof schema === 'object' && '_def' in schema) {
    return (schema as Record<string, unknown>)._def as Record<string, unknown>;
  }
  return null;
}

function unwrapWrappers(schema: unknown): unknown {
  const def = getZodDef(schema);
  if (!def) return schema;
  const tn = typeof def.typeName === 'string' ? def.typeName : '';
  if (tn === 'ZodOptional' || tn === 'ZodDefault' || tn === 'ZodNullable') {
    return unwrapWrappers(def.innerType);
  }
  if (tn === 'ZodEffects' || tn === 'ZodPipeline' || tn === 'ZodBranded' || tn === 'ZodCatch') {
    const inner = def.schema ?? def.innerType ?? def.out;
    if (inner) return unwrapWrappers(inner);
  }
  return schema;
}

function isFieldOptional(schema: unknown): boolean {
  const def = getZodDef(schema);
  if (!def) return false;
  const tn = typeof def.typeName === 'string' ? def.typeName : '';
  if (tn === 'ZodOptional' || tn === 'ZodDefault') return true;
  if (tn === 'ZodNullable' && def.innerType) return isFieldOptional(def.innerType);
  return false;
}

function listObjectFields(schema: unknown): Array<{ key: string; optional: boolean }> {
  const def = getZodDef(unwrapWrappers(schema));
  if (!def || def.typeName !== 'ZodObject' || typeof def.shape !== 'function') {
    return [];
  }
  const shape = (def.shape as () => Record<string, unknown>)();
  return Object.entries(shape).map(([key, fieldSchema]) => ({
    key,
    optional: isFieldOptional(fieldSchema),
  }));
}

/** True only for a plain Zod object with no required fields (not transforms, not non-objects). */
export function isZeroInputCapabilityInput(schema: unknown): boolean {
  const inner = unwrapWrappers(schema);
  const def = getZodDef(inner);
  if (!def || def.typeName !== 'ZodObject') {
    return false;
  }
  const fields = listObjectFields(inner);
  return fields.every((f) => f.optional);
}

export type SampleCapabilityMode = 'zero-input' | 'none';

export interface SampleCapabilitySelection {
  mode: SampleCapabilityMode;
  capability?: CapabilityContract;
}

/** Pick first query capability suitable for a working popup sample (stable name order). */
export function selectSampleCapability(
  capabilities: CapabilityContract[],
): SampleCapabilitySelection {
  const queries = capabilities
    .filter((c) => c.kind === 'query')
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const cap of queries) {
    if (isZeroInputCapabilityInput(cap.input)) {
      return { mode: 'zero-input', capability: cap };
    }
  }

  return { mode: 'none' };
}
