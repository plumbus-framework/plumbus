// ── OpenAI strict structured-output schema projection ──
// OpenAI's strict mode (Chat Completions `response_format` json_schema, strict function tools,
// Responses `text.format`) refuses any object whose `required` does not list every key in
// `properties`. The provider-neutral schema from `zodToProviderJsonSchema` keeps optional
// properties optional, because Anthropic and Bedrock take them as they are (and Anthropic counts
// them against its limit of 24). OpenAI expresses "optional" as "required, but may be null", so the
// OpenAI adapter sends `toOpenAIStrictJsonSchema(schema)` (inside `toOpenAIStrictOutputSchema`)
// and the AI service turns those nulls back into absent properties with
// `restoreOmittedOptionalProperties` before the Zod output schema sees the answer.
//
// Strict mode also accepts fewer string formats than Anthropic and Bedrock: an unsupported one
// (`uri`, from `z.string().url()`) fails the whole request with "'uri' is not a valid format".
// The projection drops such a format and names it in the property's description instead; the
// Zod output schema still checks it.
//
// Strict mode does not support `allOf` ("Composition: allOf, not, ... are not yet supported").
// zod-to-json-schema emits it for intersections (`a.and(b)`) and for a string with more than one
// pattern (`.regex(a).regex(b)`, `.startsWith(a).endsWith(b)`). `zodToProviderJsonSchema` already
// merges intersections of objects (with `structuralSchema`, since their members' own
// `additionalProperties: false` would refuse every answer on any provider) and turns the two
// patterns of `z.string().cidr()` into an `anyOf`; what reaches this projection is a string's
// pattern list, or a schema built by hand. The projection merges the members into one schema and
// names in the description what that schema cannot carry (`mergeAllOf`); the Zod output schema
// still checks the original. Keywords next to an `anyOf` (an object intersected with a union, the
// `type` of `z.string().ip()` or `z.string().cidr()`) go into each branch (`distributeUnion`), and
// `restoreOmittedOptionalProperties` reads the schema the same way.
//
// Strict mode has no `default` either (it is not among the supported keywords): the projection
// names the value in the description (`Defaults to "x".`). An optional property with a default is
// sent nullable like any other optional property, its null is dropped before validation, and Zod
// fills in the default.
//
// Strict mode also needs an object at the root ("Root objects must not be anyOf and must be an
// object"), which a `z.array(...)`, union, enum or nullable output is not.
// `toOpenAIStrictOutputSchema` sends such a schema as the single property `value` of an object,
// and the adapter takes the answer back out (`unwrapOpenAIStrictOutput`, or
// `createOpenAIStrictOutputStreamUnwrapper` for a stream) before anything else sees it.

/**
 * The string `format` values OpenAI accepts in strict mode, from the "Supported properties"
 * section of https://developers.openai.com/api/docs/guides/structured-outputs.
 */
const OPENAI_STRICT_STRING_FORMATS: ReadonlySet<string> = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'ipv4',
  'ipv6',
  'uuid',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const scalarTypes = new Set(['string', 'number', 'integer', 'boolean']);
// Keys that describe a union without constraining it, so a null branch can join its `anyOf`.
const annotationKeys = new Set(['description', 'title']);

function isScalarType(value: unknown): boolean {
  return typeof value === 'string' && scalarTypes.has(value);
}

function matchesType(value: unknown, type: unknown): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((candidate) => {
    switch (candidate) {
      case 'null':
        return value === null;
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number';
      case 'integer':
        return Number.isInteger(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'object':
        return isRecord(value);
      case 'array':
        return Array.isArray(value);
      default:
        return true;
    }
  });
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
    return false;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function ownSchema(properties: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(properties, key) ? properties[key] : undefined;
}

function requiredKeys(schema: Record<string, unknown>): Set<string> {
  return new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === 'string')
      : [],
  );
}

/**
 * Structural check of a value against the provider JSON Schema subset (`type`, `const`, `enum`,
 * `anyOf`, `allOf`, `properties`/`required`/`additionalProperties: false`, `items`,
 * `prefixItems`). String formats, patterns and numeric bounds are not checked: the Zod output
 * schema still validates the answer, and this check only has to tell union branches apart and
 * whether a property's schema admits `null`. An `allOf` is checked as the one schema strict mode
 * was sent (`structuralSchema`): its members each carry `additionalProperties: false`, so taken
 * one by one they would refuse every answer to an intersection of objects.
 */
