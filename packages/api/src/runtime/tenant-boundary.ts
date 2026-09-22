import type { ApiManifest } from '../manifest/types.js';

const DEFAULT_FORBIDDEN = ['orgId', 'tenantId'];

export function collectExplicitTenantViolations(
  manifest: ApiManifest,
  pathParams: Record<string, unknown>,
  bodyOrQuery: unknown,
): string[] {
  const tenant = manifest.policy?.tenantRouting;
  if (tenant?.mode !== 'auth-context' || tenant.forbidExplicitTenantInput !== true) {
    return [];
  }

  const forbidden = new Set([
    ...DEFAULT_FORBIDDEN,
    ...(tenant.forbiddenParams?.path ?? []),
    ...(tenant.forbiddenParams?.query ?? []),
    ...(tenant.forbiddenParams?.body ?? []),
  ]);

  const violations: string[] = [];
  for (const key of Object.keys(pathParams)) {
    if (forbidden.has(key)) {
      violations.push(key);
    }
  }

  const fields = (bodyOrQuery ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (forbidden.has(key)) {
      violations.push(key);
    }
  }

  return [...new Set(violations)];
}
