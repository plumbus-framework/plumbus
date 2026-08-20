import { defineCapability } from '@plumbus/core';
import { Validator } from '@seriousme/openapi-schema-validator';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ApiManifest } from '../../manifest/types.js';
import { generateOpenApi } from '../generate.js';
import { toJsonSchema2020 } from '../openapi-3-1.js';
import { parseOpenApiDocument, serializeOpenApiDocument } from '../serialize.js';
import type { OpenApiDocument } from '../types.js';
import { DEFAULT_OPENAPI_VERSION, JSON_SCHEMA_2020_12_DIALECT } from '../version.js';

// ── Fixtures ───────────────────────────────────────────────────────────────────
//
// One capability set, generated at both document versions. Its schemas carry every
// 3.0 construct this generator emits that 3.1 spells differently: `nullable`, both
// boolean exclusive bounds, the `z.null()` sentinel, a nullable union, a closed
// tuple and a tuple with a rest element.
//
// The tuple capability is kept separate because array-valued `items` — what the
// 3.0 target emits for a tuple — is not valid OpenAPI 3.0 in the first place (see
// the "positional array validation" test at the bottom). The other two make up the
// portable set used wherever both documents have to validate.

function readEntry() {
  return defineCapability({
    name: 'readEntry',
    kind: 'query',
    domain: 'ledger',
    description: 'Read one ledger entry',
    input: z.object({
      entryId: z.string(),
      note: z.string().nullable(),
      amount: z.number().gt(0).lt(1000),
      marker: z.null(),
    }),
    output: z.object({
      entryId: z.string(),
      note: z.string().nullable(),
      owner: z.union([z.string(), z.number()]).nullable(),
    }),
    effects: { data: [], events: [], external: [], ai: false },
    exposeAs: ['api'],
    api: { operationId: 'readEntry', method: 'GET', path: '/entries/{entryId}' },
    handler: async (_ctx, input) => ({ entryId: input.entryId, note: null, owner: null }),
  });
}

function settleEntry() {
  return defineCapability({
    name: 'settleEntry',
    kind: 'action',
    domain: 'ledger',
    description: 'Settle one ledger entry',
    input: z.object({
      entryId: z.string(),
      note: z.string().nullable(),
      amount: z.number().gt(0),
    }),
    output: z.object({ entryId: z.string(), settled: z.boolean() }),
    effects: { data: [], events: [], external: [], ai: false },
    exposeAs: ['api'],
    api: { operationId: 'settleEntry', method: 'POST', path: '/entries/{entryId}/settle' },
    handler: async (_ctx, input) => ({ entryId: input.entryId, settled: true }),
  });
}

function readWindow() {
  return defineCapability({
    name: 'readWindow',
    kind: 'query',
    domain: 'ledger',
    description: 'Read the window covering one ledger entry',
    input: z.object({
      entryId: z.string(),
      window: z.tuple([z.string(), z.string()]),
    }),
    output: z.object({ labels: z.tuple([z.string()]).rest(z.string()) }),
    effects: { data: [], events: [], external: [], ai: false },
    exposeAs: ['api'],
    api: { operationId: 'readWindow', method: 'GET', path: '/entries/{entryId}/window' },
    handler: async () => ({ labels: ['primary'] as [string, ...string[]] }),
  });
}

const securitySchemes: ApiManifest['securitySchemes'] = {
  partnerOAuth: {
    type: 'oauth2',
    flows: {
      clientCredentials: {
        tokenUrl: 'https://identity.example.com/oauth2/token',
        scopes: { 'entries:read': 'Read entries' },
      },
    },
  },
};

const portableManifest: ApiManifest = {
  apiVersion: 'plumbus.dev/v1',
  name: 'ledger-api',
  basePath: '/api/v1',
  identity: { defaultSecurityScheme: 'partnerOAuth', audience: 'partners' },
  securitySchemes,
  expose: [
    {
      capability: 'ledger.readEntry',
      operationId: 'readEntry',
      method: 'GET',
      path: '/entries/{entryId}',
      auth: { scopes: ['entries:read'] },
    },
    {
      capability: 'ledger.settleEntry',
      operationId: 'settleEntry',
      method: 'POST',
      path: '/entries/{entryId}/settle',
    },
  ],
};

const manifest: ApiManifest = {
  ...portableManifest,
  expose: [
    ...portableManifest.expose,
    {
      capability: 'ledger.readWindow',
      operationId: 'readWindow',
      method: 'GET',
      path: '/entries/{entryId}/window',
      auth: { scopes: ['entries:read'] },
    },
  ],
};