function matchesSchema(value: unknown, rawSchema: unknown): boolean {
  if (!isRecord(rawSchema)) return rawSchema !== false;
  const schema = structuralSchema(rawSchema);
  if ('const' in schema && !sameJsonValue(value, schema.const)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => sameJsonValue(value, option))) {
    return false;
  }
  if (schema.type !== undefined && !matchesType(value, schema.type)) return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((branch) => matchesSchema(value, branch))) {
    return false;
  }
  if (isRecord(value) && isRecord(schema.properties)) {
    const properties = schema.properties;
    for (const key of requiredKeys(schema)) {
      if (!Object.hasOwn(value, key)) return false;
    }
    for (const [key, child] of Object.entries(value)) {
      const propertySchema = ownSchema(properties, key);
      if (propertySchema === undefined) {
        if (schema.additionalProperties === false) return false;
        continue;
      }
      if (!matchesSchema(child, propertySchema)) return false;
    }
  }
  if (Array.isArray(value)) {
    const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    for (const [index, item] of value.entries()) {
      const itemSchema = index < prefixItems.length ? prefixItems[index] : schema.items;
      if (itemSchema !== undefined && !matchesSchema(item, itemSchema)) return false;
    }
  }
  return true;
}

function acceptsNull(schema: unknown): boolean {
  return matchesSchema(null, schema);
}

/**
 * Widen a property schema so it also accepts `null`. Scalars use a type array
 * (`["string", "null"]`), the form OpenAI documents for optional fields and the form
 * zod-to-json-schema already emits for `.nullable()` scalars; everything else (enums, consts,
 * objects, arrays, unions) gets a `{ type: "null" }` branch, flattened into an existing `anyOf`.
 */
function withNull(schema: unknown): unknown {
  if (!isRecord(schema) || acceptsNull(schema)) return schema;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!('enum' in schema) && !('const' in schema) && types.every(isScalarType)) {
    return { ...schema, type: [...types, 'null'] };
  }
  const { anyOf, ...rest } = schema;
  if (Array.isArray(anyOf) && Object.keys(rest).every((key) => annotationKeys.has(key))) {
    return { ...rest, anyOf: [...anyOf, { type: 'null' }] };
  }
  return { anyOf: [schema, { type: 'null' }] };
}

/** Append `hint` to a schema's description unless it already says it (mutates `schema`). */
function appendDescription(schema: Record<string, unknown>, hint: string): void {
  if (!hint) return;
  const existing = typeof schema.description === 'string' ? schema.description.trim() : '';
  if (existing.includes(hint)) return;
  schema.description = existing ? `${existing} ${hint}` : hint;
}

/**
 * Replace a string `format` OpenAI strict mode rejects with a description hint, the way
 * `zodToProviderJsonSchema` treats formats no provider supports.
 */
function dropUnsupportedFormat(strict: Record<string, unknown>): void {
  const format = strict.format;
  if (typeof format !== 'string' || OPENAI_STRICT_STRING_FORMATS.has(format)) return;
  delete strict.format;
  appendDescription(strict, `Expected string format: ${format}.`);
}

// ── allOf ──

/** The description text for a constraint the merged schema cannot carry. */
function constraintHint(key: string, value: unknown): string {
  if (key === 'pattern' && typeof value === 'string') return `Must match pattern: ${value}.`;
  if (key === 'format' && typeof value === 'string') return `Expected string format: ${value}.`;
  return `Must also satisfy ${JSON.stringify({ [key]: value })}.`;
}

function typeList(type: unknown): string[] | undefined {
  if (typeof type === 'string') return [type];
  if (Array.isArray(type) && type.every((entry) => typeof entry === 'string')) return type;
  return undefined;
}

