import type { z } from 'zod';
import { extractPathParamNames } from '../manifest/path-params.js';
import { zodToOpenApiSchema } from './zod-to-openapi-schema.js';

type JsonSchema = Record<string, unknown>;

function inputObjectSchema(schema: z.ZodTypeAny): JsonSchema | undefined {
  const json = zodToOpenApiSchema(schema);
  if (json.type === 'object' && typeof json.properties === 'object' && json.properties !== null) {
    return json;
  }
  return undefined;
}

/** Build OpenAPI query parameters (one per non-path input field) for GET operations. */
export function buildGetQueryParameters(
  inputSchema: z.ZodTypeAny,
  path: string,
): Record<string, unknown>[] {
  const objectSchema = inputObjectSchema(inputSchema);
  if (!objectSchema?.properties) {
    return [];
  }

  const pathParams = new Set(extractPathParamNames(path));
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

/** Build request body schema for non-GET operations, omitting path-parameter fields. */
export function buildRequestBodySchema(inputSchema: z.ZodTypeAny, path: string): JsonSchema {
  const objectSchema = inputObjectSchema(inputSchema);
  if (!objectSchema?.properties) {
    return zodToOpenApiSchema(inputSchema);
  }

  const pathParams = new Set(extractPathParamNames(path));
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

/** Build OpenAPI path parameters from `{param}` tokens in the route path. */
export function buildPathParameters(
  inputSchema: z.ZodTypeAny,
  path: string,
): Record<string, unknown>[] {
  const objectSchema = inputObjectSchema(inputSchema);
  const properties = (objectSchema?.properties ?? {}) as Record<string, JsonSchema>;

  return extractPathParamNames(path).map((name) => ({
    in: 'path',
    name,
    required: true,
    schema: properties[name] ?? { type: 'string' },
  }));
}
