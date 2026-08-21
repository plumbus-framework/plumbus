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
  AIProviderCapabilities,
  AISecurityConfig,
  AISecurityMode,
  AIServiceConfig,
  AITool,
  AIToolCall,
  AIToolChoice,
  AIToolExecutionOptions,
  AnthropicAdapterConfig,
  BudgetCheckResult,
  BudgetConfig,
  ChunkConfig,
  ChatMessage,
  CostTracker,
  DailyUsage,
  DerivedLedgerUsage,
  DocumentChunk,
  EmbeddingRequest,
  EmbeddingResponse,
  ExplainabilityConfig,
  IngestDocumentInput,
  Kind,
  LedgerUsageKind,
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
  RunToolLoopParams,
  RunToolLoopResult,
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
  GovernedAiHost,
  GovernedBudgetCheckInput,
  GovernedBudgetCheckResult,
  GovernedBudgetInput,
  GovernedInvokeDeps,
  GovernedInvokeInput,
  GovernedInvokeSuccess,
  GovernedModel,
  GovernedModelPin,
  GovernedModelRequest,
  GovernedModelResult,
  GovernedModelUsage,
  GovernedArtifact,
  GovernedArtifactKind,
  GovernedArtifactStore,
  PublishedGovernedArtifact,
  PlumbusRuntime,
  PlumbusRuntimeCallOptions,
  PlumbusRuntimeConfig,
  PlumbusRuntimeContextDeps,
  PlumbusRuntimeEventPump,
  PlumbusRuntimeEvents,
  PlumbusRuntimeFlows,
  PlumbusRuntimeSubscriptions,
  PlumbusRuntimeTimers,
} from './ai/index.js';
// ── AI Runtime ──
export {
  PromptRegistry,
  UsageAPIError,
  allKnownModels,
  calculateModelCost,
  checkGovernedBudget,
  checkPromptSecurity,
  createFilesystemGovernedArtifactStore,
  createMemoryGovernedArtifactStore,
  createPlumbusRuntime,
  digestGovernedArtifact,
  buildAISecurityConfig,
  chunkDocument,
  createAIService,
  createAnthropicAdapter,
  createCostTracker,
  deriveLedgerUsage,
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
  governedReviewSubject,
  invokeGovernedAi,
  joinAndFilterModels,
  runToolLoop,
  safeJsonStringify,
  zodToProviderJsonSchema,
  singleProviderConfig,
  ProviderJsonSchemaError,
  normalizeFinishReason,
  AIIncompleteOutputError,
  AIInvalidRequestError,
  AIRefusalError,
  GovernedArtifactConflictError,
} from './ai/index.js';
export type { RouteGeneratorConfig } from './api/index.js';
// ── API (HTTP route generation) ──
export {
  authenticationFailureToHttp,
  buildAuthenticationRequest,
  isApiExposed,
  parseCookieHeader,
  registerAllRoutes,
  registerCapabilityRoute,
  registerStreamingRoute,
  resolveRequestLocale,
  LOCALE_COOKIE_NAME,
} from './api/index.js';
export type { AuditEvent, AuditWriter } from './types/audit.js';
export type { AuditServiceConfig } from './audit/index.js';
// ── Audit ──
export { auditRecords, createAuditService, createDatabaseAuditWriter } from './audit/index.js';
export type {
  AuthenticationRequest,
  AuthenticationResult,
  AuthAdapter,
  JwtAdapterConfig,
  JwtClaimMapping,
  OidcAdapterConfig,
  OidcJwk,
  PasswordHashOptions,
  RequestAuthenticator,
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
  createCompositeRequestAuthenticator,
  createJwtAdapter,
  createOidcAdapter,
  createSamlAdapter,
  createScimService,
  hashPassword,
  signJwt,
  verifyPassword,
  wrapAuthAdapter,
} from './auth/index.js';
export type { ConfigLoadOptions, ConfigValidationResult } from './config/index.js';
// ── Config Loader ──
export { loadConfig, parseDurationToMs, validateConfig } from './config/index.js';
export type {
  MigrationApplyResult,
  MigrationConfig,
  MigrationRecord,
  MigrationRollbackResult,
  RepositoryOptions,
} from './data/index.js';
// ── Data Layer ──
export {
  EntityRegistry,
  applyMigrations,
  collectMaskedFieldsFromEntities,
  collectSchemas,
  createRepository,
  decryptFieldValue,
  encryptFieldValue,
  generateDrizzleSchema,
  generateSchemas,
  getEncryptedFields,
  getMaskedFields,
  gte,
  ilike,
  isEncryptedValue,
  like,
  lte,
  resolveEncryptionKey,
  rollbackLastMigration,
  sql,
  ENCRYPTION_PREFIX,
} from './data/index.js';
// ── Approvals / human tasks (Plan 02 Stage 4) ──
export {
  createApprovalService,
  createMemoryApprovalStore,
  createSqlApprovalStore,
} from './approvals/index.js';
export type { ApprovalService, AuthorizationProvider } from './approvals/index.js';
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
  AIBudgetExceededError,
  AISecurityBlockedError,
  GovernedAiBlockedError,
  BudgetExhaustedError,
  DataForbiddenError,
  DataInternalError,
  DataValidationError,
  EncryptionConfigError,
  EncryptionPayloadError,
  FlowCancelledError,
  LeaseLostError,
  PlumbusError,
  UnauthorizedError,
  createErrorService,
  isPlumbusError,
} from './errors/index.js';
export type { GovernedAiBlockedCode } from './errors/data-errors.js';
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
  evaluateEventSubscriptionDelivery,
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
//
// `createExecutionContext` is deliberately absent from this barrel: it mints
// the platform-established actor, so it lives on the framework-internal seam
// `@plumbus/core/runtime` (see `src/runtime-entry.ts`). Code that hosts a
// transport or bootstraps a server imports it from there; capability bodies
// receive a context and never build one; tests use `@plumbus/core/testing`.
export {
  buildCapabilityRuntimeDeps,
  CapabilityRegistry,
  evaluateAccess,
  executeCapability,
  getCanonicalCapabilityName,
  isCanonicalCapabilityName,
} from './execution/index.js';
export type {
  DependencyViolationMetadata,
  DependencyViolationReason,
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
  COMPILED_FLOW_CONTRACT_VERSION,
  CompiledFlowRegistry,
  DEFINITION_STRATEGY_NOT_SUPPORTED,
  DefinitionInFlightStrategy,
  DefinitionStrategyNotSupportedError,
  FlowRegistry,
  FlowStatus,
  StepStatus,
  assertSupportedDefinitionStrategy,
  assertTransition,
  buildHistoryEntry,
  compileFlowDefinition,
  DEFAULT_SCHEDULE_CATCH_UP_MAX,
  computeNextRun,
  computeRetryDelay,
  createFlowEngine,
  createFlowScheduler,
  createFlowService,
  createFlowTriggerHandler,
  createExecutionBudgetLedger,
  chargeExecutionBudget,
  deadLetterFlow,
  executeStep,
  flowDeadLetterTable,
  flowDefinitionId,
  flowExecutionsTable,
  flowSchedulesTable,
  generateWorkerId,
  hydrateCompiledFlow,
  isTerminal,
  planMissedSchedule,
  isValidTransition,
  retryDeadLetteredFlow,
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
  withLogMasking,
  createTraceContext,
  createTracer,
  extractTraceFromHeaders,
  formatTraceparent,
  generateSpanId,
  generateTraceId,
  injectTraceHeaders,
  parseTraceparent,
} from './observability/index.js';
export type {
  AuthComponentHealth,
  HttpAuthenticationRuntime,
  PlumbusServer,
  ServerConfig,
} from './server/index.js';
// ── Server Bootstrap ──
export { createServer } from './server/index.js';
// ── Translations ──
export type {
  LocaleStatus,
  NamespaceStatus,
  TranslationStatus,
} from './translations/index.js';
export {
  TranslationRegistry,
  computeStatus,
  createTranslationResolver,
  createTranslationService,
  formatTranslationStatus,
} from './translations/index.js';
// ── Types (re-export everything) ──
export * from './types/index.js';
export type { WorkerPool, WorkerPoolConfig } from './worker/index.js';
// ── Worker Bootstrap ──
export { assertFlowLeaseColumns, createWorkerPool } from './worker/index.js';
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
  CreateJobDispatchServiceOptions,
  DispatchJobOptions,
  JobDispatchService,
  JobExecutionRecord,
  JobQueuePayload,
  JobService,
} from './jobs/index.js';
export {
  JobExecutionSource,
  JobExecutionStatus,
  createDeferredJobDispatchService,
  createJobDispatchService,
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
  scanForbiddenPaths,
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

// ── Tenancy ──
export {
  DEFAULT_CORE_SCHEMA,
  DEFAULT_DATA_PLANE_CACHE_SIZE,
  DEFAULT_DATA_PLANE_POOL_SIZE,
  DEFAULT_PACKAGE_SCHEMA_PREFIX,
  DataPlaneConnectionError,
  DataPlaneGuardError,
  DataPlaneNameError,
  DataPlaneProvisioningError,
  MAX_DATA_PLANE_POOL_SIZE,
  UnknownTenantError,
  applyDataPlaneMigrations,
  assertSafeIdentifier,
  createPooledDataPlaneResolver,
  createSingleDataPlaneResolver,
  dropDataPlane,
  openDataPlaneConnection,
  provisionDataPlane,
  quoteIdentifier,
  DATA_PLANE_MIGRATE_APPLICATION_NAME,
} from './tenancy/index.js';
// ── Credential catalog (host-declared types, opaque refs; host supplies secrets) ──
export {
  CREDENTIAL_REDACTED,
  CredentialCatalogError,
  createMemoryCredentialCatalog,
} from './credentials/index.js';
export type {
  CredentialBinding,
  CredentialCatalog,
  CredentialFieldSpec,
  CredentialMaterial,
  CredentialRecord,
  CredentialResolver,
  CredentialTypeDeclaration,
  CredentialTypeRecord,
  MemoryCredentialCatalogOptions,
} from './credentials/index.js';
export type {
  ApplyDataPlaneMigrationsOptions,
  DataPlaneAdminConnection,
  DataPlaneConnectRequest,
  DataPlaneConnection,
  DataPlaneConnectionFields,
  DataPlaneConnectionTarget,
  DataPlaneConnectionUrl,
  DataPlaneDescriptor,
  DataPlaneDropResult,
  DataPlaneEndpoint,
  DataPlaneMigrationApplyResult,
  DataPlaneHandle,
  DataPlaneProvisionResult,
  DataPlaneResolver,
  DataPlaneRoleSpec,
  DataPlaneStep,
  DataPlaneStepName,
  DataPlaneStepOutcome,
  DataPlaneTablePrivilege,
  DropDataPlaneOptions,
  OpenDataPlaneConnectionOptions,
  OpenedDataPlaneConnection,
  PooledDataPlaneResolver,
  PooledDataPlaneResolverOptions,
  ProvisionDataPlaneOptions,
  SingleDataPlaneResolverOptions,
} from './tenancy/index.js';
