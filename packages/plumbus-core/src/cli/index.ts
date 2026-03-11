// ── CLI Module ──
// CLI entry point and all subcommands: scaffolding (create, capability, entity,
// flow, event, prompt), code generation, dev server, doctor checks, governance
// verification, policy certification, agent wiring, and RAG ingestion.
//
// Key exports: createCli, generateProjectStructure, generateAll, runDoctorChecks

export { createCli } from './cli.js';

// Commands
export {
  generateCapabilityBrief,
  generateEntityBrief,
  generateProjectBriefFromResources,
} from './commands/agent.js';
export {
  evaluatePolicy,
  type PolicyContext,
  type PolicyRule,
} from './commands/certify.js';
export { generateProjectStructure, type CreateOptions } from './commands/create.js';
export { runDev, startDevServer, type DevOptions } from './commands/dev.js';
export {
  checkAppStructure,
  checkConfig,
  checkNodeVersion,
  checkPackageJson,
  checkPlumbusCore,
  checkPostgreSQL,
  checkRedis,
  checkTypeScript,
  runDoctorChecks,
  runFullDoctorChecks,
  type DoctorCheck,
} from './commands/doctor.js';
export {
  generateAll,
  generateClientFunction,
  generateManifestEntry,
  generateOpenApiPath,
  generateReactHook,
} from './commands/generate.js';
export {
  generateAgentsMd,
  generateCopilotInstructions,
  generateCursorCapabilityRule,
  generateCursorRule,
  generateProjectBrief,
  writeAgentFiles,
  type AgentFormat,
  type InitOptions,
} from './commands/init.js';
export {
  ruleCapabilityAccessPolicy,
  ruleCapabilityEffects,
  ruleEncryptedSensitiveFields,
  ruleEntityFieldClassification,
  ruleEntityTenantIsolation,
  runGovernanceRules,
} from './commands/verify.js';

// Templates
export {
  capabilityTemplate,
  capabilityTestTemplate,
  entityTemplate,
  eventTemplate,
  flowTemplate,
  promptTemplate,
} from './templates/resources.js';

// Utilities
export {
  exists,
  formatOutput,
  readJson,
  resolvePath,
  toCamelCase,
  toKebabCase,
  toPascalCase,
  writeFile,
} from './utils.js';
