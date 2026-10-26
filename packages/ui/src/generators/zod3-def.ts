import { zodDefinition, zodTypeName } from '@plumbus/core';

/**
 * A zod 4 schema's definition in zod 3's shape, for the client and form-hint generators.
 *
 * Those generators were written against zod 3's `_def` (`typeName`, `innerType`, `shape()`,
 * `type` for an array's element, `values`, `value`, `effect`, checks with `kind` / `value`).
 * zod 4 stores the same facts differently (`_zod.def.type`, `element`, `entries`, `values`,
 * `pipe` with `in` / `out`, checks with `check` / `minimum` …). Translating once here keeps the
 * generators' rules, and so their output, unchanged.
 */

export type Zod3Def = Record<string, unknown> & { typeName: string };

type Check = Record<string, unknown>;

function checkDefs(def: Record<string, unknown>): Check[] {
  const checks = Array.isArray(def.checks) ? def.checks : [];
  return checks
    .map((check) => zodDefinition(check) as Check | undefined)
    .filter((check): check is Check => check !== undefined);
}

/** zod 4 checks as zod 3's `{ kind, value, inclusive, regex }`. */
function legacyChecks(def: Record<string, unknown>): Check[] {
  const own: Check[] = [];
  // A top-level format schema (`z.email()`) is itself the check.
  if ((def.type === 'string' || def.type === 'number') && typeof def.format === 'string')
    own.push(def);
  const out: Check[] = [];
  for (const check of [...own, ...checkDefs(def)]) {
    switch (check.check) {
      case 'min_length':
        out.push({ kind: 'min', value: check.minimum, inclusive: true });
        break;
      case 'max_length':
        out.push({ kind: 'max', value: check.maximum, inclusive: true });
        break;
      case 'length_equals':
        out.push({ kind: 'length', value: check.length });
        break;
      case 'greater_than':
        out.push({ kind: 'min', value: check.value, inclusive: check.inclusive === true });
        break;
      case 'less_than':
        out.push({ kind: 'max', value: check.value, inclusive: check.inclusive === true });
        break;
      case 'number_format':
        if (check.format === 'safeint' || check.format === 'int32' || check.format === 'uint32')
          out.push({ kind: 'int' });
        break;
      case 'string_format':
        if (check.format === 'regex' && check.pattern instanceof RegExp) {
          out.push({ kind: 'regex', regex: check.pattern });
        } else if (typeof check.format === 'string') {
          // `z.guid()` is what zod 3 called `.uuid()`.
          out.push({ kind: check.format === 'guid' ? 'uuid' : check.format });
        }
        break;
      default:
        break;
    }
  }
  return out;
}

function isTransform(schema: unknown): boolean {
  return zodDefinition(schema)?.type === 'transform';
}

export function zod3Def(schema: unknown): Zod3Def | null {
  const def = zodDefinition(schema);
  const typeName = zodTypeName(schema);
  if (!def || typeName === undefined) return null;
  const description = (schema as { description?: unknown }).description;
  const base: Zod3Def = {
    typeName,
    ...(typeof description === 'string' ? { description } : {}),
    checks: legacyChecks(def),
  };
  switch (def.type) {
    case 'object':
      return { ...base, shape: () => def.shape as Record<string, unknown>, catchall: def.catchall };
    case 'array':
      return { ...base, type: def.element };
    case 'enum':
      return { ...base, values: Object.values(def.entries as Record<string, unknown>) };
    case 'literal':
      return { ...base, value: Array.isArray(def.values) ? def.values[0] : undefined };
    case 'record':
      return { ...base, keyType: def.keyType, valueType: def.valueType };
    case 'union':
      return { ...base, options: def.options };
    case 'default':
    case 'prefault': {
      const value = def.defaultValue;
      return { ...base, innerType: def.innerType, defaultValue: () => value };
    }
    case 'pipe':
      // `.transform(fn)` is `pipe(schema, transform)`; `z.preprocess(fn, schema)` is
      // `pipe(transform, schema)`; zod 3 named both ZodEffects, other pipes ZodPipeline.
      if (isTransform(def.out)) return { ...base, schema: def.in, effect: { type: 'transform' } };
      if (isTransform(def.in)) return { ...base, schema: def.out, effect: { type: 'preprocess' } };
      return { ...base, typeName: 'ZodPipeline', in: def.in, out: def.out };
    default:
      return 'innerType' in def ? { ...base, innerType: def.innerType } : base;
  }
}
