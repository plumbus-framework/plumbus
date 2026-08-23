/**
 * Convention `plumbus generate` OpenAPI uses the same 3.0→3.1 conversion as
 * `@plumbus/api`. Kept in core so generate does not depend on the optional
 * partner package. `@plumbus/api` re-exports these functions.
 */

export const JSON_SCHEMA_2020_12_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/** Minimal OpenAPI document shape the 3.1 conversion pass rewrites. */
export interface OpenApi31ConvertibleDocument {
  openapi: string;
  jsonSchemaDialect?: string;
  info: { title: string; version: string; description?: string };
  servers?: { url: string }[];
  paths: Record<string, Record<string, unknown>>;
  components?: Record<string, unknown>;
  security?: Record<string, string[]>[];
}

/**
 * OpenAPI 3.1 emission.
 *
 * The generator assembles documents in the OpenAPI 3.0 shape — that is what
 * `zod-to-json-schema`'s `openApi3` target produces and what every existing
 * consumer receives. Emitting 3.1 is therefore a conversion pass over the
 * assembled document rather than a second assembly path, which is also what
 * keeps the 3.0.3 output byte-identical.
 *
 * The substantive change in 3.1 is that a Schema Object stops being OpenAPI's
 * own draft-04-derived dialect and becomes a plain JSON Schema 2020-12 schema.
 * So the conversion is: rewrite every Schema Object — and only a Schema Object
 * — into 2020-12, then restate the document version and dialect.
 *
 * Differences handled here:
 *
 *   - `nullable: true` → a `null` member of `type` (or of `enum`, or an added
 *     `anyOf` branch when the schema has no `type` to widen). 2020-12 has no
 *     `nullable` keyword at all.
 *   - draft-04 boolean `exclusiveMinimum` / `exclusiveMaximum` paired with
 *     `minimum` / `maximum` → the 2020-12 numeric form.
 *   - positional (array-valued) `items` → `prefixItems`, and `additionalItems`
 *     → `items`, the 2020-12 spelling of a tuple with a rest element.
 *   - `example` → `examples`, which is an array in a 2020-12 Schema Object.
 *   - `jsonSchemaDialect` declared at the document root.
 *   - `z.null()`, which the 3.0 target encodes as the sentinel
 *     `{ enum: ['null'], nullable: true }`, becomes `{ type: 'null' }`.
 *
 * Deliberately NOT handled, and why:
 *
 *   - `format: 'binary'` / `'byte'` → `contentMediaType` / `contentEncoding`.
 *     A real 3.0→3.1 difference, but no schema this package emits can carry
 *     those formats: Schema Objects here come from Zod through
 *     `zodToOpenApiSchema` (which never emits them) or from the two hand-written
 *     envelope components. Adding an unreachable branch would be untested code.
 *   - Media Type and Parameter Object `example` / `examples`. Those are OpenAPI
 *     objects, not Schema Objects, and their `examples` is a map of Example
 *     Objects in 3.0 *and* 3.1 — converting them to an array would break them.
 *     Only Schema Object positions are visited.
 *   - `webhooks`, `info.summary`, `license.identifier`, `type: mutualTLS`, and
 *     3.1's optional `paths`: all additive 3.1 features with no emission path
 *     in this generator, so there is nothing to convert.
 *   - `discriminator` / `xml` narrowing: never emitted.
 */

type JsonObject = Record<string, unknown>;

/** Keywords whose value is a single subschema (or, for `items`, possibly a list). */
const SUBSCHEMA_KEYWORDS = [
  'additionalItems',
  'additionalProperties',
  'contains',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
] as const;

/** Keywords whose value is a map of name → subschema. */
const SUBSCHEMA_MAP_KEYWORDS = [
  '$defs',
  'definitions',
  'dependentSchemas',
  'patternProperties',
  'properties',
] as const;

/** Keywords whose value is a list of subschemas. */
const SUBSCHEMA_LIST_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;

/**
 * Annotation keywords that describe a schema rather than constrain it. When a
 * nullable schema has to be wrapped in `anyOf`, these stay at the top level so
 * documentation tooling still finds them.
 */
const ANNOTATION_KEYWORDS = new Set([
  '$comment',
  'default',
  'deprecated',
  'description',
  'examples',
  'externalDocs',
  'readOnly',
  'title',
  'writeOnly',
]);

