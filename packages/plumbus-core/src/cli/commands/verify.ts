// ── plumbus verify ──
// Run all governance checks and report results

import type { Command } from 'commander';
import type { CapabilityContract } from '../../types/capability.js';
import type { EntityDefinition } from '../../types/entity.js';
import { FieldClassification, GovernanceSeverity } from '../../types/enums.js';
import type { GovernanceSignal } from '../../types/governance.js';
import { discoverResources } from '../discover.js';
import { info, error as logError, success, warn } from '../utils.js';

export interface VerifyOptions {
  json?: boolean;
}

// ── Built-in Governance Rules ──

/** Check that all capabilities have access policies */
export function ruleCapabilityAccessPolicy(capabilities: CapabilityContract[]): GovernanceSignal[] {
  const signals: GovernanceSignal[] = [];
  for (const cap of capabilities) {
    if (
      !cap.access ||
      (!cap.access.roles?.length && !cap.access.scopes?.length && !cap.access.public)
    ) {
      signals.push({
        severity: GovernanceSeverity.High,
        rule: 'security.capability-access-policy',
        description: `Capability "${cap.name}" has no access policy defined`,
        affectedComponent: `capability:${cap.name}`,
        remediation: 'Add an access policy with roles, scopes, or mark as public',
      });
    }
  }
  return signals;
}

/** Check that capabilities declare their effects */
export function ruleCapabilityEffects(capabilities: CapabilityContract[]): GovernanceSignal[] {
  const signals: GovernanceSignal[] = [];
  for (const cap of capabilities) {
    const e = cap.effects;
    const totalEffects =
      (e.data?.length ?? 0) + (e.events?.length ?? 0) + (e.external?.length ?? 0);
    if (totalEffects > 10) {
      signals.push({
        severity: GovernanceSeverity.Warning,
        rule: 'architecture.excessive-effects',
        description: `Capability "${cap.name}" declares ${totalEffects} effects — consider splitting`,
        affectedComponent: `capability:${cap.name}`,
        remediation: 'Break the capability into smaller, focused capabilities',
      });
    }
  }
  return signals;
}

/** Check that entity fields with sensitive data have classifications */
export function ruleEntityFieldClassification(entities: EntityDefinition[]): GovernanceSignal[] {
  const signals: GovernanceSignal[] = [];
  const sensitivePatterns =
    /email|password|ssn|social_security|credit_card|phone|address|dob|date_of_birth/i;

  for (const entity of entities) {
    for (const [fieldName, fieldDef] of Object.entries(entity.fields)) {
      if (sensitivePatterns.test(fieldName) && !fieldDef.options.classification) {
        signals.push({
          severity: GovernanceSeverity.Warning,
          rule: 'privacy.missing-field-classification',
          description: `Entity "${entity.name}" field "${fieldName}" appears sensitive but has no classification`,
          affectedComponent: `entity:${entity.name}.${fieldName}`,
          remediation: `Add classification (e.g., personal, sensitive) to field "${fieldName}"`,
        });
      }
    }
  }
  return signals;
}

/** Check that sensitive fields are encrypted */
export function ruleEncryptedSensitiveFields(entities: EntityDefinition[]): GovernanceSignal[] {
  const signals: GovernanceSignal[] = [];
  const highClassifications: FieldClassification[] = [
    FieldClassification.Sensitive,
    FieldClassification.HighlySensitive,
  ];

  for (const entity of entities) {
    for (const [fieldName, fieldDef] of Object.entries(entity.fields)) {
      if (
        fieldDef.options.classification &&
        highClassifications.includes(fieldDef.options.classification) &&
        !fieldDef.options.encrypted
      ) {
        signals.push({
          severity: GovernanceSeverity.High,
          rule: 'privacy.sensitive-field-unencrypted',
          description: `Entity "${entity.name}" field "${fieldName}" is classified as ${fieldDef.options.classification} but not encrypted`,
          affectedComponent: `entity:${entity.name}.${fieldName}`,
          remediation: 'Add `encrypted: true` to the field definition',
        });
      }
    }
  }
  return signals;
}

/** Check entities have tenant isolation */
export function ruleEntityTenantIsolation(entities: EntityDefinition[]): GovernanceSignal[] {
  const signals: GovernanceSignal[] = [];
  for (const entity of entities) {
    if (!entity.tenantScoped) {
      signals.push({
        severity: GovernanceSeverity.Info,
        rule: 'security.no-tenant-isolation',
        description: `Entity "${entity.name}" is not tenant-scoped`,
        affectedComponent: `entity:${entity.name}`,
        remediation: 'Set `tenantScoped: true` if this entity holds tenant-specific data',
      });
    }
  }
  return signals;
}

/** Run all governance rules against a system inventory */
export function runGovernanceRules(
  capabilities: CapabilityContract[],
  entities: EntityDefinition[],
): GovernanceSignal[] {
  return [
    ...ruleCapabilityAccessPolicy(capabilities),
    ...ruleCapabilityEffects(capabilities),
    ...ruleEntityFieldClassification(entities),
    ...ruleEncryptedSensitiveFields(entities),
    ...ruleEntityTenantIsolation(entities),
  ];
}

export function registerVerifyCommand(program: Command): void {
  program
    .command('verify')
    .description('Run governance checks and report results')
    .option('--json', 'Output as JSON')
    .action(async (opts: VerifyOptions) => {
      info('Running governance verification...');

      let capabilities: CapabilityContract[] = [];
      let entities: EntityDefinition[] = [];
      try {
        const resources = await discoverResources();
        capabilities = resources.capabilities;
        entities = resources.entities;
        info(`Discovered ${capabilities.length} capability(ies), ${entities.length} entity(ies)`);
      } catch {
        warn('Could not auto-discover resources (app/ directory may not exist)');
      }

      const signals = runGovernanceRules(capabilities, entities);

      if (opts.json) {
        console.log(
          JSON.stringify({ signals, highCount: 0, warningCount: 0, infoCount: 0 }, null, 2),
        );
        return;
      }

      if (signals.length === 0) {
        success('No governance issues detected.');
        return;
      }

      const high = signals.filter((s) => s.severity === GovernanceSeverity.High);
      const warnings = signals.filter((s) => s.severity === GovernanceSeverity.Warning);
      const infos = signals.filter((s) => s.severity === GovernanceSeverity.Info);

      for (const s of high) logError(`[HIGH] ${s.rule}: ${s.description}`);
      for (const s of warnings) warn(`[WARN] ${s.rule}: ${s.description}`);
      for (const s of infos) info(`[INFO] ${s.rule}: ${s.description}`);

      console.log(
        `\nTotal: ${high.length} high, ${warnings.length} warnings, ${infos.length} info`,
      );

      if (high.length > 0) {
        process.exit(1);
      }
    });
}