type Version = '3.0.3' | '3.1.0';

const capabilities = () => [readEntry(), settleEntry(), readWindow()];
const portableCapabilities = () => [readEntry(), settleEntry()];

const generate = (version?: Version) =>
  version === undefined
    ? generateOpenApi(capabilities(), manifest)
    : generateOpenApi(capabilities(), manifest, { version });

const generatePortable = (version: Version) =>
  generateOpenApi(portableCapabilities(), portableManifest, { version });

// ── Document navigation ────────────────────────────────────────────────────────

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function operation(doc: OpenApiDocument, path: string, method: string): JsonObject {
  const pathItem = doc.paths[path];
  if (!isJsonObject(pathItem) || !isJsonObject(pathItem[method])) {
    throw new Error(`no ${method.toUpperCase()} ${path} in document`);
  }
  return pathItem[method];
}

function parameterSchema(op: JsonObject, name: string): JsonObject {
  const parameters = Array.isArray(op.parameters) ? op.parameters : [];
  const match = parameters.find((p) => isJsonObject(p) && p.name === name);
  if (!isJsonObject(match) || !isJsonObject(match.schema)) {
    throw new Error(`no parameter "${name}"`);
  }
  return match.schema;
}

function jsonSchemaOf(container: unknown): JsonObject {
  if (!isJsonObject(container) || !isJsonObject(container.content)) {
    throw new Error('no content on this object');
  }
  const mediaType = container.content['application/json'];
  if (!isJsonObject(mediaType) || !isJsonObject(mediaType.schema)) {
    throw new Error('no application/json schema');
  }
  return mediaType.schema;
}

function requestBodySchema(op: JsonObject): JsonObject {
  return jsonSchemaOf(op.requestBody);
}

/** The `data` schema carried by the inline branch of the 200 response envelope. */
function successDataSchema(op: JsonObject): JsonObject {
  const responses = isJsonObject(op.responses) ? op.responses : {};
  const schema = jsonSchemaOf(responses['200']);
  const branches = Array.isArray(schema.allOf) ? schema.allOf : [];
  const inline = branches.find((b) => isJsonObject(b) && isJsonObject(b.properties));
  if (!isJsonObject(inline) || !isJsonObject(inline.properties)) {
    throw new Error('no inline data branch on the 200 response');
  }
  const data = inline.properties.data;
  if (!isJsonObject(data)) {
    throw new Error('no data schema on the 200 response');
  }
  return data;
}

function property(schema: JsonObject, name: string): JsonObject {
  const properties = isJsonObject(schema.properties) ? schema.properties : {};
  const value = properties[name];
  if (!isJsonObject(value)) {
    throw new Error(`no property "${name}"`);
  }
  return value;
}

/** Every Schema Object the document contains, in document order. */
function collectSchemas(doc: OpenApiDocument): JsonObject[] {
  const found: JsonObject[] = [];
  const components = isJsonObject(doc.components) ? doc.components : {};
  const schemas = isJsonObject(components.schemas) ? components.schemas : {};
  for (const schema of Object.values(schemas)) {
    if (isJsonObject(schema)) {
      found.push(schema);
    }
  }
  for (const pathItem of Object.values(doc.paths)) {
    for (const op of Object.values(pathItem)) {
      if (!isJsonObject(op)) {
        continue;
      }
      for (const parameter of Array.isArray(op.parameters) ? op.parameters : []) {
        if (isJsonObject(parameter) && isJsonObject(parameter.schema)) {
          found.push(parameter.schema);
        }
      }
      if (op.requestBody !== undefined) {
        found.push(requestBodySchema(op));
      }
      const responses = isJsonObject(op.responses) ? op.responses : {};
      for (const response of Object.values(responses)) {
        found.push(jsonSchemaOf(response));
      }
    }
  }
  return found;
}

/** Does `predicate` hold for any object anywhere in the document? */
function someNode(node: unknown, predicate: (value: JsonObject) => boolean): boolean {
  if (Array.isArray(node)) {
    return node.some((child) => someNode(child, predicate));
  }
  if (!isJsonObject(node)) {
    return false;
  }
  return predicate(node) || Object.values(node).some((child) => someNode(child, predicate));
}

// ── Validators ─────────────────────────────────────────────────────────────────

/**
 * Validate a whole document against the published OpenAPI schema for the version
 * it declares. `@seriousme/openapi-schema-validator` ships the 3.0 and 3.1 schemas
 * and selects between them from the document's own version field, so the returned
 * `version` also proves which contract the document was judged against.
 */
