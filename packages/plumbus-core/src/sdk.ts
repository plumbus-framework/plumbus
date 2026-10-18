/**
 * Runtime SDK: primitives, execution, data, auth, events, flows, AI and config.
 * CLI commands and governance tooling remain on the compatibility root entry.
 */

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
  AICacheConfig,
  AIPromptCacheOption,
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
  ProviderAssistantState,
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
} from './ai/index.js';
// ── AI Runtime ──
export {
  PromptRegistry,
  UsageAPIError,
  allKnownModels,
  calculateModelCost,
  estimateModelCost,
  checkPromptSecurity,
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
export { loadAppConfig } from './config/index.js';
export type { ConfigOverrides } from './config/index.js';
export type { ConfigLoadOptions, ConfigValidationResult } from './config/index.js';
// ── Config Loader ──
export { loadConfig, parseDurationToMs, validateConfig } from './config/index.js';
export type {
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
  CapabilityErrorInfo,
  CapabilityResult,
  ContextDependencies,
  ExecutionFailure,
  ExecutionResult,
} from './execution/index.js';
// ── Execution Engine ──
export {
  buildCapabilityRuntimeDeps,
  CapabilityRegistry,
  createExecutionContext,
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
export type { VoiceRuntimeConfig } from './runtime/voice-runtime.js';
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

export type { RetryPolicy } from './config/index.js';
export type { EventDeliveryOptions, EventDeadLetterInfo } from './events/index.js';
