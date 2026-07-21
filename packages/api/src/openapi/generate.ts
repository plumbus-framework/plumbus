import { isApiExposed, type CapabilityContract } from '@plumbus/core';
import { apiVersionFromManifest } from '../manifest/api-version.js';
import { resolveExposure } from '../manifest/resolve.js';
import { requiredApiScopes } from '../manifest/scopes.js';
import type { ApiManifest, ApiManifestEntry, SecurityScheme } from '../manifest/types.js';
import {
  buildGetQueryParameters,
  buildPathParameters,
  buildRequestBodySchema,
} from './schema-params.js';
import { zodToOpenApiSchema } from './zod-to-openapi-schema.js';
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

function defaultSchemeName(manifest: ApiManifest): string | undefined {
  return manifest.identity?.defaultSecurityScheme ?? manifest.identity?.defaultAuth;
}

const LEGACY_BEARER_SCHEME = 'bearer';

function usesLegacyDefaultAuth(manifest: ApiManifest): boolean {
  return Boolean(manifest.identity?.defaultAuth && !manifest.identity.defaultSecurityScheme);
}

function normalizeSchemeNames(
  scheme: string | readonly string[] | undefined,
  manifest: ApiManifest,
): string[] {
  if (typeof scheme === 'string') {
    return [scheme];
  }
  if (Array.isArray(scheme)) {
    return [...scheme];
  }
  const defaultScheme = defaultSchemeName(manifest);
  if (!defaultScheme) {
    return [];
  }
  if (usesLegacyDefaultAuth(manifest) && !manifest.securitySchemes) {
    return [LEGACY_BEARER_SCHEME];
  }
  return [defaultScheme];
}

function schemeAcceptsOAuthScopes(scheme: SecurityScheme | undefined): boolean {
  return scheme?.type === 'oauth2' || scheme?.type === 'openIdConnect';
}

function securitySchemeToOpenApi(scheme: SecurityScheme): Record<string, unknown> {
  switch (scheme.type) {
    case 'http':
      return {
        type: 'http',
        scheme: scheme.scheme,
        ...(scheme.bearerFormat ? { bearerFormat: scheme.bearerFormat } : {}),
      };
    case 'apiKey':
      return {
        type: 'apiKey',
        in: scheme.in,
        name: scheme.name,
        ...(scheme['x-plumbus-csrf'] ? { 'x-plumbus-csrf': scheme['x-plumbus-csrf'] } : {}),
      };
    case 'oauth2':
      return {
        type: 'oauth2',
        flows: scheme.flows,
      };
    case 'openIdConnect':
      return {
        type: 'openIdConnect',
        openIdConnectUrl: scheme.openIdConnectUrl,
      };
    default:
      return scheme;
  }
}

function buildSecuritySchemes(manifest: ApiManifest): Record<string, unknown> {
  const schemes: Record<string, unknown> = {};
  if (manifest.securitySchemes) {
    for (const [name, scheme] of Object.entries(manifest.securitySchemes)) {
      schemes[name] = securitySchemeToOpenApi(scheme);
    }
    return schemes;
  }

  if (usesLegacyDefaultAuth(manifest)) {
    console.warn(
      '[plumbus/api] identity.defaultAuth is deprecated; emitting http bearer security scheme for OpenAPI export',
    );
    schemes[LEGACY_BEARER_SCHEME] = { type: 'http', scheme: 'bearer' };
  }
  return schemes;
}

function resolveOperationSecurity(
  manifest: ApiManifest,
  entry: ApiManifestEntry | undefined,
  cap: CapabilityContract,
): { security?: Record<string, string[]>[]; requiredScopes?: string[] } {
  const scopes = requiredApiScopes(entry?.auth?.scopes, cap.access?.scopes);
  const schemeNames = normalizeSchemeNames(entry?.auth?.scheme, manifest);
  if (schemeNames.length === 0) {
    return scopes.length > 0 ? { requiredScopes: scopes } : {};
  }

  const security: Record<string, string[]>[] = [];
  let requiredScopes: string[] = [];

  for (const schemeName of schemeNames) {
    const scheme = manifest.securitySchemes?.[schemeName];
    if (schemeAcceptsOAuthScopes(scheme)) {
      security.push({ [schemeName]: scopes });
      continue;
    }
    security.push({ [schemeName]: [] });
    if (scopes.length > 0) {
      requiredScopes = scopes;
    }
  }

  return {
    ...(security.length > 0 ? { security } : {}),
    ...(requiredScopes.length > 0 ? { requiredScopes } : {}),
  };
}

export function generateOpenApi(
  caps: CapabilityContract[],
  manifest: ApiManifest,
): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};
  const apiVersion = apiVersionFromManifest(manifest);
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

    const { security, requiredScopes } = resolveOperationSecurity(manifest, entry, cap);
    if (security) {
      operation.security = security;
    }
    if (requiredScopes && requiredScopes.length > 0) {
      operation['x-plumbus-required-scopes'] = requiredScopes;
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

  const securitySchemes = buildSecuritySchemes(manifest);

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
