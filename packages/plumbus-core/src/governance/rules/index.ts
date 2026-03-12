// ── Rules barrel ──
export {
  aiRules,
  ruleAIWithoutExplanation,
  ruleExcessiveAIUsage,
  rulePromptMissingModelConfig,
  rulePromptMissingOutputSchema,
} from './ai.js';
export {
  architectureRules,
  ruleEntityMissingDescription,
  ruleExcessiveEffects,
  ruleExcessiveFlowBranching,
  ruleExcessiveFlowSteps,
  ruleMissingAuditConfig,
} from './architecture.js';
export {
  privacyRules,
  ruleExcessiveDataRetention,
  ruleMissingFieldClassification,
  rulePersonalDataInLogs,
  ruleSensitiveFieldUnencrypted,
} from './privacy.js';
export {
  ruleCapabilityMissingAccessPolicy,
  ruleCrossTenantDataAccess,
  ruleEntityTenantIsolation,
  ruleOverlyPermissiveRoles,
  securityRules,
} from './security.js';
