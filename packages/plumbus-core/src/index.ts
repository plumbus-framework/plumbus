// ── Types (re-export everything) ──
export * from './types/index.js';

// ── Define Functions (SDK surface) ──
export { defineCapability } from './define/defineCapability.js';
export { defineEntity } from './define/defineEntity.js';
export { defineEvent } from './define/defineEvent.js';
export { defineFlow } from './define/defineFlow.js';
export { definePrompt } from './define/definePrompt.js';

// ── Field Constructors ──
export { field } from './fields/index.js';

// ── Error Utilities ──
export { errorToHttpResponse, errorToHttpStatus } from './errors/http.js';
export { createErrorService, isPlumbusError } from './errors/index.js';

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
export type { MigrationConfig, MigrationRecord, RepositoryOptions } from './data/index.js';

// ── Execution Engine ──
export {
  CapabilityRegistry,
  createExecutionContext,
  evaluateAccess,
  executeCapability,
} from './execution/index.js';
export type {
  AuthorizationResult,
  CapabilityResult,
  ContextDependencies,
  ExecutionFailure,
  ExecutionResult,
} from './execution/index.js';

// ── Auth ──
export { createJwtAdapter } from './auth/index.js';
export type { AuthAdapter, JwtAdapterConfig, JwtClaimMapping } from './auth/index.js';

// ── Audit ──
export { auditRecords, createAuditService } from './audit/index.js';
export type { AuditServiceConfig } from './audit/index.js';

// ── API ──
export { registerAllRoutes, registerCapabilityRoute } from './api/index.js';
export type { RouteGeneratorConfig } from './api/index.js';

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
  FlowEngineConfig,
  SchedulerConfig,
  StepExecutorDeps,
  StepHistoryEntry,
  StepResult,
} from './flows/index.js';

// ── AI Runtime ──
export {
  PromptRegistry,
  checkPromptSecurity,
  chunkDocument,
  createAIService,
  createAnthropicAdapter,
  createCostTracker,
  createExplainabilityTracker,
  createInMemoryVectorStore,
  createOpenAIAdapter,
  createRAGPipeline,
  documentChunksTable,
  documentsTable,
  estimateCost,
  generateWithValidation,
} from './ai/index.js';
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
  ValidatedResponse,
  ValidationRetryConfig,
  VectorStore,
} from './ai/index.js';

// ── CLI ──
export {
  // Templates
  capabilityTemplate,
  capabilityTestTemplate,
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
  // Policy certification
  evaluatePolicy,
  eventTemplate,
  flowTemplate,
  generateAgentsMd,
  // Code generation
  generateAll,
  // Agent briefs
  generateCapabilityBrief,
  generateClientFunction,
  // Agent wiring
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
  ruleCapabilityAccessPolicy,
  ruleCapabilityEffects,
  ruleEncryptedSensitiveFields,
  ruleEntityFieldClassification,
  ruleEntityTenantIsolation,
  // Dev
  runDev,
  // Doctor
  runDoctorChecks,
  runFullDoctorChecks,
  // Governance
  runGovernanceRules,
  startDevServer,
  toCamelCase,
  // Utilities
  toKebabCase,
  toPascalCase,
  writeAgentFiles,
} from './cli/index.js';
export type {
  AgentFormat,
  CreateOptions,
  DevOptions,
  DoctorCheck,
  InitOptions,
  PolicyContext,
  PolicyRule,
} from './cli/index.js';

// ── Governance ──
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

// ── Explanation ──
export { createExplanationTracker } from './explanation/index.js';
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

// ── Server Bootstrap ──
export { createServer } from './server/index.js';
export type { PlumbusServer, ServerConfig } from './server/index.js';

// ── Worker Bootstrap ──
export { createWorkerPool } from './worker/index.js';
export type { WorkerPool, WorkerPoolConfig } from './worker/index.js';

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

// ── Config Loader ──
export { loadConfig, validateConfig } from './config/index.js';
export type { ConfigLoadOptions, ConfigValidationResult } from './config/index.js';
