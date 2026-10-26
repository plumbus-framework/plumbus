import { z } from 'zod';

/**
 * Zod schemas as JSON Schema, for every place Plumbus turns one into the other: OpenAPI, provider
 * structured output and tool parameters, flow descriptions, the partner API.
 *
 * Built on zod 4's `z.toJSONSchema()`, shaped to keep what `zod-to-json-schema` (zod 3) produced,
 * so contracts and the schemas sent to models do not change with the zod upgrade:
 *
 * - the input side of transforms and pipes (`io: 'input'`), as `effectStrategy: 'input'` did;
 * - `additionalProperties: false` on default (strip) objects, `true` on passthrough ones;
 * - no implicit `±Number.MAX_SAFE_INTEGER` bounds on integers; a standard `format` without zod 4's
 *   extra regex `pattern` (a `.regex()` the schema itself declares stays), and a zod-only format
 *   (`cidrv4`, `cuid` …) as its `pattern` alone;
 * - `z.date()` as a `date-time` string, `z.bigint()` as an `int64` integer;
 * - `z.unknown()`, `z.any()` and `.catch()` properties not required (they accept a missing key),
 *   and no `default` for a `.catch()` value;
 * - discriminated unions as `anyOf`, unions of literals as one `enum` (draft-07), and records
 *   without `propertyNames`;
 * - no `$schema` key, the old key order, and `required` in the order of `properties`.
 */

export type JsonSchemaObject = Record<string, unknown>;
export type JsonSchemaTarget = 'draft-07' | 'openapi-3.0';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

type Def = {
  type?: string;
  checks?: unknown[];
  catchall?: unknown;
  shape?: Record<string, unknown>;
} & Record<string, unknown>;

function defOf(schema: unknown): Def | undefined {
  return (schema as { _zod?: { def?: Def } } | undefined)?._zod?.def;
}

function isRecord(value: unknown): value is JsonSchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A property zod accepts when the key is missing: `unknown`, `any`, and `.catch()` (it catches it). */
function acceptsMissing(schema: unknown): boolean {
  const type = defOf(schema)?.type;
  return type === 'unknown' || type === 'any' || type === 'catch';
}

function hasUserPattern(def: Def): boolean {
  return (def.checks ?? []).some((check) => {
    const checkDef = defOf(check) as { check?: string; format?: string } | undefined;
    return checkDef?.check === 'string_format' && checkDef.format === 'regex';
  });
}

/**
 * The `format` values JSON Schema defines (draft-07 and 2019-09 `duration`). A string with one of
 * these keeps its `format` and loses zod 4's extra `pattern`, as zod-to-json-schema wrote it; a
 * zod-only format (`cidrv4`, `cuid`, `base64` …) means nothing to a validator or a provider, so
 * it keeps the `pattern` and loses the `format`.
 */
const STANDARD_FORMATS = new Set([
  'date-time',
  'date',
  'time',
  'duration',
  'email',
  'idn-email',
  'hostname',
  'idn-hostname',
  'ipv4',
  'ipv6',
  'uri',
  'uri-reference',
  'iri',
  'iri-reference',
  'uuid',
  'uri-template',
  'json-pointer',
  'relative-json-pointer',
  'regex',
]);

/** zod's own format names, where JSON Schema names the same thing differently or at all. */
const ZOD_TO_JSON_FORMAT: Readonly<Record<string, string>> = {
  datetime: 'date-time',
  date: 'date',
  time: 'time',
  duration: 'duration',
  url: 'uri',
  email: 'email',
  uuid: 'uuid',
  guid: 'uuid',
  ipv4: 'ipv4',
  ipv6: 'ipv6',
};

/** The zod format a string schema carries: its own (`z.email()`) or a check's (`z.string().email()`). */
function zodStringFormat(def: Def): string | undefined {
  if (typeof def.format === 'string' && def.format !== 'regex') return def.format;
  for (const check of def.checks ?? []) {
    const checkDef = defOf(check) as { check?: string; format?: string } | undefined;
    if (checkDef?.check === 'string_format' && checkDef.format && checkDef.format !== 'regex')
      return checkDef.format;
  }
  return undefined;
}

