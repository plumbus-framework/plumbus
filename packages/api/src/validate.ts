import { isApiExposed, type CapabilityContract } from '@plumbus/core';
import type { ApiManifest, ApiManifestFinding } from './manifest/types.js';
import { validateManifest } from './manifest/validate-against-registry.js';
import { validatePathParams } from './manifest/path-params.js';
import { validateSecurityConfig } from './manifest/validate-security.js';
import { resolveExposure } from './manifest/resolve.js';
import { validatePolicy } from './policy/validate-policy.js';
import type { ApiPolicyFinding } from './policy/finding.js';
import { validateTestFixtures } from './runtime/validate-fixtures.js';

export interface ApiValidateResult {
  manifest: ApiManifestFinding[];
  policy: ApiPolicyFinding[];
  pathParams: ApiManifestFinding[];
  security: ApiManifestFinding[];
  fixtures: ApiManifestFinding[];
  ok: boolean;
}

export async function validateApiContract(
  manifest: ApiManifest,
  capabilities: CapabilityContract[],
  appRoot: string,
): Promise<ApiValidateResult> {
  const manifestFindings = validateManifest(manifest, capabilities);
  const policyFindings = validatePolicy(manifest, capabilities);
  const securityFindings = validateSecurityConfig(manifest);
  const pathParamFindings: ApiManifestFinding[] = [];
  const capMap = new Map(capabilities.map((c) => [`${c.domain}.${c.name}`, c]));

  for (const entry of manifest.expose) {
    const cap = capMap.get(entry.capability);
    if (!cap || !isApiExposed(cap)) {
      continue;
    }
    const resolved = resolveExposure(cap, entry);
    pathParamFindings.push(...validatePathParams(cap, resolved));
  }

  const fixtureFindings = await validateTestFixtures(capabilities, appRoot, manifest);

  const all = [
    ...manifestFindings,
    ...policyFindings,
    ...securityFindings,
    ...pathParamFindings,
    ...fixtureFindings,
  ];

  const isWarningOnly = (finding: ApiManifestFinding | ApiPolicyFinding): boolean =>
    'severity' in finding && finding.severity === 'warning';

  return {
    manifest: manifestFindings,
    policy: policyFindings,
    pathParams: pathParamFindings,
    security: securityFindings,
    fixtures: fixtureFindings,
    ok: all.filter((finding) => !isWarningOnly(finding)).length === 0,
  };
}