/** The JSON types both `type` keywords accept (an integer is a number), or undefined if none. */
function intersectTypes(left: unknown, right: unknown): unknown {
  const leftTypes = typeList(left);
  const rightTypes = typeList(right);
  if (!leftTypes || !rightTypes) return undefined;
  const accepts = (types: string[], type: string) =>
    types.includes(type) || (type === 'integer' && types.includes('number'));
  const common = [...new Set([...leftTypes, ...rightTypes])].filter(
    (type) => accepts(leftTypes, type) && accepts(rightTypes, type),
  );
  if (common.length === 0) return undefined;
  return common.length === 1 ? common[0] : common;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** `{ not: {} }` (zod-to-json-schema's `.optional()` outside an object property): matches nothing. */
function matchesNothing(schema: Record<string, unknown>): boolean {
  return isRecord(schema.not) && Object.keys(schema.not).length === 0;
}

/**
 * False when no value can satisfy both schemas, judged from what each says outright: one of them
 * matches nothing (`{ not: {} }`), their types share nothing, their `const` / `enum` values do not
 * meet, or a property one of them requires has two such schemas. Merging such a pair would leave a
 * union branch that only its description calls impossible (`a.and(b.nullable())` gave a branch
 * `{a}` that Zod refuses, `a.and(b.optional())` one with `not: {}`), so the merge drops it.
 */
function canBothHold(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  if (matchesNothing(left) || matchesNothing(right)) return false;
  if (typeList(left.type) && typeList(right.type) && !intersectTypes(left.type, right.type)) {
    return false;
  }
  const values = (schema: Record<string, unknown>): unknown[] | undefined =>
    Object.hasOwn(schema, 'const')
      ? [schema.const]
      : Array.isArray(schema.enum)
        ? schema.enum
        : undefined;
  const leftValues = values(left);
  const rightValues = values(right);
  if (
    leftValues &&
    rightValues &&
    !leftValues.some((option) => rightValues.some((other) => sameJsonValue(option, other)))
  ) {
    return false;
  }
  if (isRecord(left.properties) && isRecord(right.properties)) {
    const required = new Set([...requiredKeys(left), ...requiredKeys(right)]);
    for (const key of required) {
      const first = ownSchema(left.properties, key);
      const second = ownSchema(right.properties, key);
      if (isRecord(first) && isRecord(second) && !canBothHold(first, second)) return false;
    }
  }
  return true;
}

/** Both objects' properties; a key both declare gets the merge of its two schemas. */
function mergeProperties(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const entries = Object.entries(left);
  for (const [key, schema] of Object.entries(right)) {
    const index = entries.findIndex(([existing]) => existing === key);
    const current = index >= 0 ? entries[index] : undefined;
    if (!current) {
      entries.push([key, schema]);
    } else if (isRecord(current[1]) && isRecord(schema)) {
      current[1] = mergeSchemas([current[1], schema]);
    }
  }
  // fromEntries defines own data properties, so a `__proto__` property name stays data.
  return Object.fromEntries(entries);
}

/**
 * One schema that requires what `left` and `right` both require. Keywords only one side has are
 * kept; keywords both have are combined where JSON Schema allows it (`type` and `enum`
 * intersected, `properties` and `required` joined, `minItems` the larger, `items` and union
 * branches merged in turn); where it does not (two different patterns or formats), the first is
 * kept and the other is named in the description. Annotations (`title`, `default`) keep the
 * first; descriptions are joined. Also used by `zodToProviderJsonSchema` to fold a union's only
 * reachable branch into the node that holds it.
 */
export function mergeTwoSchemas(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...left };
  const hints: string[] = [];
  for (const [key, value] of Object.entries(right)) {
    if (!Object.hasOwn(merged, key)) {
      merged[key] = value;
      continue;
    }
    const current = merged[key];
    if (sameJsonValue(current, value)) continue;
    switch (key) {
      case 'description':
        if (typeof value === 'string') hints.push(value.trim());
        break;
      case 'title':
      case 'default':
      case 'examples':
        break;
      case 'type': {
        const type = intersectTypes(current, value);
        if (type === undefined) hints.push(constraintHint(key, value));
        else merged.type = type;
        break;
      }
      case 'properties':
        if (isRecord(current) && isRecord(value)) {
          merged.properties = mergeProperties(current, value);
        }
        break;
      case 'required':
        merged.required = [...new Set([...stringList(current), ...stringList(value)])];
        break;
      case 'additionalProperties':
        if (value === false) merged.additionalProperties = false;
        break;
      case 'items':
        if (isRecord(current) && isRecord(value)) merged.items = mergeSchemas([current, value]);
        break;
      case 'prefixItems':
        if (Array.isArray(current) && Array.isArray(value)) {
          merged.prefixItems = Array.from(
            { length: Math.max(current.length, value.length) },
            (_, index) => {
              const [first, second] = [current[index], value[index]];
              return isRecord(first) && isRecord(second)
                ? mergeSchemas([first, second])
                : (first ?? second);
            },
          );
        }
        break;
      case 'anyOf':
        // (A1 | A2) & (B1 | B2) = (A1 & B1) | (A1 & B2) | (A2 & B1) | (A2 & B2), without the
        // pairs no value satisfies (unless that is every pair: then nothing is dropped).
        if (Array.isArray(current) && Array.isArray(value)) {
          const pairs = current.flatMap((first) => value.map((second) => [first, second]));
          const possible = pairs.filter(
            ([first, second]) =>
              !isRecord(first) ||
              !isRecord(second) ||
              canBothHold(mergeAllOf(first), mergeAllOf(second)),
          );
          merged.anyOf = (possible.length > 0 ? possible : pairs).map(([first, second]) =>
            isRecord(first) && isRecord(second) ? mergeSchemas([first, second]) : first,
          );
        }
        break;
      case 'enum': {
        const common = Array.isArray(current)
          ? current.filter(
              (option) =>
                Array.isArray(value) && value.some((other) => sameJsonValue(option, other)),
            )
          : [];
        if (common.length > 0) merged.enum = common;
        else hints.push(constraintHint(key, value));
        break;
      }
      case 'minItems':
        if (typeof current === 'number' && typeof value === 'number') {
          merged.minItems = Math.max(current, value);
        }
        break;
      default:
        hints.push(constraintHint(key, value));
    }
  }
  for (const hint of hints) appendDescription(merged, hint);
  return merged;
}

/** Fold `schemas` (each with its own `allOf` merged first) into one. */
function mergeSchemas(schemas: Record<string, unknown>[]): Record<string, unknown> {
  const [first, ...rest] = schemas.map(mergeAllOf);
  return rest.reduce(mergeTwoSchemas, first ?? {});
}

/**
 * Replace a node's `allOf` with one schema that says the same: the node's own keywords merged with
 * every member (`mergeTwoSchemas`). A member's `pattern` is not kept but named in the description
 * (`"Must match pattern: …."`): zod-to-json-schema lists every pattern of a string in `allOf` when
 * it has more than one, and strict mode takes one `pattern` per schema. The Zod output schema
 * still checks every pattern. (The IPv4 and IPv6 alternatives of `z.string().cidr()`, which
 * zod-to-json-schema also lists in `allOf`, arrive here as an `anyOf`: `zodToProviderJsonSchema`
 * turns them into one.)
 */
function mergeAllOf(node: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(node.allOf)) return node;
  const { allOf, ...base } = node;
  const members = allOf.filter(isRecord).map((member) => {
    const { pattern, ...rest } = mergeAllOf(member);
    if (pattern !== undefined) appendDescription(rest, constraintHint('pattern', pattern));
    return rest;
  });
  return members.reduce(mergeTwoSchemas, base);
}

