import type { z } from 'zod';
import type { AuditService } from './audit.js';
import type { ErrorService } from './errors.js';
import type {
  RegisteredAppConfig,
  RegisteredEntities,
  RegisteredEventName,
  RegisteredEventPayloadMap,
  RegisteredFlowName,
} from './registry.js';
import type { AuthContext } from './security.js';
import type { TranslationService } from './translation.js';

// ── Query Options (pagination, sorting, date ranges) ──
export interface QueryOptions {
  /** Max rows to return (1–100). Omit for no limit. */
  limit?: number;
  /** Number of rows to skip (default 0) */
  offset?: number;
  /** Column name to sort by — validated against entity table columns */
  orderBy?: string;
  /** Sort direction (default 'desc') */
  orderDir?: 'asc' | 'desc';
  /** Date range filters: { columnName: { gte?: Date, lte?: Date } } */
  dateFilters?: Record<string, { gte?: Date; lte?: Date }>;
}

// ── Repository (per-entity data access) ──
export interface Repository<
  T = Record<string, any>,
  TCreate = Record<string, any>,
  TUpdate = Record<string, any>,
> {
  findById(id: string): Promise<T | null>;
  create(data: TCreate): Promise<T>;
  /**
   * Bulk-create N records in a single database round-trip plus one summary
   * audit row per batch. Empty arrays short-circuit to `[]` without touching
   * the database. Use for hot paths that would otherwise call `create()` in a
   * loop (typically > ~10 records).
   */
  createMany(records: TCreate[]): Promise<T[]>;
  update(id: string, updates: TUpdate): Promise<T>;
  delete(id: string): Promise<void>;
  findMany(query?: Partial<T>, options?: QueryOptions): Promise<T[]>;
  count(query?: Partial<T>, options?: Pick<QueryOptions, 'dateFilters'>): Promise<number>;
}

// ── Data Service (all entity repositories) ──
// Uses RegisteredEntities from the type registry. When consumer apps run
// `plumbus generate`, a module augmentation populates PlumbusRegistry.entities
// with typed repository mappings. Until then, falls back to Record<string, Repository>.
export type DataService = RegisteredEntities;

// ── Event Service ──
export interface EventService {
  emit<E extends RegisteredEventName>(
    eventName: E,
    payload: RegisteredEventPayloadMap[E],
  ): Promise<void>;

  /**
   * Bulk-emit N events in a single outbox INSERT plus one summary audit row.
   * Empty arrays short-circuit without touching the database. All events in
   * a single call must share the same event name so TypeScript can still
   * enforce the payload shape.
   */
  emitMany<E extends RegisteredEventName>(
    events: Array<{ eventName: E; payload: RegisteredEventPayloadMap[E] }>,
  ): Promise<void>;
}

// ── Flow Execution Handle ──
export interface FlowExecution {
  id: string;
  flowName: string;
  status: string;
}

// ── Flow Service ──
export interface FlowService {
  start(flowName: RegisteredFlowName, input: unknown): Promise<FlowExecution>;
  resume(executionId: string, signal?: unknown): Promise<void>;
  cancel(executionId: string): Promise<void>;
  status(executionId: string): Promise<FlowExecution>;
  /** Extend the current flow execution lease. Only effective inside a flow step handler. Throws LeaseLostError if the lease has been lost. */
  heartbeat(): Promise<void>;
}

// ── AI Document (RAG retrieval result) ──
export interface AIDocument {
  content: string;
  source: string;
  score: number;
  metadata?: Record<string, unknown>;
}

// ── AI Stream Event ──
export interface AIStreamEvent {
  type: 'delta' | 'done' | 'error';
  /** Incremental text chunk (for delta events) */
  text?: string;
  /** Final validated data (for done events) */
  data?: Record<string, any>;
  /** Token usage from the provider (for done events) */
  usage?: AITokenUsage;
  /** Model name used (for done events) */
  model?: string;
  /** Provider name used (for done events) */
  provider?: string;
  /** Estimated cost in USD (for done events) */
  cost?: number;
  /**
   * Provider-reported termination reason (for done events). Typical values:
   * 'stop' (natural completion), 'length' (hit max_tokens — output was
   * truncated, not compressed), 'content_filter', 'tool_calls'. Lets callers
   * distinguish "model decided to stop short" from "model wanted to continue
   * but hit a hard ceiling", which shapes how they should escalate.
   */
  finishReason?: string;
  /**
   * True when the streaming JSON-validation fallback fired — i.e. the stream
   * produced invalid JSON and ai-service re-ran the call non-streaming to
   * recover a schema-valid result. Callers can use this to detect duplicate
   * billing and to mark the output as fragile.
   */
  validationFallbackFired?: boolean;
  /** Error message (for error events) */
  error?: string;
}

// ── Token Usage ──
export interface AITokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Tokens served from provider cache (charged at reduced rate). */
  cachedInputTokens?: number;
  /** Tokens written to provider cache (charged at elevated rate — Anthropic only). */
  cacheWriteTokens?: number;
}

// ── AI Generate Result with Usage ──
export interface AIGenerateResult {
  data: Record<string, any>;
  usage: AITokenUsage;
  model: string;
  provider: string;
  /** Estimated cost in USD based on published per-token rates. 0 for unknown models. */
  cost: number;
}

export interface AIValidationOptions {
  /** Additional retries after the first structured-output attempt fails validation. */
  maxRetries?: number;
  /** Whether to append the previous validation error to the retry prompt. */
  feedbackOnError?: boolean;
}