async function validateDocument(doc: unknown, expectedVersion: string): Promise<void> {
  const validator = new Validator();
  const result = await validator.validate(doc as Record<string, unknown>);
  expect(result.errors ?? []).toEqual([]);
  expect(result.valid).toBe(true);
  expect(validator.version).toBe(expectedVersion);
}

async function documentErrors(doc: unknown): Promise<unknown[]> {
  const validator = new Validator();
  const result = await validator.validate(doc as Record<string, unknown>);
  if (result.valid) {
    return [];
  }
  return Array.isArray(result.errors) ? result.errors : [result.errors];
}

function resolvePointer(doc: OpenApiDocument, ref: string): unknown {
  const segments = ref.replace(/^#\//, '').split('/');
  let node: unknown = doc;
  for (const segment of segments) {
    if (!isJsonObject(node)) {
      throw new Error(`cannot resolve ${ref}`);
    }
    node = node[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return node;
}

/**
 * Replace document-internal `$ref`s with their targets so a Schema Object can be
 * handed to a plain JSON Schema implementation, which knows nothing about
 * `#/components/schemas/...`. The envelope components reference nothing, so this
 * terminates.
 */
function inlineRefs(doc: OpenApiDocument, node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((child) => inlineRefs(doc, child));
  }
  if (!isJsonObject(node)) {
    return node;
  }
  if (typeof node.$ref === 'string') {
    return inlineRefs(doc, resolvePointer(doc, node.$ref));
  }
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = inlineRefs(doc, value);
  }
  return out;
}

/**
 * Compile a schema as JSON Schema 2020-12 in Ajv's strict mode. Strict mode is
 * what makes this a dialect check rather than a shape check: it rejects keywords
 * that are not part of 2020-12 (`additionalItems`, `example`), while the 2020-12
 * meta-schema rejects the draft-04 spellings (boolean `exclusiveMinimum`,
 * array-valued `items`).
 *
 * `strictTuples` is off: it insists a `prefixItems` list be closed by `maxItems`
 * or `items: false`, which would reject a tuple with a rest element — a shape
 * 2020-12 allows and `z.tuple().rest()` legitimately produces.
 */
function compileAs2020(schema: unknown): void {
  const ajv = new Ajv2020({ strict: true, strictTuples: false, validateFormats: false });
  ajv.compile(schema as object);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('generateOpenApi version option', () => {
  it('defaults to 3.0.3 and emits no jsonSchemaDialect', () => {
    const doc = generate();
    expect(doc.openapi).toBe('3.0.3');
    expect(DEFAULT_OPENAPI_VERSION).toBe('3.0.3');
    expect(doc.jsonSchemaDialect).toBeUndefined();
  });

  it('emits the same document for an explicit 3.0.3 as for no option at all', () => {
    expect(generate('3.0.3')).toEqual(generate());
  });

  it('emits 3.1.0 with the 2020-12 dialect declared at the root', () => {
    const doc = generate('3.1.0');
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.jsonSchemaDialect).toBe(JSON_SCHEMA_2020_12_DIALECT);
  });

  it('rejects a version it cannot emit', () => {
    expect(() => generateOpenApi(capabilities(), manifest, { version: '3.2.0' as never })).toThrow(
      /Unsupported OpenAPI version "3\.2\.0"/,
    );
  });

  it('leaves the same operations, parameters and security in place at both versions', () => {
    const doc30 = generate('3.0.3');
    const doc31 = generate('3.1.0');
    expect(Object.keys(doc31.paths)).toEqual(Object.keys(doc30.paths));

    const get30 = operation(doc30, '/entries/{entryId}', 'get');
    const get31 = operation(doc31, '/entries/{entryId}', 'get');
    expect(get31.operationId).toBe(get30.operationId);
    expect(get31.security).toEqual(get30.security);
    expect(Object.keys(get31.responses as JsonObject)).toEqual(
      Object.keys(get30.responses as JsonObject),
    );
    const names30 = (get30.parameters as JsonObject[]).map((p) => `${p.in}:${p.name}`);
    const names31 = (get31.parameters as JsonObject[]).map((p) => `${p.in}:${p.name}`);
    expect(names31).toEqual(names30);
    expect(doc31.components?.securitySchemes).toEqual(doc30.components?.securitySchemes);
    expect(doc31.info).toEqual(doc30.info);
    expect(doc31.servers).toEqual(doc30.servers);
  });
});

describe('OpenAPI 3.0 → 3.1 schema differences', () => {
  const doc30 = generate('3.0.3');
  const doc31 = generate('3.1.0');
  const get30 = operation(doc30, '/entries/{entryId}', 'get');
  const get31 = operation(doc31, '/entries/{entryId}', 'get');
  const post30 = operation(doc30, '/entries/{entryId}/settle', 'post');
  const post31 = operation(doc31, '/entries/{entryId}/settle', 'post');
  const window30 = operation(doc30, '/entries/{entryId}/window', 'get');
  const window31 = operation(doc31, '/entries/{entryId}/window', 'get');

  it('3.0 states nullability with the nullable keyword', () => {
    expect(parameterSchema(get30, 'note')).toEqual({ type: 'string', nullable: true });
  });

  it('3.1 states nullability as a null member of type', () => {
    expect(parameterSchema(get31, 'note')).toEqual({ type: ['string', 'null'] });
  });

  it('3.1 carries no nullable keyword anywhere in the document', () => {
    expect(someNode(doc30, (node) => node.nullable === true)).toBe(true);
    expect(someNode(doc31, (node) => 'nullable' in node)).toBe(false);
  });

  it('3.0 states exclusive bounds as booleans beside the inclusive bound', () => {
    expect(parameterSchema(get30, 'amount')).toEqual({
      type: 'number',
      exclusiveMinimum: true,
      minimum: 0,
      exclusiveMaximum: true,
      maximum: 1000,
    });
  });

  it('3.1 states exclusive bounds as numbers', () => {
    expect(parameterSchema(get31, 'amount')).toEqual({
      type: 'number',
      exclusiveMinimum: 0,
      exclusiveMaximum: 1000,
    });
  });

  it('3.1 states a closed tuple as prefixItems', () => {
    expect(parameterSchema(window30, 'window')).toEqual({
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: [{ type: 'string' }, { type: 'string' }],
    });
    expect(parameterSchema(window31, 'window')).toEqual({
      type: 'array',
      minItems: 2,
      maxItems: 2,
      prefixItems: [{ type: 'string' }, { type: 'string' }],
    });
  });

  it('3.1 states a tuple rest element as items beside prefixItems', () => {
    expect(property(successDataSchema(window30), 'labels')).toEqual({
      type: 'array',
      minItems: 1,
      items: [{ type: 'string' }],
      additionalItems: { type: 'string' },
    });
    expect(property(successDataSchema(window31), 'labels')).toEqual({
      type: 'array',
      minItems: 1,
      prefixItems: [{ type: 'string' }],
      items: { type: 'string' },
    });
  });

  it('3.1 states the null type directly instead of the 3.0 enum sentinel', () => {
    expect(parameterSchema(get30, 'marker')).toEqual({ enum: ['null'], nullable: true });
    expect(parameterSchema(get31, 'marker')).toEqual({ type: 'null' });
  });

  it('3.1 widens a nullable union with a null branch', () => {
    expect(property(successDataSchema(get30), 'owner')).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
      nullable: true,
    });
    expect(property(successDataSchema(get31), 'owner')).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }],
    });
  });

  it('converts request-body schemas as well as parameters and responses', () => {
    expect(property(requestBodySchema(post30), 'note')).toEqual({
      type: 'string',
      nullable: true,
    });
    expect(property(requestBodySchema(post31), 'note')).toEqual({ type: ['string', 'null'] });
    expect(property(requestBodySchema(post31), 'amount')).toEqual({
      type: 'number',
      exclusiveMinimum: 0,
    });
  });

  it('leaves the shared envelope components structurally identical', () => {
    const schemas30 = (doc30.components as JsonObject).schemas as JsonObject;
    const schemas31 = (doc31.components as JsonObject).schemas as JsonObject;
    expect(schemas31.ApiErrorEnvelope).toEqual(schemas30.ApiErrorEnvelope);
    expect(schemas31.ApiSuccessEnvelope).toEqual(schemas30.ApiSuccessEnvelope);
  });
});