const OPERATION_KEYWORDS = new Set([
  'delete',
  'get',
  'head',
  'options',
  'patch',
  'post',
  'put',
  'trace',
]);

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rewrite the draft-04 boolean exclusive-bound form into the 2020-12 numeric
 * one. `{ exclusiveMinimum: true, minimum: 1 }` means "greater than 1"; 2020-12
 * spells that `{ exclusiveMinimum: 1 }`. `exclusiveMinimum: false` was merely a
 * restatement of the inclusive bound, so the flag is dropped.
 */
function convertExclusiveBound(schema: JsonObject, exclusive: string, inclusive: string): void {
  const flag = schema[exclusive];
  if (typeof flag !== 'boolean') {
    return;
  }
  delete schema[exclusive];
  if (!flag) {
    return;
  }
  const bound = schema[inclusive];
  if (typeof bound === 'number') {
    schema[exclusive] = bound;
    delete schema[inclusive];
  }
}

/**
 * Rewrite positional array validation. In draft-04/07 a tuple is an array-valued
 * `items` with `additionalItems` covering the rest; 2020-12 renamed those to
 * `prefixItems` and `items`.
 *
 * A bare `additionalItems` with no positional list constrained nothing, so it is
 * dropped rather than promoted to `items` — promoting it would tighten the
 * schema. No `items: false` is synthesised for a closed tuple either: the
 * conversion input already carries the `maxItems` that closes it.
 */
function convertPositionalItems(schema: JsonObject): void {
  const items = schema.items;
  const hasPositionalItems = Array.isArray(items);
  if (hasPositionalItems) {
    delete schema.items;
    schema.prefixItems = items;
  }
  if (!('additionalItems' in schema)) {
    return;
  }
  const additionalItems = schema.additionalItems;
  delete schema.additionalItems;
  if (hasPositionalItems) {
    schema.items = additionalItems;
  }
}

/** Add `null` to whatever the schema already accepts, and drop `nullable`. */
function convertNullable(schema: JsonObject): void {
  const nullable = schema.nullable;
  if (!('nullable' in schema)) {
    return;
  }
  delete schema.nullable;
  if (nullable !== true) {
    return;
  }

  const type = schema.type;
  if (typeof type === 'string') {
    schema.type = type === 'null' ? 'null' : [type, 'null'];
    return;
  }
  if (Array.isArray(type)) {
    if (!type.includes('null')) {
      schema.type = [...type, 'null'];
    }
    return;
  }

  const enumValues = schema.enum;
  if (Array.isArray(enumValues)) {
    // `zod-to-json-schema`'s openApi3 target has no way to say "the null type",
    // so it encodes `z.null()` as the sentinel `{ enum: ['null'], nullable: true }`.
    // Untyped, single-member, and string-valued — the shape is unambiguous, and
    // any real one-value enum arrives carrying its `type`, handled above.
    if (enumValues.length === 1 && enumValues[0] === 'null') {
      delete schema.enum;
      schema.type = 'null';
      return;
    }
    if (!enumValues.includes(null)) {
      schema.enum = [...enumValues, null];
    }
    return;
  }

  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches)) {
      schema[keyword] = [...branches, { type: 'null' }];
      return;
    }
  }

  // No type, no enum, no union to widen — `allOf`, or bare constraints. Wrap the
  // constraints so `null` bypasses them, keeping annotations on the outside.
  const constraints: JsonObject = {};
  const annotations: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (ANNOTATION_KEYWORDS.has(key)) {
      annotations[key] = value;
    } else {
      constraints[key] = value;
    }
  }
  if (Object.keys(constraints).length === 0) {
    // An unconstrained schema already accepts null.
    return;
  }
  for (const key of Object.keys(schema)) {
    delete schema[key];
  }
  Object.assign(schema, annotations, { anyOf: [constraints, { type: 'null' }] });
}

/** A 2020-12 Schema Object carries `examples` as an array; 3.0 carried one `example`. */
function convertExample(schema: JsonObject): void {
  if (!('example' in schema)) {
    return;
  }
  const example = schema.example;
  delete schema.example;
  const existing = Array.isArray(schema.examples) ? schema.examples : [];
  schema.examples = [example, ...existing];
}

/**
 * Convert one OpenAPI 3.0 Schema Object into a JSON Schema 2020-12 schema.
 * Subschemas are converted first so the keyword rewrites below always see
 * already-converted children.
 */
