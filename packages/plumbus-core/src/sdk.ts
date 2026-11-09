/**
 * Runtime SDK: primitives, execution, data, auth, events, flows, AI and config.
 * CLI commands and governance tooling remain on the compatibility root entry.
 *
 * `createExecutionContext` is deliberately absent: it mints the
 * platform-established actor, so it lives on the framework-internal seam
 * `@plumbus/core/runtime` (see `src/runtime-entry.ts`).
 */

export type { RequestAdmissionChallenge, RequestAdmissionProof } from './admission/index.js';
export {
  createRequestAdmission,
  requestAdmissionChallengeSchema,
  requestAdmissionProofSchema,
  withRequestAdmissionLock,
} from './admission/index.js';
export type {
  AICacheConfig,
  AICostRecord,
  AIExplainabilityTracker,
  AIInvocationRecord,
  AIPromptCacheOption,
  AIPromptCacheTtl,
  AIProviderAdapter,
  AIProviderCallContext,
  AIProviderCapabilities,
  AIProviderConcurrencyConfig,
  AIProviderOperation,
  AIProviderSpan,
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
  ChatMessage,
  ChunkConfig,
  CostTracker,
  DailyUsage,
  DerivedLedgerUsage,
  DocumentChunk,
  EmbeddingRequest,
  EmbeddingResponse,
  ExplainabilityConfig,
  GovernedAiHost,
  GovernedArtifact,
  GovernedArtifactKind,
  GovernedArtifactStore,
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
  IngestDocumentInput,
  Kind,
  LedgerUsageKind,
  ListModelsFilter,
  ModelRate,
  OpenAIAdapterConfig,
  PlumbusRuntime,
  PlumbusRuntimeCallOptions,
  PlumbusRuntimeConfig,
  PlumbusRuntimeContextDeps,
  PlumbusRuntimeEventPump,
  PlumbusRuntimeEvents,
  PlumbusRuntimeFlows,
  PlumbusRuntimeSubscriptions,
  PlumbusRuntimeTimers,
  ProviderAssistantState,
  ProviderCooldownWait,
  ProviderJsonSchemaOptions,
  ProviderJsonSchemaResult,
  ProviderModel,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  PublishedGovernedArtifact,
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
} from './ai/index.js';
// ── AI Runtime ──
export {
  AIIncompleteOutputError,
  AIInvalidRequestError,
  AIRefusalError,
  AIValidationError,
  allKnownModels,
  buildAISecurityConfig,
  calculateModelCost,
  checkGovernedBudget,
  checkPromptSecurity,
  chunkDocument,
  createAIService,
  createAnthropicAdapter,
  createCostTracker,
  createExplainabilityTracker,
  createFilesystemGovernedArtifactStore,
  createInMemoryVectorStore,
  createMemoryGovernedArtifactStore,
  createOpenAIAdapter,
  createPlumbusRuntime,
  createPromptRegistry,
  createProviderAdapter,
  createRAGPipeline,
  createUsageAPIClient,
  DEFAULT_GOVERNED_ARTIFACTS_DIRECTORY,
  deriveLedgerUsage,
  digestGovernedArtifact,
  documentChunksTable,
  documentsTable,
  estimateModelCost,
  extendProviderCooldown,
  fillPromptTemplate,
  findModelRate,
  GovernedArtifactConflictError,
  generateWithValidation,
  governedReviewSubject,
  invokeGovernedAi,
  isProviderAPIError,
  isProviderTimeoutError,
  joinAndFilterModels,
  normalizeFinishReason,
  PromptRegistry,
  ProviderAPIError,
  ProviderJsonSchemaError,
  parseRetryAfterMs,
  providerCooldownRemainingMs,
  resetProviderCooldowns,
  resolveGovernedArtifactStore,
  runToolLoop,
  safeJsonStringify,
  singleProviderConfig,
  sleepUnlessAborted,
  UsageAPIError,
  waitForProviderCooldown,
  zodToProviderJsonSchema,
} from './ai/index.js';
export type {
  DatabaseIdempotencyStoreOptions,
  ExecuteIdempotentlyParams,
  IdempotencyClaimResult,
  IdempotencyPrincipal,
  IdempotencyRecord,
  IdempotencyStore,
  IdempotencyStoreOptions,
  IdempotencySweepOptions,
  IdempotentExecutionOutcome,
  InMemoryIdempotencyStoreOptions,
  RequestIdOptions,
  RouteGeneratorConfig,
  RouteRequestIds,
} from './api/index.js';
// ── API (HTTP route generation) ──
export {
  authenticationFailureToHttp,
  buildAuthenticationRequest,
  buildIdempotencyStoreKey,
  capabilityHttpMethod,
  createDatabaseIdempotencyStore,
  createInMemoryIdempotencyStore,
  DEFAULT_IN_MEMORY_IDEMPOTENCY_MAX_ENTRIES,
  DEFAULT_IN_MEMORY_IDEMPOTENCY_TTL_MS,
  executeIdempotently,
  hashPayload,
  IdempotencyAbortedError,
  IdempotencyClaimLostError,
  isAnonymousIdempotencyPrincipal,
  isApiExposed,
  LOCALE_COOKIE_NAME,
  MAX_PAYLOAD_DEPTH,
  PayloadTooDeepError,
  parseCookieHeader,
  parseIdempotencyTtl,
  principalsMatch,
  isWellFormedRequestId,
  REQUEST_ID_HEADER,
  REQUEST_IDEMPOTENCY_TABLE,
  registerAllRoutes,
  registerCapabilityRoute,
  registerStreamingRoute,
  requestIdempotencyDdl,
  requestIdOf,
  requestIdsFor,
  resolveRequestId,
  resolveRequestLocale,
  sweepExpiredIdempotencyRecords,
  withRequestId,
} from './api/index.js';
export type {
  ApprovalBinding,
  ApprovalService,
  AuthorizationProvider,
  CancelApprovalInput,
} from './approvals/index.js';
// ── Approvals / human tasks ──
export {
  ApprovalDecisionConflictError,
  createAllowAllAuthorizationProvider,
  createApprovalService,
  createMemoryApprovalStore,
  createSqlApprovalStore,
} from './approvals/index.js';
export type { AuditServiceConfig } from './audit/index.js';
// ── Audit ──
export { auditRecords, createAuditService, createDatabaseAuditWriter } from './audit/index.js';
export type {
  AuthAdapter,
  AuthenticationRequest,
  AuthenticationResult,
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
// ── Retry policy and event delivery options ──
export type {
  ConfigLoadOptions,
  ConfigOverrides,
  ConfigValidationResult,
  RetryPolicy,
} from './config/index.js';
// ── Config Loader ──
export { loadAppConfig, loadConfig, parseDurationToMs, validateConfig } from './config/index.js';
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
// ── Credential catalog (host-declared types, opaque refs; host supplies secrets) ──
export {
  CREDENTIAL_REDACTED,
  CredentialCatalogError,
  createMemoryCredentialCatalog,
} from './credentials/index.js';
export type {
  MigrationApplyResult,
  MigrationConfig,
  MigrationRecord,
  MigrationRollbackResult,
  RepositoryOptions,
} from './data/index.js';
// ── Data Layer ──
export {
  applyMigrations,
  collectMaskedFieldsFromEntities,
  collectSchemas,
  createRepository,
  decryptBytes,
  decryptFieldValue,
  ENCRYPTION_PREFIX,
  EntityRegistry,
  encryptBytes,
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
  MIGRATION_ADVISORY_LOCK_KEY,
  resolveEncryptionKey,
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
export type { GovernedAiBlockedCode } from './errors/data-errors.js';
// ── Error Utilities ──
export { errorToHttpResponse, errorToHttpStatus } from './errors/http.js';
export {
  AIBudgetExceededError,
  AISecurityBlockedError,
  BudgetExhaustedError,
  createErrorService,
  DataForbiddenError,
  DataInternalError,
  DataValidationError,
  EncryptionConfigError,
  EncryptionPayloadError,
  FlowCancelledError,
  FlowDefinitionUnavailableError,
  FlowDefinitionUnavailableReason,
  GovernedAiBlockedError,
  isPlumbusError,
  LeaseLostError,
  PlumbusError,
  UnauthorizedError,
} from './errors/index.js';
export type {
  DispatcherConfig,
  EventConsumer,
  EventConsumerHandler,
  EventDeadLetterInfo,
  EventDeliveryOptions,
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
  createEventEmitter,
  createEventWorker,
  createIdempotencyService,
  createInMemoryQueue,
  createOutboxDispatcher,
  createRedisQueue,
  deadLetterTable,
  EventRegistry,
  evaluateEventSubscriptionDelivery,
  idempotencyTable,
  outboxTable,
} from './events/index.js';
export type {
  AuthorizationResult,
  CapabilityErrorInfo,
  CapabilityResult,
  ContextDependencies,
  DependencyViolationMetadata,
  DependencyViolationReason,
  ExecuteCapabilityOptions,
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
  authorizeCapability,
  buildCapabilityRuntimeDeps,
  CapabilityRegistry,
  evaluateAccess,
  executeCapability,
  getCanonicalCapabilityName,
  isCanonicalCapabilityName,
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
  FlowDefinitionUnavailableInfo,
  FlowEngineConfig,
  FrameworkRetentionOptions,
  FrameworkRetentionResult,
  PruneFrameworkTablesOptions,
  SchedulerConfig,
  StepExecutorDeps,
  StepHistoryEntry,
  StepResult,
} from './flows/index.js';
// ── Flows ──
export {
  assertSupportedDefinitionStrategy,
  assertTransition,
  buildHistoryEntry,
  COMPILED_FLOW_CONTRACT_VERSION,
  CompiledFlowRegistry,
  chargeExecutionBudget,
  compileFlowDefinition,
  computeNextRun,
  computeRetryDelay,
  createExecutionBudgetLedger,
  createFlowEngine,
  createFlowScheduler,
  createFlowService,
  createFlowTriggerHandler,
  DEFAULT_COMPILED_FLOWS_DIRECTORY,
  DEFAULT_SCHEDULE_CATCH_UP_MAX,
  DEFINITION_STRATEGY_NOT_SUPPORTED,
  DefinitionInFlightStrategy,
  DefinitionStrategyNotSupportedError,
  deadLetterFlow,
  executeStep,
  FlowRegistry,
  FlowStatus,
  FRAMEWORK_RETENTION_DEFAULTS,
  flowDeadLetterTable,
  flowDefinitionId,
  flowExecutionsTable,
  flowSchedulesTable,
  generateWorkerId,
  hydrateCompiledFlow,
  isTerminal,
  isValidTransition,
  loadCompiledFlowRegistryFromDirectory,
  planMissedSchedule,
  pruneFrameworkTables,
  pruneSpineDispatchHints,
  resolveFrameworkRetentionOptions,
  retryDeadLetteredFlow,
  StepStatus,
  sweepFailedFlows,
  tryLoadCompiledFlowRegistryFromDirectory,
} from './flows/index.js';
export type {
  CreateJobDispatchServiceOptions,
  CreateJobExecutionInput,
  DispatchJobOptions,
  JobDispatchService,
  JobExecutionRecord,
  JobQueuePayload,
  JobService,
} from './jobs/index.js';
export {
  createDeferredJobDispatchService,
  createJobDispatchService,
  createJobService,
  dispatchQueuedJob,
  JobExecutionSource,
  JobExecutionStatus,
  jobEventType,
  jobExecutionsTable,
  registerJobStatusRoute,
} from './jobs/index.js';
export type {
  CompletedTelemetrySpan,
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
  TelemetrySpanHook,
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
  withLogMasking,
} from './observability/index.js';
export type {
  AppBootContext,
  BuildWorkerAiServiceOptions,
  OnBootHook,
  OnShutdownHook,
  RegisterCapabilityConsumersOptions,
  ResolveRuntimeQueuesOptions,
  RuntimeCommand,
  RuntimeQueues,
  ServerExtensions,
  ShutdownContext,
} from './runtime/index.js';
export {
  buildStepDeps,
  buildWorkerAiService,
  discoverRuntimeResources,
  needsWorkerPool,
  RuntimeRole,
  registerCapabilityConsumers,
  resolveRuntimeQueues,
  resolveRuntimeRole,
  shouldStartApiServer,
  shouldStartWorkerPool,
  shouldUseRedisBackend,
  tryCreateRedisClient,
} from './runtime/index.js';
// ── Process-level errors ──
export type {
  KeepAliveOptions,
  ProcessErrorClassifier,
  ProcessErrorHook,
  ProcessErrorInfo,
  ProcessErrorSeverity,
  ProcessErrorSource,
  RunScriptOptions,
} from './runtime/process-errors.js';
export { installKeepAliveProcessHandlers, runScript } from './runtime/process-errors.js';
export type { VoiceRuntimeConfig } from './runtime/voice-runtime.js';
export type { JsonSchemaObject, JsonSchemaTarget } from './schema/json-schema.js';
export { zodToJsonSchemaObject } from './schema/json-schema.js';
export { zodInputToJsonSchema } from './schema/zod-input-to-json-schema.js';
export type { ZodDefinition } from './schema/zod-introspection.js';
// ── Zod schema structure and JSON Schema ──
export {
  zodDefaultValue,
  zodDefinition,
  zodEnumValues,
  zodInnerType,
  zodObjectShape,
  zodTypeName,
} from './schema/zod-introspection.js';
export type {
  AuthComponentHealth,
  HttpAuthenticationRuntime,
  PlumbusServer,
  ServerConfig,
} from './server/index.js';
// ── Server Bootstrap ──
export { createServer } from './server/index.js';
export type {
  ApplyDataPlaneMigrationsOptions,
  DataPlaneAdminConnection,
  DataPlaneConnection,
  DataPlaneConnectionFields,
  DataPlaneConnectionTarget,
  DataPlaneConnectionUrl,
  DataPlaneConnectRequest,
  DataPlaneDescriptor,
  DataPlaneDropResult,
  DataPlaneEndpoint,
  DataPlaneHandle,
  DataPlaneMigrationApplyResult,
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
// ── Tenancy ──
export {
  applyDataPlaneMigrations,
  assertSafeIdentifier,
  createPooledDataPlaneResolver,
  createSingleDataPlaneResolver,
  DATA_PLANE_MIGRATE_APPLICATION_NAME,
  DataPlaneConnectionError,
  DataPlaneGuardError,
  DataPlaneNameError,
  DataPlaneProvisioningError,
  DEFAULT_CORE_SCHEMA,
  DEFAULT_DATA_PLANE_CACHE_SIZE,
  DEFAULT_DATA_PLANE_POOL_SIZE,
  DEFAULT_PACKAGE_SCHEMA_PREFIX,
  dropDataPlane,
  MAX_DATA_PLANE_POOL_SIZE,
  openDataPlaneConnection,
  provisionDataPlane,
  quoteIdentifier,
  UnknownTenantError,
} from './tenancy/index.js';
// ── Translations ──
export type {
  LocaleStatus,
  NamespaceStatus,
  TranslationStatus,
} from './translations/index.js';
export {
  computeStatus,
  createTranslationResolver,
  createTranslationService,
  formatTranslationStatus,
  TranslationRegistry,
} from './translations/index.js';
export type { AuditEvent, AuditWriter } from './types/audit.js';
// ── Types (re-export everything) ──
export * from './types/index.js';
export type { CollectionBoundViolation } from './validation/bounded-parse.js';
// ── Bounded input validation ──
export {
  DEFAULT_INPUT_ARRAY_MAX_ITEMS,
  findCollectionBoundViolation,
  resolveInputArrayMaxItems,
  safeParseBounded,
} from './validation/bounded-parse.js';
export type { WorkerPool, WorkerPoolConfig, WorkerPoolStopOptions } from './worker/index.js';
// ── Worker Bootstrap ──
export { assertFlowLeaseColumns, createWorkerPool } from './worker/index.js';
