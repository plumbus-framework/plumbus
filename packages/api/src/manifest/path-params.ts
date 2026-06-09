import type { CapabilityContract } from '@plumbus/core';
import type { z } from 'zod';
import type { ApiExposureConfig } from '@plumbus/core';
import type { ApiManifestFinding } from './types.js';

export function extractPathParamNames(path: string): string[] {
  const matches = path.matchAll(/\{([^}]+)\}/g);
  return [...matches].map((m) => m[1]).filter((name): name is string => name !== undefined);
}

export function toFastifyPath(apiPath: string): string {
  return apiPath.replace(/\{([^}]+)\}/g, ':$1');
}

function getInputShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> | undefined {
  const def = (
    schema as { _def?: { typeName?: string; shape?: () => Record<string, z.ZodTypeAny> } }
  )._def;
  if (!def) return undefined;
  if (def.typeName === 'ZodObject') {
    return typeof def.shape === 'function' ? def.shape() : undefined;
  }
  if (def.typeName === 'ZodEffects') {
    const inner = (schema as { _def: { schema: z.ZodTypeAny } })._def.schema;
    return getInputShape(inner);
  }
  return undefined;
}

export function validatePathParams(
  cap: CapabilityContract,
  resolved: ApiExposureConfig,
): ApiManifestFinding[] {
  const findings: ApiManifestFinding[] = [];
  const paramNames = extractPathParamNames(resolved.path);
  const shape = getInputShape(cap.input);
  if (!shape) {
    return findings;
  }

  const seen = new Set<string>();
  for (const param of paramNames) {
    if (seen.has(param)) {
      findings.push({
        code: 'manifest.path-param-collision',
        message: `Duplicate path parameter "{${param}}" in route path`,
        capability: `${cap.domain}.${cap.name}`,
        operationId: resolved.operationId,
        path: resolved.path,
      });
    }
    seen.add(param);

    if (!(param in shape)) {
      findings.push({
        code: 'manifest.path-param-unmapped',
        message: `Path parameter "{${param}}" is not defined on capability input schema`,
        capability: `${cap.domain}.${cap.name}`,
        operationId: resolved.operationId,
        path: resolved.path,
      });
    }
  }

  return findings;
}

export function mergePathParamsIntoInput(
  pathParams: Record<string, unknown>,
  bodyOrQuery: unknown,
): Record<string, unknown> {
  const base =
    typeof bodyOrQuery === 'object' && bodyOrQuery !== null && !Array.isArray(bodyOrQuery)
      ? { ...(bodyOrQuery as Record<string, unknown>) }
      : {};

  for (const [key, value] of Object.entries(pathParams)) {
    if (key in base && base[key] !== value) {
      throw new PathParamCollisionError(key);
    }
    base[key] = value;
  }

  return base;
}

export class PathParamCollisionError extends Error {
  readonly param: string;

  constructor(param: string) {
    super(`Path parameter collision for "${param}"`);
    this.name = 'PathParamCollisionError';
    this.param = param;
  }
}
