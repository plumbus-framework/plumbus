import { isApiExposed, type CapabilityContract } from '@plumbus/core';
import { apiVersionFromManifest } from '../manifest/api-version.js';
import { resolveExposure } from '../manifest/resolve.js';
import { requiredApiScopes } from '../manifest/scopes.js';
import {
  buildGetQueryParameters,
  buildPathParameters,
  buildRequestBodySchema,
} from './schema-params.js';
import { zodToOpenApiSchema } from './zod-to-openapi-schema.js';
import type { ApiManifest, ApiManifestEntry } from '../manifest/types.js';
import type { OpenApiDocument } from './types.js';

function methodToOpenApi(method: string): string {
  return method.toLowerCase();
}

function findManifestEntry(
  manifest: ApiManifest,
  cap: CapabilityContract,
): ApiManifestEntry | undefined {
  const key = `${cap.domain}.${cap.name}`;
  return manifest.expose.find((e) => e.capability === key);
}

function errorResponseRef(): Record<string, unknown> {
  return {
    description: 'Error response',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/ApiErrorEnvelope' },
      },
    },
  };
}

export function generateOpenApi(
  caps: CapabilityContract[],
  manifest: ApiManifest,
): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};
  const apiVersion = apiVersionFromManifest(manifest);
  const allScopes = new Set<string>();
  const registeredMethodPaths = new Set<string>();

  for (const cap of caps) {
    if (!isApiExposed(cap)) {
      continue;
    }

    const entry = findManifestEntry(manifest, cap);
    const resolved = resolveExposure(cap, entry);
    const routePath = resolved.path;
    const oaMethod = methodToOpenApi(resolved.method);
    const methodPathKey = `${oaMethod}:${routePath}`;

    if (registeredMethodPaths.has(methodPathKey)) {
      console.warn(
        `[plumbus/api] Duplicate method+path ${resolved.method} ${routePath} — later operation "${resolved.operationId}" overwrites earlier definition`,
      );
    } else {
      registeredMethodPaths.add(methodPathKey);
    }

    const operation: Record<string, unknown> = {
      operationId: resolved.operationId,
      summary: resolved.docs?.summary ?? cap.description ?? cap.name,
      description: resolved.docs?.description,
      tags: resolved.docs?.tags ?? [cap.domain],
      deprecated: resolved.stability === 'deprecated',
      responses: {
        '200': {
          description: 'Successful response',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/ApiSuccessEnvelope' },
                  {
                    type: 'object',
                    properties: {
                      data: zodToOpenApiSchema(cap.output),
                    },
                  },
                ],
              },
            },
          },
        },
        '400': errorResponseRef(),
        '401': errorResponseRef(),
        '403': errorResponseRef(),
        '404': errorResponseRef(),
        '409': errorResponseRef(),
        '500': errorResponseRef(),
      },
    };

    const scopes = requiredApiScopes(resolved.auth?.scopes, cap.access?.scopes);
    if (scopes.length > 0) {
      for (const scope of scopes) {
        allScopes.add(scope);
      }
      operation.security = [{ oauth2: scopes }];
    }

    if (resolved.idempotency) {
      operation['x-plumbus-idempotency'] = resolved.idempotency;
    }

    if (resolved.test) {
      operation['x-plumbus-test'] = resolved.test;
    }

    const pathParameters = buildPathParameters(cap.input, routePath);
    const queryParameters =
      resolved.method === 'GET' ? buildGetQueryParameters(cap.input, routePath) : [];
    const allParameters = [...pathParameters, ...queryParameters];
    if (allParameters.length > 0) {
      operation.parameters = allParameters;
    }

    if (resolved.method !== 'GET') {
      operation.requestBody = {
        required: true,
        content: {
          'application/json': {
            schema: buildRequestBodySchema(cap.input, routePath),
          },
        },
      };
    }

    if (paths[routePath] === undefined) {
      paths[routePath] = {};
    }
    paths[routePath][oaMethod] = operation;
  }

  const securitySchemes: Record<string, unknown> = {};
  const useOAuth2 = manifest.identity?.defaultAuth === 'oauth2' || allScopes.size > 0;

  if (useOAuth2) {
    const scopeEntries: Record<string, string> = {};
    for (const scope of allScopes) {
      scopeEntries[scope] = scope;
    }
    securitySchemes.oauth2 = {
      type: 'oauth2',
      flows: {
        clientCredentials: {
          tokenUrl: '/oauth/token',
          scopes: scopeEntries,
        },
      },
    };
  } else if (manifest.identity?.defaultAuth) {
    securitySchemes.bearerAuth = {
      type: 'http',
      scheme: 'bearer',
    };
  }

  return {
    openapi: '3.0.3',
    info: {
      title: manifest.name,
      version: apiVersion,
      description: manifest.identity?.audience
        ? `Audience: ${manifest.identity.audience}`
        : undefined,
    },
    servers: [{ url: manifest.basePath }],
    paths,
    components: {
      schemas: {
        ApiErrorEnvelope: {
          type: 'object',
          required: ['ok', 'error', 'meta'],
          properties: {
            ok: { type: 'boolean', enum: [false] },
            error: {
              type: 'object',
              required: ['code', 'message', 'requestId'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                details: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      path: { type: 'string' },
                      message: { type: 'string' },
                    },
                  },
                },
                requestId: { type: 'string' },
              },
            },
            meta: {
              type: 'object',
              properties: { apiVersion: { type: 'string' } },
            },
          },
        },
        ApiSuccessEnvelope: {
          type: 'object',
          required: ['ok', 'data', 'meta'],
          properties: {
            ok: { type: 'boolean', enum: [true] },
            data: { type: 'object' },
            meta: {
              type: 'object',
              properties: {
                requestId: { type: 'string' },
                apiVersion: { type: 'string' },
              },
            },
          },
        },
      },
      securitySchemes,
    },
  };
}
