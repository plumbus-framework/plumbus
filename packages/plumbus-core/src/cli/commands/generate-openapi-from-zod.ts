import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { CapabilityContract } from '../../types/capability.js';
import type { CapabilityKind } from '../../types/enums.js';
import { toKebabCase } from '../utils.js';

type JsonSchema = Record<string, unknown>;

/** Convert a Zod schema to an OpenAPI 3 object schema (no `$schema` wrapper). */
export function zodToGenerateOpenApiSchema(schema: z.ZodTypeAny): JsonSchema {
  const json = zodToJsonSchema(schema, {
    $refStrategy: 'none',
    target: 'openApi3',
  }) as JsonSchema;
  const { $schema: _schema, ...rest } = json;
  return rest;
}

function inputObjectSchema(schema: z.ZodTypeAny): JsonSchema | undefined {
  const json = zodToGenerateOpenApiSchema(schema);
  if (json.type === 'object' && typeof json.properties === 'object' && json.properties !== null) {
    return json;
  }
  return undefined;
}

function pathParamNames(urlPath: string): string[] {
  return [...urlPath.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? '');
}

export function buildGenerateQueryParameters(
  inputSchema: z.ZodTypeAny,
  urlPath: string,
): Record<string, unknown>[] {
  const objectSchema = inputObjectSchema(inputSchema);
  if (!objectSchema?.properties) {
    return [];
  }

  const pathParams = new Set(pathParamNames(urlPath));
  const required = new Set(
    Array.isArray(objectSchema.required) ? (objectSchema.required as string[]) : [],
  );
  const properties = objectSchema.properties as Record<string, JsonSchema>;

  const parameters: Record<string, unknown>[] = [];
  for (const [name, fieldSchema] of Object.entries(properties)) {
    if (pathParams.has(name)) {
      continue;
    }
    parameters.push({
      in: 'query',
      name,
      required: required.has(name),
      schema: fieldSchema,
    });
  }
  return parameters;
}

export function buildGenerateRequestBodySchema(
  inputSchema: z.ZodTypeAny,
  urlPath: string,
): JsonSchema {
  const objectSchema = inputObjectSchema(inputSchema);
  if (!objectSchema?.properties) {
    return zodToGenerateOpenApiSchema(inputSchema);
  }

  const pathParams = new Set(pathParamNames(urlPath));
  const required = new Set(
    Array.isArray(objectSchema.required) ? (objectSchema.required as string[]) : [],
  );
  const properties = objectSchema.properties as Record<string, JsonSchema>;

  const bodyProperties: Record<string, JsonSchema> = {};
  const bodyRequired: string[] = [];
  for (const [name, fieldSchema] of Object.entries(properties)) {
    if (pathParams.has(name)) {
      continue;
    }
    bodyProperties[name] = fieldSchema;
    if (required.has(name)) {
      bodyRequired.push(name);
    }
  }

  const schema: JsonSchema = {
    type: 'object',
    properties: bodyProperties,
  };
  if (bodyRequired.length > 0) {
    schema.required = bodyRequired;
  }
  return schema;
}

export function buildGeneratePathParameters(
  inputSchema: z.ZodTypeAny,
  urlPath: string,
): Record<string, unknown>[] {
  const objectSchema = inputObjectSchema(inputSchema);
  const properties = (objectSchema?.properties ?? {}) as Record<string, JsonSchema>;

  return pathParamNames(urlPath)
    .filter((name) => name.length > 0)
    .map((name) => ({
      in: 'path',
      name,
      required: true,
      schema: properties[name] ?? { type: 'string' },
    }));
}

/** Generate an OpenAPI path entry with Zod-derived parameters, body, and response. */
export function generateOpenApiPath(cap: CapabilityContract): Record<string, unknown> {
  const kind = cap.kind as CapabilityKind;
  const method = kind === 'query' ? 'get' : 'post';
  const urlPath = `/api/${cap.domain}/${toKebabCase(cap.name)}`;
  const pathParameters = buildGeneratePathParameters(cap.input, urlPath);
  const queryParameters =
    method === 'get' ? buildGenerateQueryParameters(cap.input, urlPath) : [];
  const parameters = [...pathParameters, ...queryParameters];

  const operation: Record<string, unknown> = {
    operationId: cap.name,
    summary: cap.description ?? cap.name,
    tags: [cap.domain],
    responses: {
      '200': {
        description: 'Successful response',
        content: {
          'application/json': { schema: zodToGenerateOpenApiSchema(cap.output) },
        },
      },
    },
  };

  if (parameters.length > 0) {
    operation.parameters = parameters;
  }

  if (method !== 'get') {
    operation.requestBody = {
      required: true,
      content: {
        'application/json': { schema: buildGenerateRequestBodySchema(cap.input, urlPath) },
      },
    };
  }

  return {
    [urlPath]: {
      [method]: operation,
    },
  };
}