/**
 * Per-call billing metadata attached to `ctx.ai.*` invocations. When the
 * framework's `onAICostRecorded` hook is installed (via
 * `ServerConfig.onAICostRecorded`) it receives this alongside the cost
 * record and can persist a ledger row scoped to the project / operation.
 *
 * All fields are optional — a missing `costContext` is a no-op, preserving
 * pre-0.3.0 behavior for consumers that haven't opted in.
 */
export interface AICostContext {
  /** Tenant-level project this AI call belongs to (primary grouping key). */
  projectId?: string;
  /** High-level area inside the project (e.g. "interview", "documents"). */
  serviceArea?: string;
  /** Name of the operation / capability making the call. */
  operationName?: string;
  /** Entity type this AI call was operating on (for dashboards). */
  relatedEntityType?: string;
  /** Entity ID this AI call was operating on. */
  relatedEntityId?: string;
}

// ── AI Service ──
export interface AIService {
  generate(config: {
    prompt: string;
    input: Record<string, unknown>;
    validation?: AIValidationOptions;
    /** Abort the in-flight HTTP request to the provider when this signal fires. Defaults to ctx.signal inside flow steps. */
    signal?: AbortSignal;
    /** Per-call billing metadata forwarded to the framework `onAICostRecorded` hook. */
    costContext?: AICostContext;
    /** Deterministic sampling seed forwarded to providers that support it (OpenAI-compatible). Ignored by others. */
    seed?: number;
  }): Promise<Record<string, any>>;

  /** Like generate(), but also returns actual token usage from the provider */
  generateWithUsage(config: {
    prompt: string;
    input: Record<string, unknown>;
    validation?: AIValidationOptions;
    /** Abort the in-flight HTTP request to the provider when this signal fires. Defaults to ctx.signal inside flow steps. */
    signal?: AbortSignal;
    /** Per-call billing metadata forwarded to the framework `onAICostRecorded` hook. */
    costContext?: AICostContext;
    /** Deterministic sampling seed forwarded to providers that support it (OpenAI-compatible). Ignored by others. */
    seed?: number;
  }): Promise<AIGenerateResult>;

  /** Stream AI generation, yielding incremental text deltas and a final validated result */
  streamGenerate(config: {
    prompt: string;
    input: Record<string, unknown>;
    /** Abort the stream when this signal fires. Defaults to ctx.signal inside flow steps. */
    signal?: AbortSignal;
    /** Per-call billing metadata forwarded to the framework `onAICostRecorded` hook. */
    costContext?: AICostContext;
    /** Deterministic sampling seed forwarded to providers that support it (OpenAI-compatible). Ignored by others. */
    seed?: number;
  }): AsyncIterable<AIStreamEvent>;

  extract(config: {
    schema: z.ZodTypeAny;
    text: string;
    prompt?: string;
    input?: Record<string, unknown>;
    signal?: AbortSignal;
    /** Per-call billing metadata forwarded to the framework `onAICostRecorded` hook. */
    costContext?: AICostContext;
  }): Promise<Record<string, any>>;

  classify(config: {
    labels: string[];
    text: string;
    signal?: AbortSignal;
    /** Per-call billing metadata forwarded to the framework `onAICostRecorded` hook. */
    costContext?: AICostContext;
  }): Promise<string[]>;

  retrieve(config: { query: string; signal?: AbortSignal }): Promise<AIDocument[]>;
}

// ── Logger Service ──
export interface LoggerService {
  debug(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}

// ── Time Service ──
export interface TimeService {
  now(): Date;
}

// ── Config Service ──
export type ConfigService = RegisteredAppConfig;

// ── Security Service ──
export interface SecurityService {
  /** Check if the current user has a specific role */
  hasRole(role: string): boolean;
  /** Check if the current user has a specific scope */
  hasScope(scope: string): boolean;
  /** Check if the current user has all specified roles */
  hasAllRoles(roles: string[]): boolean;
  /** Check if the current user has all specified scopes */
  hasAllScopes(scopes: string[]): boolean;
  /** Throw a forbidden error if the user does not have the required role */
  requireRole(role: string): void;
  /** Throw a forbidden error if the user does not have the required scope */
  requireScope(scope: string): void;
}

// ── Request Metadata ──
export interface RequestMeta {
  /** Client IP address (may reflect X-Forwarded-For when behind a proxy) */
  sourceIp?: string;
  /** HTTP User-Agent header */
  userAgent?: string;
}

// ── Execution Context ──
export interface ExecutionContext {
  auth: AuthContext;
  data: DataService;
  events: EventService;
  flows: FlowService;
  ai: AIService;
  audit: AuditService;
  errors: ErrorService;
  logger: LoggerService;
  time: TimeService;
  config: ConfigService;
  security: SecurityService;
  translations: TranslationService;
  /** HTTP request metadata (IP, User-Agent) — present when invoked via HTTP */
  request?: RequestMeta;

  /** Worker process identity — present when running inside a flow worker */
  workerId?: string;

  // Flow-specific (only present inside flow step execution)
  state?: unknown;
  step?: string;
  flowId?: string;
  /**
   * Aborted when the current flow step is cancelled (by `flows.cancel`) or
   * when the worker loses its lease on the execution. Capability handlers
   * should check `ctx.signal?.aborted` in long-running loops and pass the
   * signal to AI/HTTP calls (most AI helpers default `signal` to `ctx.signal`
   * automatically). Undefined outside a flow step.
   */
  signal?: AbortSignal;
}