/** The regex sources zod 4 emits for the built-in formats a string carries (not its `.regex()`s). */
function formatPatternSources(def: Def): Set<string> {
  const sources = new Set<string>();
  const add = (pattern: unknown) => {
    if (pattern instanceof RegExp) sources.add(pattern.source);
  };
  if (typeof def.format === 'string' && def.format !== 'regex') add(def.pattern);
  for (const check of def.checks ?? []) {
    const checkDef = defOf(check) as
      | { check?: string; format?: string; pattern?: unknown }
      | undefined;
    if (checkDef?.check === 'string_format' && checkDef.format !== 'regex') add(checkDef.pattern);
  }
  return sources;
}

/**
 * A string with a standard format and its own `.regex()`: zod 4 lists the format's pattern and the
 * regex in `allOf`; zod-to-json-schema wrote the format and the regex as `pattern`.
 */
function dropFormatPatternsFromAllOf(json: JsonSchemaObject, def: Def): void {
  if (!Array.isArray(json.allOf)) return;
  const formatSources = formatPatternSources(def);
  const kept = json.allOf.filter(
    (member) =>
      !(
        isRecord(member) &&
        typeof member.pattern === 'string' &&
        formatSources.has(member.pattern)
      ),
  );
  if (kept.length === json.allOf.length) return;
  const onlyPattern = (member: unknown) =>
    isRecord(member) &&
    typeof member.pattern === 'string' &&
    Object.keys(member).every((k) => k === 'pattern' || k === 'type');
  if (kept.length === 0) {
    delete json.allOf;
  } else if (kept.length === 1 && onlyPattern(kept[0])) {
    json.pattern = (kept[0] as JsonSchemaObject).pattern;
    delete json.allOf;
  } else {
    json.allOf = kept;
  }
}

/**
 * A string schema's keywords in the order its checks were declared (`.min(1).max(320).email()`
 * gives `minLength, maxLength, format`), as zod-to-json-schema wrote them; zod 4 uses a fixed order.
 */
function orderStringKeywords(json: JsonSchemaObject, def: Def): void {
  const order: string[] = [];
  const add = (...keys: string[]) => {
    for (const key of keys) if (!order.includes(key)) order.push(key);
  };
  if (typeof def.format === 'string') add(def.format === 'regex' ? 'pattern' : 'format');
  for (const check of def.checks ?? []) {
    const checkDef = defOf(check) as { check?: string; format?: string } | undefined;
    switch (checkDef?.check) {
      case 'min_length':
        add('minLength');
        break;
      case 'max_length':
        add('maxLength');
        break;
      case 'length_equals':
        add('minLength', 'maxLength');
        break;
      case 'string_format':
        add(
          checkDef.format === 'regex' ||
            checkDef.format === 'starts_with' ||
            checkDef.format === 'ends_with' ||
            checkDef.format === 'includes'
            ? 'pattern'
            : 'format',
        );
        break;
      default:
        break;
    }
  }
  if (order.length < 2) return;
  const entries = Object.entries(json);
  const head = entries.filter(([key]) => key === 'type');
  const ranked = order.filter((key) => key in json).map((key) => [key, json[key]] as const);
  const rest = entries.filter(([key]) => key !== 'type' && !order.includes(key));
  replaceWith(json, Object.fromEntries([...head, ...ranked, ...rest]));
}

function shapeFormat(json: JsonSchemaObject, def: Def): void {
  const zodFormat = zodStringFormat(def);
  const mapped = zodFormat === undefined ? undefined : ZOD_TO_JSON_FORMAT[zodFormat];
  if (mapped !== undefined) {
    json.format = mapped;
    dropFormatPatternsFromAllOf(json, def);
  }
  if (typeof json.format !== 'string') return;
  if (STANDARD_FORMATS.has(json.format)) {
    if (json.pattern !== undefined && !hasUserPattern(def)) delete json.pattern;
  } else if (json.pattern !== undefined) {
    delete json.format;
  }
}

function replaceWith(json: JsonSchemaObject, value: JsonSchemaObject): void {
  for (const key of Object.keys(json)) delete json[key];
  Object.assign(json, value);
}