/**
 * Move a union's sibling keywords into each of its branches: `{ A, anyOf: [B1, B2] }` becomes
 * `{ anyOf: [A & B1, A & B2] }` (a `description` or `title` stays on the union). Merging an
 * intersection with a union (`z.object({...}).and(z.discriminatedUnion(...))`) leaves the object's
 * `properties` next to the union's `anyOf`, and the branches' `additionalProperties: false` would
 * then refuse the object's properties; `z.string().ip()` has `type` next to branches that have none.
 * A branch `A` rules out (`canBothHold`: the `{ not: {} }` of `a.and(b.optional())`, the null of
 * `a.and(b.nullable())`) is dropped, and a union left with one branch is that branch.
 */
function distributeUnion(node: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(node.anyOf)) return node;
  const { anyOf, ...rest } = node;
  const annotations: Record<string, unknown> = {};
  const shared: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (annotationKeys.has(key)) annotations[key] = value;
    else shared[key] = value;
  }
  if (Object.keys(shared).length === 0) return node;
  const branches = anyOf.map((branch) => (isRecord(branch) ? structuralSchema(branch) : branch));
  const possible = branches.filter((branch) => !isRecord(branch) || canBothHold(shared, branch));
  const merged = (possible.length > 0 ? possible : branches).map((branch) =>
    isRecord(branch) ? mergeTwoSchemas(shared, branch) : branch,
  );
  const [only] = merged;
  if (merged.length === 1 && isRecord(only)) return mergeTwoSchemas(annotations, only);
  return { ...annotations, anyOf: merged };
}