describe('toJsonSchema2020', () => {
  it('turns a schema-object example into a 2020-12 examples array', () => {
    expect(toJsonSchema2020({ type: 'string', example: 'ent_1' })).toEqual({
      type: 'string',
      examples: ['ent_1'],
    });
  });

  it('prepends the example to an examples array that is already present', () => {
    expect(toJsonSchema2020({ type: 'string', example: 'a', examples: ['b'] })).toEqual({
      type: 'string',
      examples: ['a', 'b'],
    });
  });

  it('adds null to an enum that has no type to widen', () => {
    expect(toJsonSchema2020({ enum: ['a', 'b'], nullable: true })).toEqual({
      enum: ['a', 'b', null],
    });
  });

  it('wraps an allOf in anyOf and keeps annotations outside', () => {
    expect(
      toJsonSchema2020({
        description: 'either shape, or nothing',
        allOf: [{ type: 'object' }],
        nullable: true,
      }),
    ).toEqual({
      description: 'either shape, or nothing',
      anyOf: [{ allOf: [{ type: 'object' }] }, { type: 'null' }],
    });
  });

  it('drops a false nullable rather than widening the type', () => {
    expect(toJsonSchema2020({ type: 'string', nullable: false })).toEqual({ type: 'string' });
  });

  it('drops an exclusive-bound flag that was false', () => {
    expect(toJsonSchema2020({ type: 'number', exclusiveMinimum: false, minimum: 3 })).toEqual({
      type: 'number',
      minimum: 3,
    });
  });

  it('leaves an already-numeric exclusive bound alone', () => {
    expect(toJsonSchema2020({ type: 'number', exclusiveMinimum: 3 })).toEqual({
      type: 'number',
      exclusiveMinimum: 3,
    });
  });

  it('drops additionalItems that constrains no positional list', () => {
    expect(toJsonSchema2020({ type: 'array', additionalItems: { type: 'string' } })).toEqual({
      type: 'array',
    });
  });

  it('converts nested subschemas', () => {
    expect(
      toJsonSchema2020({
        type: 'object',
        properties: { a: { type: 'string', nullable: true } },
        additionalProperties: { type: 'number', exclusiveMinimum: true, minimum: 0 },
      }),
    ).toEqual({
      type: 'object',
      properties: { a: { type: ['string', 'null'] } },
      additionalProperties: { type: 'number', exclusiveMinimum: 0 },
    });
  });

  it('leaves boolean schemas alone', () => {
    expect(toJsonSchema2020(false)).toBe(false);
  });
});

