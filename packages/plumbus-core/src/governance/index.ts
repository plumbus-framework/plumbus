// ── Governance barrel export ──
export { applyOverrides, createOverrideStore } from './overrides.js';
export type { OverrideEntry, OverrideStore } from './overrides.js';

export { builtInProfiles, evaluatePolicyProfile } from './policies.js';
export type { PolicyProfileDefinition, PolicyProfileRule } from './policies.js';

export { formatPolicyReport, generateAllPolicyReports, generatePolicyReport } from './reports.js';
export type { ReportOptions } from './reports.js';

export { createGovernanceRuleEngine } from './rule-engine.js';
export type {
  GovernanceResult,
  GovernanceRule,
  GovernanceRuleEngine,
  RuleCategory,
  SystemInventory,
} from './rule-engine.js';

export {
  aiRules,
  architectureRules,
  privacyRules,
  ruleAIWithoutExplanation,
  ruleCapabilityMissingAccessPolicy,
  ruleCrossTenantDataAccess,
  ruleEntityMissingDescription,
  ruleEntityTenantIsolation,
  ruleExcessiveAIUsage,
  ruleExcessiveDataRetention,
  ruleExcessiveEffects,
  ruleExcessiveFlowBranching,
  ruleExcessiveFlowSteps,
  ruleMissingAuditConfig,
  ruleMissingFieldClassification,
  ruleOverlyPermissiveRoles,
  rulePersonalDataInLogs,
  ruleSensitiveFieldUnencrypted,
  securityRules,
} from './rules/index.js';
