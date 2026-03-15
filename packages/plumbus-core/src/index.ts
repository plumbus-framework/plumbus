// ════════════════════════════════════════════════════════════════════════════
// Plumbus Core — Public API
//
// This barrel is organized into two tiers:
//
//   TIER 1 — SDK Surface (for building applications)
//     Types, define*() functions, field constructors, execution engine,
//     data layer, auth, events, flows, AI runtime, config, observability.
//
//   TIER 2 — Tooling & CLI Internals (for framework tooling)
//     CLI commands, scaffolding templates, doctor checks, governance rules,
//     policy certification, agent briefs, code generators.
//
// When adding new exports, place them in the correct tier.
// ════════════════════════════════════════════════════════════════════════════

// ┌────────────────────────────────────────────────────────────────────────┐
// │ TIER 1 — SDK Surface                                                  │
// └────────────────────────────────────────────────────────────────────────┘

export type {
  AICostRecord,
  AIExplainabilityTracker,
  AIInvocationRecord,
  AIProviderAdapter,
  AISecurityConfig,
  AIServiceConfig,
  AnthropicAdapterConfig,
  BudgetCheckResult,
  BudgetConfig,
  ChunkConfig,
  CostTracker,
  DailyUsage,
  DocumentChunk,
  EmbeddingRequest,
  EmbeddingResponse,
  ExplainabilityConfig,
  IngestDocumentInput,
  OpenAIAdapterConfig,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  RAGPipeline,
  RAGPipelineConfig,
  RetrievalQuery,
  SecurityCheckResult,
  SecurityWarning,
  StoredChunk,
  TokenUsage,
  UsageAPIClient,
  UsageClientConfig,
  UsageData,
  UsageEntry,
  UsageSyncResult,
  ValidatedResponse,
  ValidationRetryConfig,
  VectorStore,
} from './ai/index.js';
// ── AI Runtime ──
export {
  PromptRegistry,
  UsageAPIError,
  checkPromptSecurity,
  chunkDocument,
  createAIService,
  createAnthropicAdapter,
  createCostTracker,
  createExplainabilityTracker,
  createInMemoryVectorStore,
  createOpenAIAdapter,
  createProviderAdapter,
  createRAGPipeline,
  createUsageAPIClient,
  documentChunksTable,
  documentsTable,
  generateWithValidation,
  singleProviderConfig,
} from './ai/index.js';
export type { RouteGeneratorConfig } from './api/index.js';
// ── API (HTTP route generation) ──
export { registerAllRoutes, registerCapabilityRoute } from './api/index.js';
export type { AuditServiceConfig } from './audit/index.js';
// ── Audit ──
export { auditRecords, createAuditService } from './audit/index.js';
export type {
  AuthAdapter,
  JwtAdapterConfig,
  JwtClaimMapping,
  OidcAdapterConfig,
  OidcJwk,
  PasswordHashOptions,
  SamlAdapterConfig,
  ScimEmail,
  ScimError,
  ScimListResponse,
  ScimService,
  ScimServiceConfig,
  ScimUser,
  ScimUserRepository,
  ScimUserResource,
  SignJwtOptions,
} from './auth/index.js';
// ── Auth ──
export {
  createJwtAdapter,
  createOidcAdapter,
  createSamlAdapter,
  createScimService,
  hashPassword,
  signJwt,
  verifyPassword,
} from './auth/index.js';
export type { ConfigLoadOptions, ConfigValidationResult } from './config/index.js';
// ── Config Loader ──
export { loadConfig, validateConfig } from './config/index.js';
export type { MigrationConfig, MigrationRecord, RepositoryOptions } from './data/index.js';
// ── Data Layer ──
export {
  EntityRegistry,
  applyMigrations,
  collectSchemas,
  createRepository,
  generateDrizzleSchema,
  generateSchemas,
  rollbackLastMigration,
} from './data/index.js';
// ── Define Functions ──
export { defineCapability } from './define/defineCapability.js';
export { defineEntity } from './define/defineEntity.js';
export { defineEvent } from './define/defineEvent.js';
export { defineFlow } from './define/defineFlow.js';
export { definePrompt } from './define/definePrompt.js';
// ── Error Utilities ──
export { errorToHttpResponse, errorToHttpStatus } from './errors/http.js';
export { createErrorService, isPlumbusError } from './errors/index.js';
export type {
  DispatcherConfig,
  EventConsumer,
  EventConsumerHandler,
  EventEmitterConfig,
  EventQueue,
  IdempotencyService,
  RedisClient,
  RedisQueueConfig,
  WorkerConfig,
} from './events/index.js';
// ── Events ──
export {
  ConsumerRegistry,
  EventRegistry,
  createEventEmitter,
  createEventWorker,
  createIdempotencyService,
  createInMemoryQueue,
  createOutboxDispatcher,
  createRedisQueue,
  deadLetterTable,
  idempotencyTable,
  outboxTable,
} from './events/index.js';
export type {
  AuthorizationResult,
  CapabilityResult,
  ContextDependencies,
  ExecutionFailure,
  ExecutionResult,
} from './execution/index.js';
// ── Execution Engine ──
export {
  CapabilityRegistry,
  createExecutionContext,
  evaluateAccess,
  executeCapability,
} from './execution/index.js';
export type {
  AIInvocationExplanation,
  AuthorizationExplanation,
  ExplanationFilter,
  ExplanationRecord,
  ExplanationTracker,
  ExplanationTrackerConfig,
  ExplanationType,
  FlowBranchExplanation,
  GovernanceExplanation,
} from './explanation/index.js';
// ── Explanation ──
export { createExplanationTracker } from './explanation/index.js';
// ── Field Constructors ──
export { field } from './fields/index.js';
export type {
  FlowEngineConfig,
  SchedulerConfig,
  StepExecutorDeps,
  StepHistoryEntry,
  StepResult,
} from './flows/index.js';
// ── Flows ──
export {
  FlowRegistry,
  FlowStatus,
  StepStatus,
  assertTransition,
  buildHistoryEntry,
  computeNextRun,
  computeRetryDelay,
  createFlowEngine,
  createFlowScheduler,
  createFlowService,
  createFlowTriggerHandler,
  deadLetterFlow,
  executeStep,
  flowDeadLetterTable,
  flowExecutionsTable,
  flowSchedulesTable,
  isTerminal,
  isValidTransition,
  sweepFailedFlows,
} from './flows/index.js';
export type {
  Counter,
  Histogram,
  MetricLabels,
  MetricsRegistry,
  PlumbusMetrics,
  Span,
  SpanExporter,
  SpanKind,
  SpanOptions,
  SpanStatusCode,
  StructuredLogEntry,
  StructuredLoggerConfig,
  TraceContext,
  Tracer,
  W3CTraceContext,
} from './observability/index.js';
// ── Observability ──
export {
  createChildSpan,
  createMetricsRegistry,
  createPlumbusMetrics,
  createStructuredLogger,
  createTraceContext,
  createTracer,
  extractTraceFromHeaders,
  formatTraceparent,
  generateSpanId,
  generateTraceId,
  injectTraceHeaders,
  parseTraceparent,
} from './observability/index.js';
export type { PlumbusServer, ServerConfig } from './server/index.js';
// ── Server Bootstrap ──
export { createServer } from './server/index.js';
// ── Types (re-export everything) ──
export * from './types/index.js';
export type { WorkerPool, WorkerPoolConfig } from './worker/index.js';
// ── Worker Bootstrap ──
export { createWorkerPool } from './worker/index.js';

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
  // Scaffolding templates
  capabilityTemplate,
  capabilityTestTemplate,
  // Doctor checks
  checkAppStructure,
  checkConfig,
  checkNodeVersion,
  checkPackageJson,
  checkPlumbusCore,
  checkPostgreSQL,
  checkRedis,
  checkTypeScript,
  createCli,
  entityTemplate,
  // Policy certification (plumbus certify)
  evaluatePolicy,
  eventTemplate,
  flowTemplate,
  // Agent wiring (plumbus init)
  generateAgentsMd,
  // Code generation
  generateAll,
  // Agent briefs
  generateCapabilityBrief,
  generateClientFunction,
  generateCopilotInstructions,
  generateCursorCapabilityRule,
  generateCursorRule,
  generateEntityBrief,
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
  // Utilities
  toCamelCase,
  toKebabCase,
  toPascalCase,
  writeAgentFiles,
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
  applyOverrides,
  architectureRules,
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
} from './governance/index.js';