/**
 * The schema as strict mode is sent it, at this node: `allOf` merged, union siblings distributed.
 * `zodToProviderJsonSchema` merges an intersection of objects with it too, for every provider.
 */
export function structuralSchema(node: Record<string, unknown>): Record<string, unknown> {
  return distributeUnion(mergeAllOf(node));
}

/**
 * Replace a `default` (not a strict-mode keyword) with a description hint (mutates `strict`). The
 * value still applies: the property it sits on is optional, so strict mode sends it nullable,
 * `restoreOmittedOptionalProperties` drops the null, and Zod fills in the default.
 */
function dropDefault(strict: Record<string, unknown>): void {
  if (!Object.hasOwn(strict, 'default')) return;
  const value = strict.default;
  delete strict.default;
  appendDescription(strict, `Defaults to ${JSON.stringify(value)}.`);
}

function toStrictNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toStrictNode);
  if (!isRecord(value)) return value;

  const node = structuralSchema(value);
  const strict: Record<string, unknown> = { ...node };
  dropUnsupportedFormat(strict);
  dropDefault(strict);
  if (isRecord(node.properties)) {
    const required = requiredKeys(node);
    const properties: [string, unknown][] = [];
    for (const [key, child] of Object.entries(node.properties)) {
      const converted = toStrictNode(child);
      properties.push([key, required.has(key) ? converted : withNull(converted)]);
    }
    strict.properties = Object.fromEntries(properties);
    strict.required = properties.map(([key]) => key);
  }
  if ('items' in node) strict.items = toStrictNode(node.items);
  if (Array.isArray(node.prefixItems)) strict.prefixItems = node.prefixItems.map(toStrictNode);
  if (Array.isArray(node.anyOf)) strict.anyOf = node.anyOf.map(toStrictNode);
  return strict;
}

/**
 * Project a provider-neutral structured-output schema (from `zodToProviderJsonSchema`) onto
 * OpenAI's strict subset: every object lists all of its properties in `required`, and each
 * property that was optional also accepts `null` (unless it already did). A string `format`
 * outside `OPENAI_STRICT_STRING_FORMATS` (such as `uri`) is removed and named in the
 * description, and so is a `default` (`dropDefault`). Every `allOf` is merged into one schema
 * (`mergeAllOf`), since strict mode has no `allOf`. Nested objects, array items and every `anyOf`
 * branch are projected too.
 * The input is not mutated — `createAIService` caches it and shares it across providers.
 */
export function toOpenAIStrictJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return toStrictNode(schema) as Record<string, unknown>;
}

// ── Root envelope ──

/** The property a structured output whose root is not an object is sent and answered under. */
export const OPENAI_STRICT_OUTPUT_ENVELOPE_KEY = 'value';

export interface OpenAIStrictOutputSchema {
  /** The schema the request sends: `toOpenAIStrictJsonSchema(schema)`, in the envelope if needed. */
  schema: Record<string, unknown>;
  /** True when the answer comes back as `{"value": <answer>}` and has to be unwrapped. */
  enveloped: boolean;
}

/** OpenAI's rule for the root: an object, and not a union, enum, const or nullable object. */
function isStrictObjectRoot(schema: Record<string, unknown>): boolean {
  return (
    schema.type === 'object' &&
    !['anyOf', 'oneOf', 'allOf', 'not', 'enum', 'const'].some((key) => key in schema)
  );
}