function override(
  target: JsonSchemaTarget,
  ctx: { zodSchema: unknown; jsonSchema: JsonSchemaObject },
): void {
  const def = defOf(ctx.zodSchema);
  const json = ctx.jsonSchema;
  if (!def) return;
  switch (def.type) {
    case 'object': {
      const catchall = defOf(def.catchall)?.type;
      if (catchall === undefined) {
        if (json.additionalProperties === undefined) json.additionalProperties = false;
      } else if (catchall === 'unknown' || catchall === 'any') {
        json.additionalProperties = true;
      }
      if (Array.isArray(json.required) && def.shape) {
        const shape = def.shape;
        const required = (json.required as string[]).filter((key) => !acceptsMissing(shape[key]));
        if (required.length > 0) json.required = required;
        else delete json.required;
      }
      return;
    }
    case 'number': {
      if (json.minimum === -MAX_SAFE) delete json.minimum;
      if (json.maximum === MAX_SAFE) delete json.maximum;
      return;
    }
    case 'intersection': {
      // zod 4 flattens an intersection of objects into one, and keeps only one of two
      // constraints a property gets from both sides; `allOf` keeps both, as zod 3 did.
      replaceWith(json, {
        allOf: [
          zodToJsonSchemaObject(def.left as z.core.$ZodType, target),
          zodToJsonSchemaObject(def.right as z.core.$ZodType, target),
        ],
      });
      return;
    }
    case 'null': {
      // OpenAPI 3.0 has no null type: zod-to-json-schema wrote the 3.0 sentinel there (which the
      // 3.1 conversion turns into `{ type: 'null' }`) and `{ type: 'null' }` in draft-07; zod 4
      // writes a nullable string limited to null.
      replaceWith(
        json,
        target === 'openapi-3.0' ? { enum: ['null'], nullable: true } : { type: 'null' },
      );
      return;
    }
    case 'tuple': {
      // zod-to-json-schema wrote a tuple's items positionally in both targets (and the rest as
      // `additionalItems`), which the OpenAPI 3.1 conversion turns into `prefixItems`; zod 4's
      // OpenAPI 3.0 output merges them into one `items: { anyOf }` and loses the positions.
      const items = ((def.items as unknown[]) ?? []).map((item) =>
        zodToJsonSchemaObject(item as z.core.$ZodType, target),
      );
      const rest = def.rest as z.core.$ZodType | null | undefined;
      replaceWith(json, {
        type: 'array',
        minItems: items.length,
        ...(rest ? {} : { maxItems: items.length }),
        items,
        ...(rest ? { additionalItems: zodToJsonSchemaObject(rest, target) } : {}),
      });
      return;
    }
    case 'catch': {
      // zod-to-json-schema described `.catch()` as its inner schema; zod 4 adds the catch value
      // as a `default`, which is not a default (it replaces invalid input too).
      delete json.default;
      return;
    }
    case 'enum': {
      if (Object.keys((def.entries as Record<string, unknown> | undefined) ?? {}).length === 0) {
        replaceWith(json, { type: 'string', enum: [] });
      }
      return;
    }
    default:
      // ZodString with format checks, and the top-level format schemas (`z.email()` …).
      shapeFormat(json, def);
      if (json.type === 'string') orderStringKeywords(json, def);
  }
}

function unrepresentable(ctx: { zodSchema: unknown }): JsonSchemaObject | 'any' {
  const type = defOf(ctx.zodSchema)?.type;
  if (type === 'date') return { type: 'string', format: 'date-time' };
  if (type === 'bigint') return { type: 'integer', format: 'int64' };
  return 'any';
}

const KEY_ORDER = [
  'anyOf',
  'allOf',
  'type',
  'format',
  'const',
  'enum',
  'properties',
  'items',
  'required',
  'additionalProperties',
  'minLength',
  'maxLength',
  'minimum',
  'exclusiveMinimum',
  'maximum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
  'pattern',
  'default',
  'description',
  'nullable',
];

