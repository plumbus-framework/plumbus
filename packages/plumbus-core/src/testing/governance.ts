// ── Governance Test Helpers ──
// Assertions for governance rules, policy compliance, overrides, and signals.

import { evaluatePolicyProfile } from '../governance/policies.js';
import type {
  GovernanceResult,
  GovernanceRule,
  SystemInventory,
} from '../governance/rule-engine.js';
import { createGovernanceRuleEngine } from '../governance/rule-engine.js';
import type { GovernanceSeverity } from '../types/enums.js';
import type { GovernanceOverride } from '../types/governance.js';

// ── Signal Assertions ──

/**
 * Assert that specific governance rules fired in a result.
 * Checks that each expected rule ID is present in the signals.
 */
export function assertGovernanceSignals(result: GovernanceResult, expectedRuleIds: string[]): void {
  const signalRules = result.signals.map((s) => s.rule);
  for (const expected of expectedRuleIds) {
    if (!signalRules.includes(expected)) {
      throw new Error(
        `Expected governance rule "${expected}" to fire but it did not.\n` +
          `  Fired rules: [${signalRules.join(', ')}]`,
      );
    }
  }
}

/**
 * Assert that specific governance rules did NOT fire.
 */
export function assertNoGovernanceSignal(
  result: GovernanceResult,
  unexpectedRuleIds: string[],
): void {
  const signalRules = result.signals.map((s) => s.rule);
  for (const unexpected of unexpectedRuleIds) {
    if (signalRules.includes(unexpected)) {
      throw new Error(
        `Expected governance rule "${unexpected}" NOT to fire but it did.\n` +
          `  Signal: ${result.signals.find((s) => s.rule === unexpected)?.description}`,
      );
    }
  }
}

/**
 * Assert that only signals of a given max severity are present.
 * e.g., assertMaxSeverity(result, "warning") ensures no "high" severity signals.
 */
export function assertMaxSeverity(result: GovernanceResult, maxSeverity: GovernanceSeverity): void {
  const severityOrder = { info: 0, warning: 1, high: 2 };
  const maxLevel = severityOrder[maxSeverity] ?? 0;
  const violations = result.effective.filter((s) => (severityOrder[s.severity] ?? 0) > maxLevel);
  if (violations.length > 0) {
    throw new Error(
      `Expected no signals above "${maxSeverity}" severity but found:\n` +
        violations.map((v) => `  - [${v.severity}] ${v.rule}: ${v.description}`).join('\n'),
    );
  }
}

// ── Override Assertions ──

/**
 * Assert that specific overrides were applied in a governance result.
 */
export function assertOverridesApplied(result: GovernanceResult, expectedRuleIds: string[]): void {
  const appliedRules = result.overrideApplied.map((o) => o.rule);
  for (const expected of expectedRuleIds) {
    if (!appliedRules.includes(expected)) {
      throw new Error(
        `Expected override for rule "${expected}" to be applied but it was not.\n` +
          `  Applied overrides: [${appliedRules.join(', ')}]`,
      );
    }
  }
}

// ── Policy Compliance Assertions ──

/**
 * Assert that a system inventory is compliant with a policy profile.
 * "Compliant" means compatibility score >= threshold (default: 100%).
 */
export function assertPolicyCompliance(
  inventory: SystemInventory,
  profileName: string,
  overrides: GovernanceOverride[] = [],
  threshold = 100,
): void {
  const report = evaluatePolicyProfile(profileName, inventory, overrides);
  if (report.score < threshold) {
    const failures = report.results
      .filter((r) => r.status === 'fail')
      .map((r) => `  - [${r.severity}] ${r.rule}: ${r.description ?? ''}`)
      .join('\n');
    throw new Error(
      `Policy "${profileName}" compliance: ${report.score}% (threshold: ${threshold}%)\n` +
        `Failed rules:\n${failures}`,
    );
  }
}

/**
 * Assert that a system inventory FAILS a policy profile (for testing negative cases).
 */
export function assertPolicyNonCompliance(
  inventory: SystemInventory,
  profileName: string,
  overrides: GovernanceOverride[] = [],
): void {
  const report = evaluatePolicyProfile(profileName, inventory, overrides);
  if (report.score >= 100) {
    throw new Error(`Expected policy "${profileName}" to FAIL but it passed with ${report.score}%`);
  }
}

// ── Quick Governance Check ──

/**
 * Evaluate governance rules against an inventory and return the result.
 * Convenience wrapper that creates an engine, registers rules, and evaluates.
 */
export function evaluateGovernance(
  rules: GovernanceRule[],
  inventory: SystemInventory,
  overrides: GovernanceOverride[] = [],
): GovernanceResult {
  const engine = createGovernanceRuleEngine();
  engine.registerMany(rules);
  return engine.evaluate(inventory, overrides);
}

// ── Empty Inventory Builder ──

/** Create an empty SystemInventory, optionally overriding specific collections */
export function emptyInventory(overrides?: Partial<SystemInventory>): SystemInventory {
  return {
    capabilities: [],
    entities: [],
    flows: [],
    events: [],
    prompts: [],
    ...overrides,
  };
}