/**
 * The schema an OpenAI strict structured output sends for `schema`. An object root goes as
 * `toOpenAIStrictJsonSchema(schema)`. Any other root (`z.array(...)` — `classify()`, an
 * `extract()` or prompt output that is an array, a union, an enum, a number, a nullable object)
 * goes as the single required property `value` of an object, because OpenAI refuses a schema
 * whose root is not an object; the adapter unwraps the answer, so callers never see the envelope.
 */
export function toOpenAIStrictOutputSchema(
  schema: Record<string, unknown>,
): OpenAIStrictOutputSchema {
  const strict = toOpenAIStrictJsonSchema(schema);
  if (isStrictObjectRoot(strict)) return { schema: strict, enveloped: false };
  return {
    schema: {
      type: 'object',
      properties: { [OPENAI_STRICT_OUTPUT_ENVELOPE_KEY]: strict },
      required: [OPENAI_STRICT_OUTPUT_ENVELOPE_KEY],
      additionalProperties: false,
    },
    enveloped: true,
  };
}

/** True when `text` is one complete JSON value. */
function isJsonText(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The answer inside an enveloped strict output (`{"value": [...]}` → `[...]`), as JSON text. An
 * answer cut off inside the envelope's value (`max_tokens`) comes back as the part of the value
 * it holds (`{"value":[{"a":"x"` → `[{"a":"x"`), as a stream of it would, so an
 * `AIIncompleteOutputError`'s `partialText` does not show the envelope. Any other text (not the
 * envelope, not JSON, or a complete value with something after it) comes back unchanged, for
 * validation to report.
 */
export function unwrapOpenAIStrictOutput(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const unwrapper = createOpenAIStrictOutputStreamUnwrapper();
    const inner = unwrapper.push(content) + unwrapper.end();
    return inner !== content && !isJsonText(inner) ? inner : content;
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== 1 ||
    !Object.hasOwn(parsed, OPENAI_STRICT_OUTPUT_ENVELOPE_KEY)
  ) {
    return content;
  }
  return JSON.stringify(parsed[OPENAI_STRICT_OUTPUT_ENVELOPE_KEY]);
}

export interface OpenAIStrictOutputStreamUnwrapper {
  /** The part of a streamed text delta that belongs to the answer (may be empty). */
  push(delta: string): string;
  /**
   * Once the stream has ended: text held back because it looked like the envelope's opening, or
   * nothing if the whole opening `{"value":` had arrived (then it was the envelope, cut off
   * before its value).
   */
  end(): string;
}

const JSON_WHITESPACE: ReadonlySet<string> = new Set([' ', '\t', '\n', '\r']);

/**
 * `unwrapOpenAIStrictOutput` for a streamed answer: the opening `{"value":` is held back until it
 * is complete, the value is passed on as it arrives, and what follows it (the closing `}`) is
 * dropped. A stream that does not open with the envelope is passed on unchanged, so validation
 * sees exactly what the model wrote.
 */
