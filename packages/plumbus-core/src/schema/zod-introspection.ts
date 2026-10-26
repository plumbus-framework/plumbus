/**
 * Reading a zod 4 schema's structure, for the generators and request handling that need it
 * (query coercion, path parameters, form hints, client types).
 *
 * zod 4 keeps a schema's definition at `schema._zod.def` with a lower-case `type` (`'object'`,
 * `'optional'`, `'pipe'` …); zod 3's `_def.typeName` (`'ZodObject'` …) is gone. Code that still
 * compared `typeName` would silently match nothing, so every reader goes through here.
 *
 * {@link zodTypeName} answers in zod 3's names (`'ZodString'`, `'ZodOptional'` …) because
 * generated artifacts carry them (form hints' `zodType`): a transform or pipe answers
 * `'ZodEffects'`, as zod 3's wrapper did, a discriminated union `'ZodDiscriminatedUnion'` and an
 * enum built from a TypeScript enum `'ZodNativeEnum'`.
 */

export type ZodDefinition = { readonly type?: string } & Record<string, unknown>;

/** The schema's zod 4 definition, or `undefined` for anything that is not a zod 4 schema. */
export function zodDefinition(schema: unknown): ZodDefinition | undefined {
  return (schema as { _zod?: { def?: ZodDefinition } } | null | undefined)?._zod?.def;
}

const LEGACY_NAMES: Readonly<Record<string, string>> = {
  bigint: 'ZodBigInt',
  pipe: 'ZodEffects',
  transform: 'ZodEffects',
  prefault: 'ZodDefault',
  template_literal: 'ZodTemplateLiteral',
  nonoptional: 'ZodNonOptional',
  nan: 'ZodNaN',
};

/** The schema's kind in zod 3's naming (`'ZodString'`, `'ZodObject'`, `'ZodEffects'` …). */
export function zodTypeName(schema: unknown): string | undefined {
  const def = zodDefinition(schema);
  const type = def?.type;
  if (def === undefined || type === undefined) return undefined;
  // zod 4 folds these into `union` and `enum`; zod 3 named them apart.
  if (type === 'union' && typeof def.discriminator === 'string') return 'ZodDiscriminatedUnion';
  if (type === 'enum' && isNativeEnum(def)) return 'ZodNativeEnum';
  return LEGACY_NAMES[type] ?? `Zod${type.charAt(0).toUpperCase()}${type.slice(1)}`;
}

/** `z.enum(['a', 'b'])` has entries `{ a: 'a', b: 'b' }`; a native enum maps names to other values. */
function isNativeEnum(def: ZodDefinition): boolean {
  const entries = def.entries;
  if (typeof entries !== 'object' || entries === null) return false;
  return Object.entries(entries as Record<string, unknown>).some(([key, value]) => key !== value);
}

/**
 * The schema one wrapper in: the inner type of `optional`, `nullable`, `default`, `catch`,
 * `readonly` …, the input side of a `pipe` (where `.transform()` puts the original schema).
 */
export function zodInnerType(schema: unknown): unknown {
  const def = zodDefinition(schema);
  if (!def) return undefined;
  if (def.type === 'pipe') return def.in;
  return def.innerType;
}

/** An object schema's shape, looking through transforms and pipes; `undefined` for others. */
export function zodObjectShape(schema: unknown): Record<string, unknown> | undefined {
  let current = schema;
  for (let depth = 0; depth < 8; depth += 1) {
    const def = zodDefinition(current);
    if (!def) return undefined;
    if (def.type === 'object') return def.shape as Record<string, unknown>;
    if (def.type !== 'pipe') return undefined;
    current = def.in;
  }
  return undefined;
}

/** An enum's values, in declaration order (native enums included). */
export function zodEnumValues(schema: unknown): (string | number)[] | undefined {
  const def = zodDefinition(schema);
  if (def?.type !== 'enum' || typeof def.entries !== 'object' || def.entries === null)
    return undefined;
  return Object.values(def.entries as Record<string, string | number>);
}

/** A `.default()` schema's default value (evaluated when it is a function). */
export function zodDefaultValue(schema: unknown): { readonly value: unknown } | undefined {
  const def = zodDefinition(schema);
  if (def?.type !== 'default' && def?.type !== 'prefault') return undefined;
  const value = def.defaultValue;
  return { value: typeof value === 'function' ? (value as () => unknown)() : value };
}
