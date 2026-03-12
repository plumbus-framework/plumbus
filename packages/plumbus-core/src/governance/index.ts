// ── Governance Module ──
// Advisory governance: rule engine, built-in rules (security, privacy, architecture, AI),
// override management, policy profiles (SOC2, GDPR, HIPAA, etc.), and compliance reports.
// Advisory only — warnings never hard-block.
//
// Key exports: createGovernanceRuleEngine, securityRules, privacyRules, generatePolicyReport

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
