// Full compatibility entry: SDK plus CLI/governance tooling.
export * from './sdk.js';

// ┌────────────────────────────────────────────────────────────────────────┐
// │ TIER 2 — Tooling & CLI Internals                                      │
// │                                                                        │
// │ CLI commands, scaffolding templates, doctor checks, governance rules,  │
// │ policy certification, agent briefs, and code generators.               │
// │ These are used by the `plumbus` CLI and framework tooling, not by      │
// │ application code.                                                      │
// └────────────────────────────────────────────────────────────────────────┘

export type {
  AgentFormat,
  CreateOptions,
  DevOptions,
  DoctorCheck,
  InitOptions,
  PolicyContext,
  PolicyRule,
} from './cli/index.js';
// ── CLI (entry point + scaffolding + code generation) ──
export {
  // CLI project guard
  assertInsidePlumbusProject,
  // Scaffolding templates
  capabilityTemplate,
  capabilityTestTemplate,
  // Doctor checks
  checkAppStructure,
  checkConfig,
  checkLegacyArtifacts,
  checkNodeVersion,
  checkPackageJson,
  checkPlumbusCore,
  checkPlumbusUi,
  checkPostgreSQL,
  checkRedis,
  checkTypeScript,
  commandRequiresProject,
  createCli,
  entityTemplate,
  // Policy certification (plumbus certify)
  evaluatePolicy,
  eventTemplate,
  // Utilities
  findPlumbusProjectRoot,
  flowTemplate,
  // Agent wiring (plumbus init)
  generateAgentsMd,
  generateClaudeMd,
  // Code generation
  generateAll,
  // Agent briefs
  generateCapabilityBrief,
  // Capability type generation
  generateCapabilityNameType,
  generateCapabilityTypes,
  generateClientFunction,
  generateCopilotInstructions,
  generateCursorCapabilityRule,
  generateCursorRule,
  // Entity type generation
  generateDataServiceMap,
  generateEntityBrief,
  generateEntityInterface,
  generateEntityTypeFile,
  generateManifestEntry,
  generateOpenApiPath,
  generateProjectBrief,
  generateProjectBriefFromResources,
  // Project scaffolding
  generateProjectStructure,
  generateReactHook,
  promptTemplate,
  // CLI verify rules
  ruleCapabilityAccessPolicy,
  ruleCapabilityEffects,
  ruleEncryptedSensitiveFields,
  ruleEntityFieldClassification,
  ruleEntityTenantIsolation,
  // Dev server
  runDev,
  runDoctorChecks,
  runFullDoctorChecks,
  runGovernanceRules,
  startDevServer,
  toCamelCase,
  toKebabCase,
  toPascalCase,
  translationTemplate,
  writeAgentFiles,
  zodTypeToString,
} from './cli/index.js';
export type {
  GovernanceResult,
  GovernanceRule,
  GovernanceRuleEngine,
  OverrideEntry,
  OverrideStore,
  PolicyProfileDefinition,
  PolicyProfileRule,
  ReportOptions,
  RuleCategory,
  SystemInventory,
} from './governance/index.js';
// ── Governance Engine (advisory governance rules + policy reports) ──
export {
  aiRules,
  apiRules,
  applyOverrides,
  architectureRules,
  capabilityDependencyRules,
  mcpRules,
  builtInProfiles,
  createGovernanceRuleEngine,
  createOverrideStore,
  evaluatePolicyProfile,
  formatPolicyReport,
  generateAllPolicyReports,
  generatePolicyReport,
  ruleCapabilityMissingAccessPolicy as govRuleCapabilityMissingAccessPolicy,
  ruleEntityTenantIsolation as govRuleEntityTenantIsolation,
  privacyRules,
  ruleAIWithoutExplanation,
  ruleApiDeprecatedWithoutReplacement,
  ruleApiMetadataWithoutExposure,
  ruleApiMissingAuth,
  ruleApiMissingOperationId,
  ruleApiPublicMutationWithoutIdempotency,
  ruleCrossTenantDataAccess,
  ruleEntityMissingDescription,
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
  workerRules,
} from './governance/index.js';