export function toJsonSchema2020(schema: unknown): unknown {
  if (typeof schema === 'boolean' || !isJsonObject(schema)) {
    return schema;
  }
  const out: JsonObject = { ...schema };

  for (const keyword of SUBSCHEMA_LIST_KEYWORDS) {
    const value = out[keyword];
    if (Array.isArray(value)) {
      out[keyword] = value.map(toJsonSchema2020);
    }
  }
  for (const keyword of SUBSCHEMA_MAP_KEYWORDS) {
    const value = out[keyword];
    if (isJsonObject(value)) {
      const converted: JsonObject = {};
      for (const [name, subschema] of Object.entries(value)) {
        converted[name] = toJsonSchema2020(subschema);
      }
      out[keyword] = converted;
    }
  }
  for (const keyword of SUBSCHEMA_KEYWORDS) {
    if (!(keyword in out)) {
      continue;
    }
    const value = out[keyword];
    out[keyword] = Array.isArray(value) ? value.map(toJsonSchema2020) : toJsonSchema2020(value);
  }

  convertExclusiveBound(out, 'exclusiveMinimum', 'minimum');
  convertExclusiveBound(out, 'exclusiveMaximum', 'maximum');
  convertPositionalItems(out);
  convertNullable(out);
  convertExample(out);
  return out;
}

function convertContent(content: unknown): void {
  if (!isJsonObject(content)) {
    return;
  }
  for (const mediaType of Object.values(content)) {
    if (isJsonObject(mediaType) && 'schema' in mediaType) {
      mediaType.schema = toJsonSchema2020(mediaType.schema);
    }
  }
}

/** Parameter and Header Objects have the same schema-bearing shape. */
function convertParameter(parameter: unknown): void {
  if (!isJsonObject(parameter)) {
    return;
  }
  if ('schema' in parameter) {
    parameter.schema = toJsonSchema2020(parameter.schema);
  }
  convertContent(parameter.content);
}

function convertParameters(parameters: unknown): void {
  if (!Array.isArray(parameters)) {
    return;
  }
  for (const parameter of parameters) {
    convertParameter(parameter);
  }
}

function convertRequestBody(requestBody: unknown): void {
  if (isJsonObject(requestBody)) {
    convertContent(requestBody.content);
  }
}

function convertResponse(response: unknown): void {
  if (!isJsonObject(response)) {
    return;
  }
  convertContent(response.content);
  if (isJsonObject(response.headers)) {
    for (const header of Object.values(response.headers)) {
      convertParameter(header);
    }
  }
}

function convertOperation(operation: JsonObject): void {
  convertParameters(operation.parameters);
  convertRequestBody(operation.requestBody);
  if (isJsonObject(operation.responses)) {
    for (const response of Object.values(operation.responses)) {
      convertResponse(response);
    }
  }
}

function convertPathItem(pathItem: unknown): void {
  if (!isJsonObject(pathItem)) {
    return;
  }
  convertParameters(pathItem.parameters);
  for (const [key, value] of Object.entries(pathItem)) {
    if (OPERATION_KEYWORDS.has(key) && isJsonObject(value)) {
      convertOperation(value);
    }
  }
}

function convertComponents(components: unknown): void {
  if (!isJsonObject(components)) {
    return;
  }
  const schemas = components.schemas;
  if (isJsonObject(schemas)) {
    for (const [name, schema] of Object.entries(schemas)) {
      schemas[name] = toJsonSchema2020(schema);
    }
  }
  for (const keyword of ['parameters', 'headers'] as const) {
    const group = components[keyword];
    if (isJsonObject(group)) {
      for (const member of Object.values(group)) {
        convertParameter(member);
      }
    }
  }
  if (isJsonObject(components.requestBodies)) {
    for (const requestBody of Object.values(components.requestBodies)) {
      convertRequestBody(requestBody);
    }
  }
  if (isJsonObject(components.responses)) {
    for (const response of Object.values(components.responses)) {
      convertResponse(response);
    }
  }
  // securitySchemes, examples, links and callbacks hold no Schema Objects.
}

/**
 * Convert an assembled OpenAPI 3.0 document into the equivalent 3.1 document.
 * The input is left untouched; the caller receives a deep copy.
 */
export function toOpenApi31Document(doc: OpenApi31ConvertibleDocument): OpenApi31ConvertibleDocument {
  const { openapi: _openapi30, ...rest } = structuredClone(doc);
  const out: OpenApi31ConvertibleDocument = {
    openapi: '3.1.0',
    jsonSchemaDialect: JSON_SCHEMA_2020_12_DIALECT,
    ...rest,
  };

  for (const pathItem of Object.values(out.paths)) {
    convertPathItem(pathItem);
  }
  convertComponents(out.components);
  return out;
}
