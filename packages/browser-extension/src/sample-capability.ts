import { type CapabilityContract, zodInnerType, zodObjectShape, zodTypeName } from '@plumbus/core';

/** One wrapper in: optional, default, nullable, catch, readonly, and the input side of a pipe. */
function unwrapWrappers(schema: unknown): unknown {
  const tn = zodTypeName(schema);
  if (
    tn === 'ZodOptional' ||
    tn === 'ZodDefault' ||
    tn === 'ZodNullable' ||
    tn === 'ZodEffects' ||
    tn === 'ZodCatch' ||
    tn === 'ZodReadonly'
  ) {
    const inner = zodInnerType(schema);
    if (inner) return unwrapWrappers(inner);
  }
  return schema;
}

function isFieldOptional(schema: unknown): boolean {
  const tn = zodTypeName(schema);
  if (tn === 'ZodOptional' || tn === 'ZodDefault') return true;
  if (tn === 'ZodNullable') return isFieldOptional(zodInnerType(schema));
  return false;
}

function listObjectFields(schema: unknown): Array<{ key: string; optional: boolean }> {
  const inner = unwrapWrappers(schema);
  if (zodTypeName(inner) !== 'ZodObject') return [];
  const shape = zodObjectShape(inner) ?? {};
  return Object.entries(shape).map(([key, fieldSchema]) => ({
    key,
    optional: isFieldOptional(fieldSchema),
  }));
}

/** True only for a plain Zod object with no required fields (not transforms, not non-objects). */
export function isZeroInputCapabilityInput(schema: unknown): boolean {
  const inner = unwrapWrappers(schema);
  if (zodTypeName(inner) !== 'ZodObject') {
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
