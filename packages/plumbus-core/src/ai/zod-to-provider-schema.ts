// ── Provider-neutral structured-output schema ──
// `zodToProviderJsonSchema` turns a Zod schema into the JSON Schema subset Anthropic and Bedrock
// document for structured outputs (Anthropic "JSON Schema limitations", Bedrock "Supported JSON
// Schema features"): basic types, `enum`, `const`, `anyOf`, `allOf`, `default`, `required`,
// `additionalProperties: false`, ten string formats, `minItems` 0 or 1, and simple patterns.
// Anthropic and Bedrock receive it as it is; the OpenAI adapter projects it onto strict mode
// (`toOpenAIStrictOutputSchema`). Where zod-to-json-schema emits something outside that subset or
// something no answer can satisfy, the schema is rewritten here, once, for every provider:
//
// - An intersection of objects (`a.and(b)`) is merged into one object (`structuralSchema`): as
//   `allOf`, each member would carry `additionalProperties: false` and refuse the other's keys.
//   Union branches the intersection rules out (the `{ not: {} }` of `b.optional()`, the null of
//   `b.nullable()`) are dropped.
// - `z.string().cidr()` lists its IPv4 and IPv6 patterns in `allOf` (both would have to match);
//   they become an `anyOf` of the two.
// - A non-capturing group `(?:…)` in a pattern is sent as a plain group, which matches the same.
// - The `{ not: {} }` branch of a `.optional()` that is not an object property (the root, an array
//   item, a union member) is dropped: no JSON value is "absent".
// - A union's sibling keywords (the `type` of `z.string().ip()`) go into each branch, and a
//   string's `type` into each member of its patterns' `allOf`, so every branch and member is a
//   whole schema.
// - A tuple (`prefixItems`, which neither provider lists) becomes an array of its item schemas,
//   with the order and length named in the description.
//
// The Zod output schema still validates the original.

import type { z } from 'zod';
import { zodPatterns, zodToJsonSchema } from 'zod-to-json-schema';
import { mergeTwoSchemas, structuralSchema } from './openai-strict-schema.js';

const allowedStringFormats = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);

export interface ProviderJsonSchemaResult {
  schema: Record<string, unknown>;
  optionalParameterCount: number;
  unionParameterCount: number;
}

export interface ProviderJsonSchemaOptions {
  promptName?: string;
}

export class ProviderJsonSchemaError extends Error {
  readonly promptName?: string;

  constructor(message: string, promptName?: string) {
    super(promptName ? `${promptName}: ${message}` : message);
    this.name = 'ProviderJsonSchemaError';
    this.promptName = promptName;
  }
}

interface NormalizationState {
  promptName?: string;
  optionalParameterCount: number;
  unionParameterCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string, state: NormalizationState): never {
  throw new ProviderJsonSchemaError(message, state.promptName);
}

function appendDescription(schema: Record<string, unknown>, message: string): void {
  const existing = typeof schema.description === 'string' ? schema.description.trim() : '';
  schema.description = existing ? `${existing} ${message}` : message;
}

function stripConstraint(
  schema: Record<string, unknown>,
  key: string,
  describe: (value: unknown) => string,
): void {
  if (!(key in schema)) return;
  appendDescription(schema, describe(schema[key]));
  delete schema[key];
}

function isPrimitiveEnumValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function hasUnsupportedRegex(pattern: string): boolean {
  return (
    /\\[1-9]/.test(pattern) ||
    /\(\?[:=!<]/.test(pattern) ||
    /\\[bB]/.test(pattern) ||
    /\{\d{4,}(?:,\d*)?\}/.test(pattern) ||
    /\{\d+,\d{4,}\}/.test(pattern)
  );
}

/**
 * `pattern` with each non-capturing group `(?:…)` written as a plain group `(…)`, which matches
 * the same strings. Anthropic documents groups `(...)` and not `(?:`, which `hasUnsupportedRegex`
 * therefore refuses, and zod-to-json-schema's own patterns use it (the IPv4 half of
 * `z.string().cidr()`, `.base64()`), so without this those patterns were only described. A pattern
 * with a backreference is left as it is: numbering its groups differently would change it.
 */
function withPlainGroups(pattern: string): string {
  if (/\\[1-9]|\\k</.test(pattern)) return pattern;
  let result = '';
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '\\') {
      result += pattern.slice(index, index + 2);
      index += 1;
    } else if (inClass) {
      if (char === ']') inClass = false;
      result += char;
    } else if (char === '[') {
      inClass = true;
      result += char;
    } else if (char === '(' && pattern.startsWith('?:', index + 1)) {
      result += '(';
      index += 2;
    } else {
      result += char;
    }
  }
  return result;
}