function ordered(node: JsonSchemaObject): JsonSchemaObject {
  // A positional tuple keeps zod-to-json-schema's order: type, minItems, maxItems, items, rest.
  if (Array.isArray(node.items)) {
    const out: JsonSchemaObject = {};
    for (const key of ['type', 'minItems', 'maxItems', 'items', 'additionalItems'])
      if (key in node) out[key] = node[key];
    for (const key of Object.keys(node)) if (!(key in out)) out[key] = node[key];
    return out;
  }
  // String keywords keep the declaration order `orderStringKeywords` gave them; only `type`
  // leads and the annotations trail, as everywhere else.
  if (node.type === 'string') {
    const tail = ['default', 'description', 'nullable'];
    const out: JsonSchemaObject = {};
    if ('type' in node) out.type = node.type;
    for (const key of Object.keys(node))
      if (key !== 'type' && !tail.includes(key)) out[key] = node[key];
    for (const key of tail) if (key in node) out[key] = node[key];
    return out;
  }
  const out: JsonSchemaObject = {};
  for (const key of KEY_ORDER) if (key in node) out[key] = node[key];
  for (const key of Object.keys(node)) if (!(key in out)) out[key] = node[key];
  return out;
}

const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

/** `anyOf` of scalar `const`s, as zod-to-json-schema wrote a union of literals: one `enum`. */
function literalUnion(branches: unknown[]): JsonSchemaObject | undefined {
  const values: unknown[] = [];
  const types: string[] = [];
  for (const branch of branches) {
    if (
      !isRecord(branch) ||
      !('const' in branch) ||
      Object.keys(branch).some((k) => k !== 'const' && k !== 'type')
    )
      return undefined;
    if (typeof branch.type !== 'string' || !SCALAR_TYPES.has(branch.type)) return undefined;
    values.push(branch.const);
    if (!types.includes(branch.type)) types.push(branch.type);
  }
  return { type: types.length === 1 ? types[0] : types, enum: values };
}

/** Keywords whose value maps names (property names, definition names) to schemas. */
const NAME_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);

/** A map of names to schemas: each schema normalized, the names kept in their order. */
function normalizeNameMap(node: unknown, target: JsonSchemaTarget): unknown {
  if (!isRecord(node)) return normalize(node, target);
  const out: JsonSchemaObject = {};
  for (const [name, schema] of Object.entries(node)) out[name] = normalize(schema, target);
  return out;
}

function normalize(node: unknown, target: JsonSchemaTarget): unknown {
  if (Array.isArray(node)) return node.map((item) => normalize(item, target));
  if (!isRecord(node)) return node;
  let out: JsonSchemaObject = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = NAME_MAPS.has(key) ? normalizeNameMap(value, target) : normalize(value, target);
  }
  delete out.$schema;
  // zod-to-json-schema listed `required` in the order of `properties`; zod 4 does not always.
  if (Array.isArray(out.required) && isRecord(out.properties)) {
    const required = new Set(out.required as string[]);
    out.required = [
      ...Object.keys(out.properties).filter((key) => required.has(key)),
      ...(out.required as string[]).filter(
        (key) => !Object.hasOwn(out.properties as JsonSchemaObject, key),
      ),
    ];
  }
  if (Array.isArray(out.oneOf)) {
    out.anyOf = out.oneOf;
    delete out.oneOf;
  }
  if (target === 'draft-07') {
    if (
      isRecord(out.propertyNames) &&
      out.propertyNames.type === 'string' &&
      Object.keys(out.propertyNames).length === 1
    ) {
      delete out.propertyNames;
    }
    if (Array.isArray(out.anyOf) && Object.keys(out).length === 1) {
      const merged = literalUnion(out.anyOf);
      if (merged) out = merged;
    }
  }
  return ordered(out);
}

/** A Zod schema as JSON Schema (draft-07 or OpenAPI 3.0), shaped as described above. */
export function zodToJsonSchemaObject(
  schema: z.core.$ZodType,
  target: JsonSchemaTarget = 'draft-07',
): JsonSchemaObject {
  const raw = z.toJSONSchema(schema, {
    target,
    io: 'input',
    reused: 'inline',
    cycles: 'ref',
    unrepresentable: unrepresentable as never,
    override: ((ctx: { zodSchema: unknown; jsonSchema: JsonSchemaObject }) =>
      override(target, ctx)) as never,
  });
  return normalize(raw, target) as JsonSchemaObject;
}