describe('generated documents validate', () => {
  it('validates the 3.0.3 document against the published OpenAPI 3.0 schema', async () => {
    await validateDocument(generatePortable('3.0.3'), '3.0');
  });

  it('validates the 3.1.0 document against the published OpenAPI 3.1 schema', async () => {
    await validateDocument(generatePortable('3.1.0'), '3.1');
    await validateDocument(generate('3.1.0'), '3.1');
  });

  it('validates both after a JSON round trip', async () => {
    for (const [version, expected] of [
      ['3.0.3', '3.0'],
      ['3.1.0', '3.1'],
    ] as const) {
      const doc = generatePortable(version);
      const parsed = parseOpenApiDocument(serializeOpenApiDocument(doc, 'json'), 'spec.json');
      expect(parsed).toEqual(doc);
      await validateDocument(parsed, expected);
    }
  });

  it('validates both after a YAML round trip', async () => {
    for (const [version, expected] of [
      ['3.0.3', '3.0'],
      ['3.1.0', '3.1'],
    ] as const) {
      const doc = generatePortable(version);
      const parsed = parseOpenApiDocument(serializeOpenApiDocument(doc, 'yaml'), 'spec.yaml');
      await validateDocument(parsed, expected);
    }
  });

  it('compiles every 3.1 Schema Object as strict JSON Schema 2020-12', () => {
    const doc = generate('3.1.0');
    const schemas = collectSchemas(doc);
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      expect(() => compileAs2020(inlineRefs(doc, schema))).not.toThrow();
    }
  });

  it('rejects the 3.0.3 Schema Objects as 2020-12, proving the check discriminates', () => {
    const doc = generate('3.0.3');
    const rejected = collectSchemas(doc).filter((schema) => {
      try {
        compileAs2020(inlineRefs(doc, schema));
        return false;
      } catch {
        return true;
      }
    });
    expect(rejected.length).toBeGreaterThan(0);
  });

  it('fixes positional array validation, which 3.0 could not express at all', async () => {
    // `zod-to-json-schema`'s openApi3 target emits a tuple as an array-valued
    // `items`. OpenAPI 3.0's Schema Object has no positional array form, so that
    // document does not validate — a defect that predates 3.1 emission and is not
    // introduced by it. 3.1 has `prefixItems`, so the same capability set comes
    // out valid. If the 3.0 tuple emission is ever corrected, this test is the
    // place that records it.
    const errors30 = await documentErrors(generate('3.0.3'));
    expect(errors30.length).toBeGreaterThan(0);
    expect(JSON.stringify(errors30)).toContain('/schema/items');
    await validateDocument(generate('3.1.0'), '3.1');
  });
});