/** `{ not: {} }`: the branch zod-to-json-schema gives `.optional()` outside an object property. */
function isUnmatchable(schema: unknown): boolean {
  return (
    isRecord(schema) &&
    Object.keys(schema).length === 1 &&
    isRecord(schema.not) &&
    Object.keys(schema.not).length === 0
  );
}

/** An object schema, or a union or intersection with one among its members. */
function isObjectLike(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (schema.type === 'object' || isRecord(schema.properties)) return true;
  return (['anyOf', 'allOf'] as const).some((key) => {
    const members = schema[key];
    return Array.isArray(members) && members.some(isObjectLike);
  });
}

/** Keys a union node may carry beside `anyOf` without them constraining its branches. */
const unionAnnotationKeys = new Set(['anyOf', 'description', 'title', 'default']);

const ipv4CidrPattern = zodPatterns.ipv4Cidr.source;
const ipv6CidrPattern = zodPatterns.ipv6Cidr.source;

function isOnlyPattern(schema: unknown, pattern: string): boolean {
  return isRecord(schema) && Object.keys(schema).length === 1 && schema.pattern === pattern;
}

/**
 * `allOf` members with the IPv4 and IPv6 patterns zod-to-json-schema lists, one after the other,
 * for `z.string().cidr()` replaced by one `anyOf` of the two: Zod accepts either version, and an
 * `allOf` would require both, which no string does.
 */
function joinCidrAlternatives(members: unknown[]): unknown[] {
  const joined: unknown[] = [];
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index];
    const next = members[index + 1];
    if (isOnlyPattern(member, ipv4CidrPattern) && isOnlyPattern(next, ipv6CidrPattern)) {
      joined.push({ anyOf: [member, next] });
      index += 1;
    } else {
      joined.push(member);
    }
  }
  return joined;
}

/** A short name for a tuple item's schema, for the tuple's description. */
function describeItem(schema: unknown): string {
  if (!isRecord(schema)) return 'any value';
  if (Object.hasOwn(schema, 'const')) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum))
    return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map(describeItem).join(' | ');
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const names = types.filter((type): type is string => typeof type === 'string');
  if (names.length === 0) return 'any value';
  return names
    .map((type) =>
      type === 'object' && isRecord(schema.properties) && Object.keys(schema.properties).length > 0
        ? `object with ${Object.keys(schema.properties).join(', ')}`
        : type,
    )
    .join(' | ');
}

/**
 * Rewrite a tuple (draft-7 `items: [...]` with `additionalItems`, or `prefixItems` with `items`)
 * as an array whose `items` is its item schemas (an `anyOf` when they differ), and name the order
 * and length in the description (mutates `schema`). Neither Anthropic nor Bedrock lists
 * `prefixItems` among the supported keywords (Anthropic: "Array constraints beyond `minItems` of 0
 * or 1" are not supported), nor does OpenAI strict mode. The Zod output schema still checks each
 * position and the length.
 */
function projectTuple(schema: Record<string, unknown>, path: string, state: NormalizationState) {
  const positional = (Array.isArray(schema.prefixItems) ? schema.prefixItems : schema.items) as
    | unknown[]
    | undefined;
  const rawRest = Array.isArray(schema.prefixItems) ? schema.items : schema.additionalItems;
  delete schema.prefixItems;
  delete schema.items;
  delete schema.additionalItems;
  delete schema.maxItems;

  const elements = normalizeArray(positional ?? [], `${path}.items`, state);
  const rest =
    rawRest === undefined || rawRest === false
      ? undefined
      : normalizeSchemaNode(rawRest, `${path}.additionalItems`, state);

  const options: unknown[] = [];
  const seen = new Set<string>();
  for (const option of rest === undefined ? elements : [...elements, rest]) {
    const key = JSON.stringify(option);
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(option);
  }
  if (options.length === 1) {
    schema.items = options[0];
  } else if (options.length > 1) {
    state.unionParameterCount += 1;
    schema.items = { anyOf: options };
  }

  const count = elements.length;
  if (count > 0) schema.minItems = 1;
  else delete schema.minItems;
  const order = elements
    .map((element, index) => `(${index + 1}) ${describeItem(element)}`)
    .join('; ');
  const noun = count === 1 ? 'item' : 'items';
  if (rest === undefined) {
    appendDescription(
      schema,
      count === 0
        ? 'Must be empty.'
        : `Must hold exactly ${count} ${noun}, in this order: ${order}.`,
    );
  } else if (count > 0) {
    appendDescription(
      schema,
      `Must start with ${count} ${noun}, in this order: ${order}; then any number of: ${describeItem(rest)}.`,
    );
  }
}

