// ── Built-in Security Governance Rules ──

import { GovernanceSeverity } from '../../types/enums.js';
import type { GovernanceRule } from '../rule-engine.js';

/** Capabilities without access policies */
export const ruleCapabilityMissingAccessPolicy: GovernanceRule = {
  id: 'security.capability-access-policy',
  category: 'security',
  severity: GovernanceSeverity.High,
  description: 'All capabilities must have access policies defined',
  evaluate(inventory) {
    return inventory.capabilities
      .filter(
        (cap) =>
          !cap.access ||
          (!cap.access.roles?.length && !cap.access.scopes?.length && !cap.access.public),
      )
      .map((cap) => ({
        severity: GovernanceSeverity.High,
        rule: 'security.capability-access-policy',
        description: `Capability "${cap.name}" has no access policy defined`,
        affectedComponent: `capability:${cap.name}`,
        remediation: 'Add an access policy with roles, scopes, or mark as public',
      }));
  },
};

/** Overly permissive roles (wildcard or admin-only) */
export const ruleOverlyPermissiveRoles: GovernanceRule = {
  id: 'security.overly-permissive-roles',
  category: 'security',
  severity: GovernanceSeverity.Warning,
  description:
    "Capabilities should not use overly permissive roles like '*' or empty role arrays with public access",
  evaluate(inventory) {
    return inventory.capabilities
      .filter((cap) => cap.access?.roles?.includes('*'))
      .map((cap) => ({
        severity: GovernanceSeverity.Warning,
        rule: 'security.overly-permissive-roles',
        description: `Capability "${cap.name}" uses wildcard role '*'`,
        affectedComponent: `capability:${cap.name}`,
        remediation: 'Replace wildcard role with specific role names',
      }));
  },
};

/** Cross-tenant data access risk — capabilities accessing data without tenant isolation */
export const ruleCrossTenantDataAccess: GovernanceRule = {
  id: 'security.cross-tenant-data-access',
  category: 'security',
  severity: GovernanceSeverity.High,
  description: 'Capabilities that access entity data should use tenant-scoped entities',
  evaluate(inventory) {
    const nonTenantEntityNames = new Set(
      inventory.entities.filter((e) => !e.tenantScoped).map((e) => e.name),
    );
    return inventory.capabilities
      .filter(
        (cap) =>
          cap.effects.data?.some((d) => nonTenantEntityNames.has(d)) && cap.access?.tenantScoped,
      )
      .map((cap) => ({
        severity: GovernanceSeverity.High,
        rule: 'security.cross-tenant-data-access',
        description: `Capability "${cap.name}" is tenant-scoped but accesses non-tenant-scoped entities: ${cap.effects.data.filter((d) => nonTenantEntityNames.has(d)).join(', ')}`,
        affectedComponent: `capability:${cap.name}`,
        remediation:
          'Set tenantScoped: true on the accessed entities or remove tenant scope from the capability',
      }));
  },
};

/** Missing tenant isolation on entities */
export const ruleEntityTenantIsolation: GovernanceRule = {
  id: 'security.no-tenant-isolation',
  category: 'security',
  severity: GovernanceSeverity.Info,
  description: 'Entities holding tenant-specific data should be tenant-scoped',
  evaluate(inventory) {
    return inventory.entities
      .filter((entity) => !entity.tenantScoped)
      .map((entity) => ({
        severity: GovernanceSeverity.Info,
        rule: 'security.no-tenant-isolation',
        description: `Entity "${entity.name}" is not tenant-scoped`,
        affectedComponent: `entity:${entity.name}`,
        remediation: 'Set tenantScoped: true if this entity holds tenant-specific data',
      }));
  },
};

export const securityRules: GovernanceRule[] = [
  ruleCapabilityMissingAccessPolicy,
  ruleOverlyPermissiveRoles,
  ruleCrossTenantDataAccess,
  ruleEntityTenantIsolation,
];
