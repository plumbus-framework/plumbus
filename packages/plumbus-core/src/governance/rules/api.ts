// ── API governance rules ──

import { isApiExposed } from '../../api/exposure.js';
import { GovernanceSeverity } from '../../types/enums.js';
import type { GovernanceRule } from '../rule-engine.js';

const MUTATION_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** Capability has api metadata but is not marked exposeAs: ['api'] */
export const ruleApiMetadataWithoutExposure: GovernanceRule = {
  id: 'api.metadata-without-exposure',
  category: 'architecture',
  severity: GovernanceSeverity.Warning,
  description: 'Capabilities with api metadata should include exposeAs: ["api"]',
  evaluate(inventory) {
    return inventory.capabilities
      .filter((cap) => cap.api !== undefined && !isApiExposed(cap))
      .map((cap) => ({
        severity: GovernanceSeverity.Warning,
        rule: 'api.metadata-without-exposure',
        description: `Capability "${cap.name}" has api metadata but is not exposed via API`,
        affectedComponent: `capability:${cap.name}`,
        remediation: 'Add exposeAs: ["api"] or remove the api block',
      }));
  },
};

/** Public mutation API endpoints should declare idempotency metadata */
export const ruleApiPublicMutationWithoutIdempotency: GovernanceRule = {
  id: 'api.public-mutation-without-idempotency',
  category: 'architecture',
  severity: GovernanceSeverity.Warning,
  description: 'Public API mutation endpoints should declare idempotency metadata',
  evaluate(inventory) {
    return inventory.capabilities
      .filter((cap) => {
        if (!isApiExposed(cap)) return false;
        if (!cap.access?.public) return false;
        const method = cap.api?.method;
        if (!method || !MUTATION_METHODS.has(method)) return false;
        return cap.api?.idempotency === undefined;
      })
      .map((cap) => ({
        severity: GovernanceSeverity.Warning,
        rule: 'api.public-mutation-without-idempotency',
        description: `Public API mutation "${cap.name}" lacks idempotency metadata`,
        affectedComponent: `capability:${cap.name}`,
        remediation: 'Add api.idempotency with required header metadata',
      }));
  },
};

/** API-exposed capabilities should document auth requirements */
export const ruleApiMissingAuth: GovernanceRule = {
  id: 'api.missing-auth',
  category: 'architecture',
  severity: GovernanceSeverity.Warning,
  description: 'API-exposed capabilities should document auth scopes or access policy',
  evaluate(inventory) {
    return inventory.capabilities
      .filter((cap) => {
        if (!isApiExposed(cap)) return false;
        if (cap.access?.public) return false;
        const apiScopes = cap.api?.auth?.scopes;
        const accessScopes = cap.access?.scopes;
        const hasApiScopes = Array.isArray(apiScopes) && apiScopes.length > 0;
        const hasAccessScopes = Array.isArray(accessScopes) && accessScopes.length > 0;
        const hasRoles = Array.isArray(cap.access?.roles) && cap.access.roles.length > 0;
        return !hasApiScopes && !hasAccessScopes && !hasRoles;
      })
      .map((cap) => ({
        severity: GovernanceSeverity.Warning,
        rule: 'api.missing-auth',
        description: `API-exposed capability "${cap.name}" has no documented auth requirements`,
        affectedComponent: `capability:${cap.name}`,
        remediation: 'Add api.auth.scopes, access.scopes, or access.roles',
      }));
  },
};

/** Deprecated API operations should declare a replacement */
export const ruleApiDeprecatedWithoutReplacement: GovernanceRule = {
  id: 'api.deprecated-without-replacement',
  category: 'architecture',
  severity: GovernanceSeverity.Info,
  description: 'Deprecated API operations should declare a replacement',
  evaluate(inventory) {
    return inventory.capabilities
      .filter(
        (cap) =>
          isApiExposed(cap) &&
          cap.api?.stability === 'deprecated' &&
          cap.api.deprecation?.replacement === undefined,
      )
      .map((cap) => ({
        severity: GovernanceSeverity.Info,
        rule: 'api.deprecated-without-replacement',
        description: `Deprecated API capability "${cap.name}" has no replacement operation`,
        affectedComponent: `capability:${cap.name}`,
        remediation: 'Add api.deprecation.replacement',
      }));
  },
};

/** API-exposed capabilities should declare operationId (defensive) */
export const ruleApiMissingOperationId: GovernanceRule = {
  id: 'api.missing-operation-id',
  category: 'architecture',
  severity: GovernanceSeverity.Warning,
  description: 'API-exposed capabilities should declare operationId',
  evaluate(inventory) {
    return inventory.capabilities
      .filter((cap) => isApiExposed(cap) && !cap.api?.operationId)
      .map((cap) => ({
        severity: GovernanceSeverity.Warning,
        rule: 'api.missing-operation-id',
        description: `API-exposed capability "${cap.name}" is missing operationId`,
        affectedComponent: `capability:${cap.name}`,
        remediation: 'Add api.operationId',
      }));
  },
};

export const apiRules: GovernanceRule[] = [
  ruleApiMetadataWithoutExposure,
  ruleApiPublicMutationWithoutIdempotency,
  ruleApiMissingAuth,
  ruleApiDeprecatedWithoutReplacement,
  ruleApiMissingOperationId,
];
