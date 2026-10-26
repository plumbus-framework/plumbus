import { z } from 'zod';

/**
 * Validation that bounds collections before zod walks them (GHSA-mrhx-c7xc-m3w5).
 *
 * zod 3 checks an array's `.max()` / `.length()` first, but only marks the result failed and then
 * parses every element anyway, building one issue per bad element: a 4 MB JSON array of two
 * million junk values costs ~530 MB and ~1.8 s before the `too_big` issue is reported. zod 4.6.6
 * fixed the bounded case only; an array with no limit is walked in full in every version.
 *
 * {@link safeParseBounded} runs one allocation-free pass over the value first, guided by the
 * schema, and refuses before zod sees the elements when:
 *
 * - an array is longer than its schema's `.max()` or `.length()`;
 * - an array the schema puts no limit on, or that sits where the schema cannot be followed (a
 *   union, `z.any()`, a lazy schema), is longer than {@link resolveInputArrayMaxItems}
 *   (`PLUMBUS_INPUT_ARRAY_MAX_ITEMS`, default 10 000). A declared `.max()` always wins over it.
 *
 * The refusal is an ordinary `ZodError` with one `too_big` issue at the array's path, so every
 * caller answers it the way it answers any other invalid input.
 */

export const DEFAULT_INPUT_ARRAY_MAX_ITEMS = 10_000;
const MAX_DEPTH = 64;

/** The limit for arrays a schema does not bound: `PLUMBUS_INPUT_ARRAY_MAX_ITEMS`, else 10 000. */
export function resolveInputArrayMaxItems(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PLUMBUS_INPUT_ARRAY_MAX_ITEMS?.trim();
  if (!raw) return DEFAULT_INPUT_ARRAY_MAX_ITEMS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`PLUMBUS_INPUT_ARRAY_MAX_ITEMS must be a positive integer, got "${raw}"`);
  }
  return value;
}

export interface CollectionBoundViolation {
  readonly path: (string | number)[];
  readonly maximum: number;
  readonly exact: boolean;
}

type Def = { typeName?: string } & Record<string, unknown>;

function defOf(schema: unknown): Def | undefined {
  return (schema as { _def?: Def } | null | undefined)?._def;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every array in `value` against the default limit, with no schema to follow. */
function walkUnguided(
  value: unknown,
  path: (string | number)[],
  limit: number,
  depth: number,
): CollectionBoundViolation | undefined {
  if (depth > MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    if (value.length > limit) return { path, maximum: limit, exact: false };
    for (let i = 0; i < value.length; i++) {
      const found = walkUnguided(value[i], [...path, i], limit, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      const found = walkUnguided(value[key], [...path, key], limit, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * The first array in `value` that is over its bound, following `schema` where it can and
 * falling back to the default limit where it cannot. Never throws and never allocates per
 * element.
 */
export function findCollectionBoundViolation(
  schema: unknown,
  value: unknown,
  limit: number = resolveInputArrayMaxItems(),
  path: (string | number)[] = [],
  depth = 0,
): CollectionBoundViolation | undefined {
  if (depth > MAX_DEPTH) return undefined;
  const def = defOf(schema);
  switch (def?.typeName) {
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
    case 'ZodCatch':
    case 'ZodReadonly':
      return findCollectionBoundViolation(def.innerType, value, limit, path, depth + 1);
    case 'ZodBranded':
      return findCollectionBoundViolation(def.type, value, limit, path, depth + 1);
    case 'ZodEffects':
      return findCollectionBoundViolation(def.schema, value, limit, path, depth + 1);
    case 'ZodPipeline':
      return findCollectionBoundViolation(def.in, value, limit, path, depth + 1);
    case 'ZodArray': {
      if (!Array.isArray(value)) return undefined;
      const exact = (def.exactLength as { value: number } | null)?.value;
      const max = (def.maxLength as { value: number } | null)?.value;
      if (exact !== undefined && value.length > exact) return { path, maximum: exact, exact: true };
      if (max !== undefined && value.length > max) return { path, maximum: max, exact: false };
      if (exact === undefined && max === undefined && value.length > limit) {
        return { path, maximum: limit, exact: false };
      }
      for (let i = 0; i < value.length; i++) {
        const found = findCollectionBoundViolation(
          def.type,
          value[i],
          limit,
          [...path, i],
          depth + 1,
        );
        if (found) return found;
      }
      return undefined;
    }
    case 'ZodObject': {
      if (!isPlainObject(value)) return undefined;
      const shape =
        typeof def.shape === 'function' ? (def.shape as () => Record<string, unknown>)() : {};
      for (const key of Object.keys(value)) {
        const child = shape[key] ?? def.catchall;
        const found =
          child === undefined || defOf(child)?.typeName === 'ZodNever'
            ? walkUnguided(value[key], [...path, key], limit, depth + 1)
            : findCollectionBoundViolation(child, value[key], limit, [...path, key], depth + 1);
        if (found) return found;
      }
      return undefined;
    }
    case 'ZodRecord': {
      if (!isPlainObject(value)) return undefined;
      for (const key of Object.keys(value)) {
        const found = findCollectionBoundViolation(
          def.valueType,
          value[key],
          limit,
          [...path, key],
          depth + 1,
        );
        if (found) return found;
      }
      return undefined;
    }
    case 'ZodTuple': {
      if (!Array.isArray(value)) return undefined;
      const items = (def.items as unknown[]) ?? [];
      if (def.rest === null && value.length > items.length) {
        // zod reports a too_big here itself, but walks nothing past the tuple: bounded.
        return undefined;
      }
      if (value.length > items.length + limit)
        return { path, maximum: items.length + limit, exact: false };
      for (let i = 0; i < value.length; i++) {
        const child = i < items.length ? items[i] : def.rest;
        const found = findCollectionBoundViolation(child, value[i], limit, [...path, i], depth + 1);
        if (found) return found;
      }
      return undefined;
    }
    case 'ZodIntersection':
      return (
        findCollectionBoundViolation(def.left, value, limit, path, depth + 1) ??
        findCollectionBoundViolation(def.right, value, limit, path, depth + 1)
      );
    case 'ZodString':
    case 'ZodNumber':
    case 'ZodBigInt':
    case 'ZodBoolean':
    case 'ZodDate':
    case 'ZodLiteral':
    case 'ZodEnum':
    case 'ZodNativeEnum':
    case 'ZodNull':
    case 'ZodUndefined':
      return undefined;
    default:
      // Unions, `any`, `unknown`, lazy schemas, sets, maps: the schema cannot be followed here,
      // so every array inside gets the default limit.
      return walkUnguided(value, path, limit, depth);
  }
}

/** `schema.safeParse(value)`, refusing an over-long array first (see the module comment). */
export function safeParseBounded<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
  limit?: number,
): z.SafeParseReturnType<z.input<S>, z.output<S>> {
  const violation = findCollectionBoundViolation(
    schema,
    value,
    limit ?? resolveInputArrayMaxItems(),
  );
  if (violation) {
    return {
      success: false,
      error: new z.ZodError([
        {
          code: z.ZodIssueCode.too_big,
          maximum: violation.maximum,
          type: 'array',
          inclusive: true,
          exact: violation.exact,
          path: violation.path,
          message: violation.exact
            ? `Array must contain exactly ${violation.maximum} element(s)`
            : `Array must contain at most ${violation.maximum} element(s)`,
        },
      ]),
    };
  }
  return schema.safeParse(value);
}
