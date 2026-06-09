import { isApiExposed, type CapabilityContract } from '@plumbus/core';
import { extractPathParamNames } from '../manifest/path-params.js';
import { resolveExposure } from '../manifest/resolve.js';
import type { ApiManifest } from '../manifest/types.js';
import type { ApiPolicyFinding } from './finding.js';

function getInputFieldNames(cap: CapabilityContract): string[] {
  const def = (cap.input as { _def?: { typeName?: string; shape?: () => Record<string, unknown> } })
    ._def;
  if (def?.typeName === 'ZodObject' && typeof def.shape === 'function') {
    return Object.keys(def.shape());
  }
  return [];
}

const DEFAULT_FORBIDDEN = ['orgId', 'tenantId'];

export function validatePolicy(
  manifest: ApiManifest,
  caps: CapabilityContract[],
): ApiPolicyFinding[] {
  const findings: ApiPolicyFinding[] = [];
  const policy = manifest.policy;
  const capMap = new Map(caps.map((c) => [`${c.domain}.${c.name}`, c]));

  for (const entry of manifest.expose) {
    const cap = capMap.get(entry.capability);
    if (!cap || !isApiExposed(cap)) {
      continue;
    }

    const resolved = resolveExposure(cap, entry);

    if (cap.access?.public === true && resolved.test?.enabled === true) {
      findings.push({
        code: 'policy.public-test-forbidden',
        message: `Public capability "${entry.capability}" must not enable test intent`,
        capability: entry.capability,
        operationId: resolved.operationId,
      });
    }

    if (!policy) {
      continue;
    }

    const method = resolved.method;
    const forbidMutation = policy.methodSemantics?.forbidMutationOverGet !== false;

    if (forbidMutation && method === 'GET' && (cap.kind === 'action' || cap.kind === 'job')) {
      findings.push({
        code: 'policy.mutation-over-get',
        message: `Capability "${entry.capability}" (${cap.kind}) must not be exposed via GET`,
        capability: entry.capability,
        operationId: resolved.operationId,
      });
    }

    const forbidGetBody = policy.methodSemantics?.forbidGetBody !== false;
    if (forbidGetBody && method === 'GET' && cap.kind !== 'query') {
      const fields = getInputFieldNames(cap);
      const pathParams = new Set(extractPathParamNames(resolved.path));
      const nonPathFields = fields.filter((f) => !pathParams.has(f));
      if (nonPathFields.length > 0) {
        findings.push({
          code: 'policy.get-with-body',
          message: `GET operation "${resolved.operationId}" (${cap.kind}) has non-path input fields that imply a request body: ${nonPathFields.join(', ')}`,
          capability: entry.capability,
          operationId: resolved.operationId,
        });
      }
    }

    const tenant = policy.tenantRouting;
    if (tenant?.mode === 'auth-context' && tenant.forbidExplicitTenantInput) {
      const forbidden = [
        ...DEFAULT_FORBIDDEN,
        ...(tenant.forbiddenParams?.path ?? []),
        ...(tenant.forbiddenParams?.query ?? []),
        ...(tenant.forbiddenParams?.body ?? []),
      ];

      for (const param of extractPathParamNames(resolved.path)) {
        if (forbidden.includes(param)) {
          findings.push({
            code: 'policy.tenant-input-forbidden',
            message: `Tenant/org parameter "${param}" must not appear in path when tenantRouting.mode is auth-context`,
            capability: entry.capability,
            operationId: resolved.operationId,
          });
        }
      }

      for (const field of getInputFieldNames(cap)) {
        if (forbidden.includes(field)) {
          findings.push({
            code: 'policy.tenant-input-forbidden',
            message: `Tenant/org field "${field}" must not appear in input when tenantRouting.mode is auth-context`,
            capability: entry.capability,
            operationId: resolved.operationId,
          });
        }
      }
    }
  }

  return findings;
}