export function createOpenAIStrictOutputStreamUnwrapper(): OpenAIStrictOutputStreamUnwrapper {
  const keyText = `${OPENAI_STRICT_OUTPUT_ENVELOPE_KEY}"`;
  let state: 'open' | 'key' | 'keyText' | 'colon' | 'valueStart' | 'value' | 'after' | 'raw' =
    'open';
  let held = '';
  let keyIndex = 0;
  let kind: 'container' | 'string' | 'literal' = 'literal';
  let depth = 0;
  let inString = false;
  let escaped = false;

  /** Holds `char` back while it may be part of the envelope's opening. */
  const hold = (char: string, next: typeof state = state): string => {
    held += char;
    state = next;
    return '';
  };
  /** Not the envelope after all: everything held back is passed on, and the rest as it comes. */
  const giveUp = (char: string): string => {
    const text = held + char;
    held = '';
    state = 'raw';
    return text;
  };

  const step = (char: string): string => {
    switch (state) {
      case 'raw':
        return char;
      case 'after':
        return '';
      case 'open':
        if (JSON_WHITESPACE.has(char)) return hold(char);
        return char === '{' ? hold(char, 'key') : giveUp(char);
      case 'key':
        if (JSON_WHITESPACE.has(char)) return hold(char);
        if (char !== '"') return giveUp(char);
        keyIndex = 0;
        return hold(char, 'keyText');
      case 'keyText':
        if (char !== keyText[keyIndex]) return giveUp(char);
        keyIndex += 1;
        return hold(char, keyIndex === keyText.length ? 'colon' : 'keyText');
      case 'colon':
        if (JSON_WHITESPACE.has(char)) return hold(char);
        return char === ':' ? hold(char, 'valueStart') : giveUp(char);
      case 'valueStart':
        if (JSON_WHITESPACE.has(char)) return hold(char);
        held = '';
        state = 'value';
        if (char === '{' || char === '[') {
          kind = 'container';
          depth = 1;
        } else if (char === '"') {
          kind = 'string';
          inString = true;
        } else {
          kind = 'literal';
        }
        return char;
      case 'value':
        if (kind === 'literal') {
          if (JSON_WHITESPACE.has(char) || char === ',' || char === '}' || char === ']') {
            state = 'after';
            return '';
          }
          return char;
        }
        if (inString) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') {
            inString = false;
            if (kind === 'string') state = 'after';
          }
          return char;
        }
        if (char === '"') inString = true;
        else if (char === '{' || char === '[') depth += 1;
        else if (char === '}' || char === ']') {
          depth -= 1;
          if (depth === 0) state = 'after';
        }
        return char;
    }
  };

  return {
    push(delta) {
      let text = '';
      for (const char of delta) text += step(char);
      return text;
    },
    end() {
      const text = state === 'valueStart' ? '' : held;
      held = '';
      return text;
    },
  };
}

/**
 * Undo `toOpenAIStrictJsonSchema` on a parsed answer: drop a property whose value is `null` when
 * `schema` (the provider-neutral schema the request carried) marks it optional and its own schema
 * does not admit `null`. A property that admits `null` (`.nullable()`, `.nullish()`) keeps it.
 *
 * Union branches are chosen deterministically: the first branch the answer already satisfies
 * keeps it unchanged; otherwise the first branch it satisfies once that branch's optional nulls
 * are dropped. An answer that already satisfies `schema` comes back unchanged, so providers that
 * honour the optional properties as they are (Anthropic, Bedrock) are unaffected. An answer that
 * fits no branch is left for the Zod output schema to report.
 *
 * An `allOf` is read as the one schema strict mode was sent (merged, with an object's properties
 * moved into the branches of a union it is intersected with), so an intersection's optionals are
 * found whichever member declares them.
 */
export function restoreOmittedOptionalProperties(value: unknown, rawSchema: unknown): unknown {
  if (!isRecord(rawSchema)) return value;
  const schema = structuralSchema(rawSchema);

  let current = value;
  if (
    Array.isArray(schema.anyOf) &&
    !schema.anyOf.some((branch) => matchesSchema(current, branch))
  ) {
    for (const branch of schema.anyOf) {
      const restored = restoreOmittedOptionalProperties(current, branch);
      if (matchesSchema(restored, branch)) {
        current = restored;
        break;
      }
    }
  }

  if (isRecord(current) && isRecord(schema.properties)) {
    const properties = schema.properties;
    const required = requiredKeys(schema);
    const entries: [string, unknown][] = [];
    for (const [key, child] of Object.entries(current)) {
      const propertySchema = ownSchema(properties, key);
      if (propertySchema === undefined) {
        entries.push([key, child]);
        continue;
      }
      if (child === null && !required.has(key) && !acceptsNull(propertySchema)) continue;
      entries.push([key, restoreOmittedOptionalProperties(child, propertySchema)]);
    }
    // fromEntries defines own data properties, so a `__proto__` key in the answer stays data.
    return Object.fromEntries(entries);
  }

  if (Array.isArray(current)) {
    const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    return current.map((item, index) =>
      restoreOmittedOptionalProperties(
        item,
        index < prefixItems.length ? prefixItems[index] : schema.items,
      ),
    );
  }

  return current;
}