function normalizeArray(value: unknown[], path: string, state: NormalizationState): unknown[] {
  return value.map((item, index) => normalizeSchemaNode(item, `${path}[${index}]`, state));
}

function normalizeSchemaNode(value: unknown, path: string, state: NormalizationState): unknown {
  if (typeof value === 'boolean') {
    fail(`boolean JSON Schema nodes are not supported at ${path}`, state);
  }
  if (Array.isArray(value)) {
    return normalizeArray(value, path, state);
  }
  if (!isRecord(value)) {
    return value;
  }

  let schema: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '$schema') continue;
    schema[key] = child;
  }

  if (Array.isArray(schema.allOf)) {
    for (const child of schema.allOf) {
      if (isRecord(child) && '$ref' in child) {
        fail(`allOf with $ref is not supported at ${path}`, state);
      }
    }
    const members = joinCidrAlternatives(schema.allOf);
    if (members.some(isObjectLike)) {
      // An intersection of objects: one object (or one union of objects) with every member's
      // properties and `required` keys, normalized as such below.
      const merged = structuralSchema({ ...schema, allOf: members });
      if (!Array.isArray(merged.allOf)) return normalizeSchemaNode(merged, path, state);
    }
    const [only] = members;
    if (
      members.length === 1 &&
      isRecord(only) &&
      Array.isArray(only.anyOf) &&
      Object.keys(only).length === 1 &&
      !('anyOf' in schema)
    ) {
      // `z.string().cidr()` alone: its two patterns are the node's union.
      delete schema.allOf;
      schema.anyOf = only.anyOf;
    } else {
      // A string's patterns (`.regex(a).regex(b)`, `.cidr().startsWith(…)`): each member gets the
      // node's `type`, as each union branch does below, so every member is a whole schema (the
      // cidr alternatives inside one pass it on to their branches).
      const { type } = schema;
      schema.allOf =
        type === undefined
          ? members
          : members.map((member) =>
              isRecord(member) && !('type' in member) ? { type, ...member } : member,
            );
    }
  }

  if (Array.isArray(schema.enum)) {
    if (schema.enum.length === 0) fail(`empty enum is not supported at ${path}`, state);
    if (!schema.enum.every(isPrimitiveEnumValue)) {
      fail(`enum values must be primitive at ${path}`, state);
    }
  }

  if (Array.isArray(schema.anyOf)) {
    if (schema.anyOf.length === 0) fail(`empty anyOf is not supported at ${path}`, state);
    const reachable = schema.anyOf.filter((branch) => !isUnmatchable(branch));
    if (reachable.length === 0) {
      fail(`anyOf has no branch a JSON value can match at ${path}`, state);
    }
    if (reachable.length === 1 && reachable.length < schema.anyOf.length) {
      // `.optional()` outside an object property: the value itself.
      const { anyOf: _optional, ...siblings } = schema;
      const [branch] = reachable;
      return normalizeSchemaNode(
        isRecord(branch) ? mergeTwoSchemas(siblings, branch) : branch,
        path,
        state,
      );
    }
    schema.anyOf = reachable;
    // A keyword next to the union constrains every branch (the `type` of `z.string().ip()` or of
    // `z.string().cidr()`): each branch gets it, so every branch is a whole schema.
    if (
      !Array.isArray(schema.allOf) &&
      Object.keys(schema).some((key) => !unionAnnotationKeys.has(key))
    ) {
      schema = structuralSchema(schema);
    }
    state.unionParameterCount += 1;
    schema.anyOf = normalizeArray(schema.anyOf as unknown[], `${path}.anyOf`, state);
  }

  if (Array.isArray(schema.oneOf)) {
    if (schema.oneOf.length === 0) fail(`empty oneOf is not supported at ${path}`, state);
    state.unionParameterCount += 1;
    schema.anyOf = normalizeArray(schema.oneOf, `${path}.oneOf`, state);
    delete schema.oneOf;
  }

  if (Array.isArray(schema.allOf)) {
    schema.allOf = normalizeArray(schema.allOf, `${path}.allOf`, state);
  }

  if (Array.isArray(schema.type)) {
    state.unionParameterCount += 1;
  }

  if (schema.type === 'object' || isRecord(schema.properties)) {
    schema.type = 'object';
    if ('additionalProperties' in schema && schema.additionalProperties !== false) {
      fail(`additionalProperties must be false at ${path}`, state);
    }
    schema.additionalProperties = false;

    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? new Set(schema.required.filter((key): key is string => typeof key === 'string'))
      : new Set<string>();

    const normalizedProperties: Record<string, unknown> = {};
    for (const [propertyName, propertySchema] of Object.entries(properties)) {
      if (!required.has(propertyName)) {
        state.optionalParameterCount += 1;
      }
      normalizedProperties[propertyName] = normalizeSchemaNode(
        propertySchema,
        `${path}.properties.${propertyName}`,
        state,
      );
    }
    schema.properties = normalizedProperties;
    if (required.size > 0) {
      schema.required = [...required];
    } else {
      delete schema.required;
    }
  }

  if (schema.type === 'array' || 'items' in schema || 'prefixItems' in schema) {
    if (Array.isArray(schema.items) || Array.isArray(schema.prefixItems)) {
      projectTuple(schema, path, state);
    } else if ('items' in schema) {
      schema.items = normalizeSchemaNode(schema.items, `${path}.items`, state);
    }

    if (typeof schema.minItems === 'number' && schema.minItems > 1) {
      appendDescription(schema, `Must contain at least ${schema.minItems} items.`);
      schema.minItems = 1;
    }
    stripConstraint(
      schema,
      'maxItems',
      (constraint) => `Must contain at most ${constraint} items.`,
    );
    delete schema.minContains;
    delete schema.maxContains;
  }

  if (typeof schema.format === 'string' && !allowedStringFormats.has(schema.format)) {
    appendDescription(schema, `Expected string format: ${schema.format}.`);
    delete schema.format;
  }

  if (typeof schema.pattern === 'string') {
    const pattern = withPlainGroups(schema.pattern);
    if (hasUnsupportedRegex(pattern)) {
      appendDescription(schema, `Must match pattern: ${schema.pattern}.`);
      delete schema.pattern;
    } else {
      schema.pattern = pattern;
    }
  }

  stripConstraint(schema, 'minimum', (constraint) => `Must be at least ${constraint}.`);
  stripConstraint(schema, 'maximum', (constraint) => `Must be at most ${constraint}.`);
  stripConstraint(
    schema,
    'exclusiveMinimum',
    (constraint) => `Must be greater than ${constraint}.`,
  );
  stripConstraint(schema, 'exclusiveMaximum', (constraint) => `Must be less than ${constraint}.`);
  stripConstraint(schema, 'multipleOf', (constraint) => `Must be a multiple of ${constraint}.`);
  stripConstraint(
    schema,
    'minLength',
    (constraint) => `Must be at least ${constraint} characters.`,
  );
  stripConstraint(schema, 'maxLength', (constraint) => `Must be at most ${constraint} characters.`);

  for (const [key, child] of Object.entries(schema)) {
    if (
      key === 'properties' ||
      key === 'items' ||
      key === 'prefixItems' ||
      key === 'anyOf' ||
      key === 'allOf'
    ) {
      continue;
    }
    if (isRecord(child) || Array.isArray(child)) {
      schema[key] = normalizeSchemaNode(child, `${path}.${key}`, state);
    }
  }

  return schema;
}

export function zodToProviderJsonSchema(
  zodSchema: z.ZodTypeAny,
  options: ProviderJsonSchemaOptions = {},
): ProviderJsonSchemaResult {
  const raw = zodToJsonSchema(zodSchema, {
    $refStrategy: 'none',
    target: 'jsonSchema7',
  });

  const state: NormalizationState = {
    promptName: options.promptName,
    optionalParameterCount: 0,
    unionParameterCount: 0,
  };
  const normalized = normalizeSchemaNode(raw, '#', state);

  if (!isRecord(normalized)) {
    fail('top-level schema must be an object', state);
  }
  if (state.optionalParameterCount > 24) {
    fail(
      `structured-output schema has ${state.optionalParameterCount} optional parameters; Anthropic limit is 24`,
      state,
    );
  }
  if (state.unionParameterCount > 16) {
    fail(
      `structured-output schema has ${state.unionParameterCount} union parameters; Anthropic limit is 16`,
      state,
    );
  }

  return {
    schema: normalized,
    optionalParameterCount: state.optionalParameterCount,
    unionParameterCount: state.unionParameterCount,
  };
}
