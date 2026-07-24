// ── Types Module ──
// All TypeScript types and interfaces for the Plumbus framework.
// Organized by domain: enums, fields, capability, flow, entity, event,
// context (ExecutionContext + service interfaces), security, governance, etc.

// ── Audit ──
export type { AuditRecord, AuditService } from './audit.js';
// ── Capability ──
export type {
  ApiDeprecationConfig,
  ApiDocsConfig,
  ApiExposureConfig,
  ApiHttpMethod,
  ApiIdempotencyConfig,
  ApiStability,
  ApiTestConfig,
  ApiTestMode,
  CapabilityAuditConfig,
  CapabilityContract,
  CapabilityEffects,
  CapabilityExplanationConfig,
  CapabilityExposeAs,
  McpExposureConfig,
} from './capability.js';
// ── Config ──
export type {
  AIProviderConfig,
  AIProvidersConfig,
  AuthAdapterConfig,
  DatabaseConfig,
  Environment,
  McpAgentConfig,
  McpConfig,
  PlumbusConfig,
  PromptModelOverride,
  QueueConfig,
} from './config.js';
// ── Context ──
export type {
  AIDocument,
  AIFinalGenerateResult,
  AIGenerateConfig,
  AIGenerateResult,
  AIGenerateWithUsageConfig,
  AIService,
  AIStreamEvent,
  AITokenUsage,
  AIToolCallsGenerateResult,
  AIToolEnabledGenerateResult,
  ConfigService,
  DataService,
  EventService,
  ExecutionContext,
  FlowDescription,
  FlowExecution,
  FlowService,
  LoggerService,
  AggregateOptions,
  AggregateRow,
  AggregateValue,
  QueryOptions,
  Repository,
  ConditionalUpdateResult,
  RequestMeta,
  SecurityService,
  TimeService,
} from './context.js';
// ── Entity ──
export type { EntityDefinition, EntityIndexDefinition, EntityRetention } from './entity.js';
// ── Enums & Constants ──
export {
  BackoffStrategy,
  CapabilityKind,
  ErrorCode,
  FieldClassification,
  FlowStepType,
  GovernanceSeverity,
  PolicyProfile,
  RelationType,
  RuleStatus,
} from './enums.js';
// ── Errors ──
export type { ErrorService, PlumbusErrorLike } from './errors.js';
// ── Event ──
export type { EventDefinition, EventEnvelope } from './event.js';
// ── Field Types ──
export type {
  BaseFieldOptions,
  BooleanFieldDescriptor,
  EnumFieldDescriptor,
  FieldDescriptor,
  IdFieldDescriptor,
  JsonFieldDescriptor,
  NumberFieldDescriptor,
  RelationFieldDescriptor,
  StringFieldDescriptor,
  TimestampFieldDescriptor,
} from './fields.js';
// ── Flow ──
export type {
  CapabilityStep,
  ConditionalStep,
  DelayStep,
  EventEmitStep,
  FlowDefinition,
  FlowRetryPolicy,
  FlowSchedule,
  FlowStep,
  FlowTrigger,
  ParallelStep,
  WaitStep,
} from './flow.js';
// ── Governance ──
export type {
  GovernanceOverride,
  GovernanceSignal,
  PolicyReport,
  RuleEvaluation,
} from './governance.js';
// ── Prompt ──
export type { ModelConfig, PromptDefinition } from './prompt.js';
// ── Registry ──
export type {
  PlumbusRegistry,
  RegisteredAppConfig,
  RegisteredCapabilityName,
  RegisteredEntities,
  RegisteredEventName,
  RegisteredEventPayloadMap,
  RegisteredFlowName,
} from './registry.js';
// ── Security ──
export type { AccessPolicy, AuthContext } from './security.js';
// ── Translation ──
export type {
  MessageCatalog,
  TranslationDefinition,
  TranslationResolver,
  TranslationService,
} from './translation.js';
