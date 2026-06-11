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
  ChatMessage,
  CostTracker,
  DailyUsage,
  DocumentChunk,
  EmbeddingRequest,
  EmbeddingResponse,
  ExplainabilityConfig,
  IngestDocumentInput,
  Kind,
  ListModelsFilter,
  ModelRate,
  OpenAIAdapterConfig,
  ProviderJsonSchemaOptions,
  ProviderJsonSchemaResult,
  ProviderModel,
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
  allKnownModels,
  calculateModelCost,
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
  findModelRate,
  generateWithValidation,
  joinAndFilterModels,
  zodToProviderJsonSchema,
  singleProviderConfig,
  ProviderJsonSchemaError,
  AIIncompleteOutputError,
  AIRefusalError,
} from './ai/index.js';
export type { RouteGeneratorConfig } from './api/index.js';
// ── API (HTTP route generation) ──
export {
  isApiExposed,
  registerAllRoutes,
  registerCapabilityRoute,
  registerStreamingRoute,
} from './api/index.js';
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
  gte,
  ilike,
  like,
  lte,
  rollbackLastMigration,
  sql,
} from './data/index.js';
// ── Define Functions ──
export { defineCapability } from './define/defineCapability.js';
export { defineEntity } from './define/defineEntity.js';
export { defineEvent } from './define/defineEvent.js';
export { defineFlow } from './define/defineFlow.js';
export { definePrompt } from './define/definePrompt.js';
export { defineTranslation } from './define/defineTranslation.js';
export { zodInputToJsonSchema } from './schema/zod-input-to-json-schema.js';
// ── Error Utilities ──
export { errorToHttpResponse, errorToHttpStatus } from './errors/http.js';
export {
  PlumbusError,
  LeaseLostError,
  createErrorService,
  isPlumbusError,
} from './errors/index.js';
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
  generateWorkerId,
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
// ── Translations ──
export {
  TranslationRegistry,
  createTranslationResolver,
  createTranslationService,
} from './translations/index.js';
// ── Types (re-export everything) ──
export * from './types/index.js';
export type { WorkerPool, WorkerPoolConfig } from './worker/index.js';
// ── Worker Bootstrap ──
export { createWorkerPool } from './worker/index.js';
export type {
  BuildWorkerAiServiceOptions,
  RegisterCapabilityConsumersOptions,
  ResolveRuntimeQueuesOptions,
  RuntimeCommand,
  RuntimeQueues,
  ServerExtensions,
} from './runtime/index.js';
export {
  RuntimeRole,
  buildStepDeps,
  buildWorkerAiService,
  discoverRuntimeResources,
  needsWorkerPool,
  registerCapabilityConsumers,
  resolveRuntimeQueues,
  resolveRuntimeRole,
  shouldStartApiServer,
  shouldStartWorkerPool,
  shouldUseRedisBackend,
  tryCreateRedisClient,
} from './runtime/index.js';
export type {
  CreateJobExecutionInput,
  DispatchJobOptions,
  JobExecutionRecord,
  JobQueuePayload,
  JobService,
} from './jobs/index.js';
export {
  JobExecutionSource,
  JobExecutionStatus,
  createJobService,
  dispatchQueuedJob,
  jobEventType,
  jobExecutionsTable,
  registerJobStatusRoute,
} from './jobs/index.js';

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
} from './governance/index.js';
