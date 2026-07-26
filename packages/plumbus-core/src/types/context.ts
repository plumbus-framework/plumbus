import type { z } from 'zod';
import type { AICostRecordInput } from '../ai/cost-tracker.js';
import type {
  AITool,
  AIToolCall,
  AIToolChoice,
  AIToolExecutionOptions,
  ChatMessage,
} from '../ai/provider.js';

// Re-export the provider tool-calling protocol types on the context surface.
export type {
  AITool,
  AIToolCall,
  AIToolChoice,
  AIToolExecutionOptions,
  AIProviderCapabilities,
} from '../ai/provider.js';
import type { AuditService } from './audit.js';
import type { ErrorService } from './errors.js';
import type {
  RegisteredAppConfig,
  RegisteredCapabilityName,
  RegisteredEntities,
  RegisteredEventName,
  RegisteredEventPayloadMap,
  RegisteredFlowName,
} from './registry.js';
import type { InvocationEmitScope } from '../execution/invocation-emit-scope.js';
import type { CapabilityContract } from './capability.js';
import type { AuthContext } from './security.js';
import type { TranslationService } from './translation.js';

// ── Query Options (pagination, sorting, date ranges) ──
export interface QueryOptions {
  /** Max rows to return (1–100). Omit for no limit. */
  limit?: number;
  /** Number of rows to skip (default 0) */
  offset?: number;
  /** Column name or multi-column sort spec — validated against entity table columns */
  orderBy?: string | Array<{ column: string; dir?: 'asc' | 'desc' }>;
  /** Default sort direction (default 'desc') — applied to a string `orderBy`, and the fallback for array specs that omit `dir` */
  orderDir?: 'asc' | 'desc';
  /** Date range filters: { columnName: { gte?: Date, lte?: Date } } */
  dateFilters?: Record<string, { gte?: Date; lte?: Date }>;
  /** OR-of-ILIKE across the given entity fields for a free-text term. */
  search?: { columns: string[]; term: string };
  /** field → allowed values (SQL IN). Empty arrays ignored. */
  in?: Record<string, Array<string | number>>;
  /** field → value the row must NOT equal (SQL <>). */
  notEq?: Record<string, string | number>;
}

// ── Aggregate Options (SUM / AVG / MIN / MAX / COUNT / DISTINCT in SQL) ──

/** A value in an aggregate result row: a group-key value or a computed aggregate. */
export type AggregateValue = string | number | boolean | Date | null;

/**
 * One row returned by `Repository.aggregate`. Keys are:
 * - each `groupBy` column, carrying that group's value;
 * - `count` when `count: true` (COUNT(*), always a number);
 * - `sum_<col>` / `avg_<col>` / `min_<col>` / `max_<col>` per requested column;
 * - `countDistinct_<col>` per requested column (always a number).
 *
 * `sum_*`, `count`, and `countDistinct_*` are numbers — an empty SUM is `0`, not
 * `null`. `avg_*`/`min_*`/`max_*` are `null` over an empty set; `min_*`/`max_*`
 * otherwise mirror the column's stored type (the same representation `findMany`
 * returns for that column).
 */
export type AggregateRow = Record<string, AggregateValue>;

/**
 * Shape of an `aggregate()` call: WHERE filters (shared verbatim with
 * `findMany`/`count`), an optional GROUP BY, and the aggregate functions to
 * compute. The filter semantics (`dateFilters`/`search`/`in`/`notEq` plus the
 * `query` equality argument) are identical to `findMany`, so tenant scoping,
 * soft-delete filtering, and encrypted-field guards all apply unchanged.
 */
export interface AggregateOptions
  extends Pick<QueryOptions, 'dateFilters' | 'search' | 'in' | 'notEq'> {
  /** Columns to GROUP BY. Omit for a single grand-total row over all matches. */
  groupBy?: string | string[];
  /** Columns to SUM — each emits `sum_<col>` (numeric; empty set = `0`). */
  sum?: string | string[];
  /** Columns to average — each emits `avg_<col>` (numeric; empty set = `null`). */
  avg?: string | string[];
  /** Columns to take the minimum of — each emits `min_<col>`. */
  min?: string | string[];
  /** Columns to take the maximum of — each emits `max_<col>`. */
  max?: string | string[];
  /** Include `COUNT(*)` as `count` in every row. */
  count?: boolean;
  /** Columns for `COUNT(DISTINCT col)` — each emits `countDistinct_<col>` (numeric). */
  countDistinct?: string | string[];
  /**
   * Order the grouped rows. Column names may be group columns or aggregate
   * aliases (e.g. `sum_cost`, `count`). Unknown names are ignored.
   */
  orderBy?: string | Array<{ column: string; dir?: 'asc' | 'desc' }>;
  /** Default sort direction for `orderBy` (default 'desc'). */
  orderDir?: 'asc' | 'desc';
  /** Max number of group rows to return (clamped to 1–1000). */
  limit?: number;
}

// ── Conditional (CAS) update result ──
/**
 * Result of `Repository.updateWhere`. `matched` is `true` only when a row with
 * the given id satisfied EVERY predicate equality at write time; the write then
 * applied and `row` is the updated record. `matched: false` (`row: null`) means
 * the predicate lost the race (or no such id) — the caller MUST treat this as a
 * lost compare-and-set, never as a not-found error.
 */
export interface ConditionalUpdateResult<T = Record<string, any>> {
  matched: boolean;
  row: T | null;
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
  /**
   * Compare-and-set update: applies `updates` to the row with `id` only if the
   * row currently equals every field in `predicate` (a `null` predicate value
   * matches SQL `IS NULL`). Returns `{ matched: true, row }` on success and
   * `{ matched: false, row: null }` when no row matched — enabling single-winner
   * lease acquisition and status transitions without `SELECT … FOR UPDATE`.
   * Tenant scope and (for tenant-scoped entities) the tenant WHERE predicate are
   * applied exactly as in `update`.
   */
  /**
   * Optional so a pre-existing custom `Repository`/`DataService` implementation still
   * satisfies this interface without change. The framework's own repositories
   * (drizzle + in-memory) always provide it; features that need a compare-and-set
   * (e.g. @plumbus/chat confirmation claims) require an implementation that has it.
   */
  updateWhere?(
    id: string,
    predicate: Partial<T>,
    updates: TUpdate,
  ): Promise<ConditionalUpdateResult<T>>;
  delete(id: string): Promise<void>;
  findMany(query?: Partial<T>, options?: QueryOptions): Promise<T[]>;
  count(
    query?: Partial<T>,
    options?: Pick<QueryOptions, 'dateFilters' | 'search' | 'in' | 'notEq'>,
  ): Promise<number>;
  /**
   * Compute SUM / AVG / MIN / MAX / COUNT / COUNT(DISTINCT) aggregates in the
   * database, optionally grouped — so callers stop loading whole tables to
   * reduce/group in memory. Filtering matches `findMany`/`count` exactly (the
   * `query` equality argument plus `dateFilters`/`search`/`in`/`notEq`), and
   * tenant scoping, soft-delete, and encrypted-field guards all apply. Without
   * `groupBy` it returns exactly one grand-total row (even over zero matches);
   * with `groupBy` it returns one row per group that has matching records. See
   * {@link AggregateRow} for the result shape.
   */
  aggregate(query?: Partial<T>, options?: AggregateOptions): Promise<AggregateRow[]>;
}

// ── Data Service (all entity repositories) ──
// Uses RegisteredEntities from the type registry. When consumer apps run
// `plumbus generate`, a module augmentation populates PlumbusRegistry.entities
// with typed repository mappings. Until then, falls back to Record<string, Repository>.
export type DataService = RegisteredEntities;

// ── Transaction scope (tx-scoped data + events inside withTransaction) ──
export interface TransactionScope {
  data: DataService;
  events: EventService;
  /** Side effects queued during the transaction; run only after commit succeeds */
  deferred?: Array<() => Promise<void>>;
}

export type WithTransactionFn = <T>(fn: (scope: TransactionScope) => Promise<T>) => Promise<T>;

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

// ── Flow Description (for provider-tool exposure) ──
export interface FlowDescription {
  name: string;
  domain: string;
  description?: string;
  /**
   * Raw flow input JSON Schema (same representation as
   * `CapabilityDescription.inputSchema`). Always present; used to derive the
   * flow input-schema hash that serves as the flow's tool `targetVersion` (C4).
   */
  inputSchema: Record<string, unknown>;
  /**
   * Structured-output-normalized JSON Schema suitable as a provider tool's
   * `parameters`. `undefined` when the flow input schema cannot be represented
   * as a provider tool schema (a `ProviderJsonSchemaError` was raised).
   */
  parameters?: Record<string, unknown>;
}

// ── Flow Service ──
export interface FlowService {
  start(
    flowName: RegisteredFlowName,
    input: unknown,
    opts?: { executionId?: string },
  ): Promise<FlowExecution>;
  resume(executionId: string, signal?: unknown): Promise<void>;
  cancel(executionId: string): Promise<void>;
  status(executionId: string): Promise<FlowExecution>;
  /** Extend the current flow execution lease. Only effective inside a flow step handler. Throws LeaseLostError if the lease has been lost. */
  heartbeat(): Promise<void>;
  /**
   * Describe a registered flow for provider-tool exposure. Returns `undefined`
   * when the flow is not registered or when no flow registry is wired into the
   * flow service. Present only on flow services built with a registry.
   */
  describe?(flowName: string): FlowDescription | undefined;
}

// ── Job Dispatch Service ──
export interface JobDispatchService {
  /** Enqueue a `kind: 'job'` capability by canonical name. Returns the job execution id. */
  enqueue(
    capabilityName: string,
    input: Record<string, unknown>,
    opts?: { jobId?: string },
  ): Promise<string>;
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
  /** Provider tool calls surfaced on a done event when finishReason is 'tool_calls'. */
  toolCalls?: AIToolCall[];
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

// ── AI Tool-Calling Generation Config + Results (C1) ──

/** Tool-calling generation fields mixed into generate/generateWithUsage config. */
export interface AIGenerateConfig {
  tools?: AITool[];
  toolChoice?: AIToolChoice;
  toolExecution?: AIToolExecutionOptions;
  /** Default 'prompt'. 'none' disables output-schema validation (Chat tool rounds set 'none'). */
  outputValidation?: 'prompt' | 'none';
}

/**
 * C1: flat final result — `.data` is ALWAYS present. No-tool callers receive this.
 * `finishReason` is newly added and additive; existing consumers may ignore it.
 */
export interface AIFinalGenerateResult<T = Record<string, any>> {
  // Optional so constructing a result literal (test doubles, custom AIService
  // implementations, mock AI) stays source-compatible with the pre-0.6.9 shape,
  // which had no finishReason. Readers narrow on it; the framework always sets it.
  finishReason?: 'stop' | 'length' | 'refusal' | 'other';
  data: T;
  toolCalls?: never;
  usage: AITokenUsage;
  model: string;
  provider: string;
  /** Estimated cost in USD based on published per-token rates. 0 for unknown models. */
  cost: number;
}

/** C1: tool-call branch — never carries `.data`. */
export interface AIToolCallsGenerateResult {
  finishReason: 'tool_calls';
  toolCalls: AIToolCall[];
  data?: never;
  usage: AITokenUsage;
  model: string;
  provider: string;
  cost: number;
}

/** C1: only tool-enabled config returns this discriminated union (keyed on finishReason). */
export type AIToolEnabledGenerateResult<T = Record<string, any>> =
  | AIFinalGenerateResult<T>
  | AIToolCallsGenerateResult;

/** TIER-1 public back-compat alias (was `{ data; usage; model; provider; cost }`). */
export type AIGenerateResult<T = Record<string, any>> = AIFinalGenerateResult<T>;

/** Base config for generateWithUsage (existing inline fields + outputValidation). */
export interface AIGenerateWithUsageConfig {
  prompt: string;
  input: Record<string, unknown>;
  messages?: ChatMessage[];
  validation?: AIValidationOptions;
  signal?: AbortSignal;
  costContext?: AICostContext;
  seed?: number;
  outputValidation?: 'prompt' | 'none';
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
  /**
   * Record provider-side spend directly when a caller already has normalized
   * cost metadata (for example voice/media adapters that do not flow through
   * token-based `generate*` helpers).
   */
  recordProviderCost(entry: AICostRecordInput, costContext?: AICostContext): Promise<void>;

  /**
   * Pre-check shared daily/per-request budgets before non-token provider work
   * such as voice STT/TTS/transport adapters.
   */
  checkProviderCostBudget(config?: { estimatedTokens?: number; estimatedCostUsd?: number }): void;

  generate(config: {
    prompt: string;
    input: Record<string, unknown>;
    /**
     * Optional native multi-turn history (`user` / `assistant` turns). When
     * set, providers receive the thread instead of a single synthesized user
     * message from the rendered prompt; the rendered description is merged into
     * `system` by the AI service. Last turn should be `user`.
     */
    messages?: ChatMessage[];
    validation?: AIValidationOptions;
    /** Abort the in-flight HTTP request to the provider when this signal fires. Defaults to ctx.signal inside flow steps. */
    signal?: AbortSignal;
    /** Per-call billing metadata forwarded to the framework `onAICostRecorded` hook. */
    costContext?: AICostContext;
    /** Deterministic sampling seed forwarded to providers that support it (OpenAI-compatible). Ignored by others. */
    seed?: number;
  }): Promise<Record<string, any>>;

  /** Like generate(), but also returns actual token usage. No tools → flat result; `.data` unconditional (C1). */
  generateWithUsage<T extends Record<string, any> = Record<string, any>>(
    config: AIGenerateWithUsageConfig & {
      tools?: undefined;
      toolChoice?: undefined;
      toolExecution?: undefined;
    },
  ): Promise<AIFinalGenerateResult<T>>;
  /** Tools enabled → discriminated union keyed on `finishReason` (C1). */
  generateWithUsage<T extends Record<string, any> = Record<string, any>>(
    config: AIGenerateWithUsageConfig & {
      tools: AITool[];
      toolChoice?: AIToolChoice;
      toolExecution?: AIToolExecutionOptions;
    },
  ): Promise<AIToolEnabledGenerateResult<T>>;

  /** Stream AI generation, yielding incremental text deltas and a final validated result */
  streamGenerate(config: {
    prompt: string;
    input: Record<string, unknown>;
    /** Same semantics as `generate({ messages })`. */
    messages?: ChatMessage[];
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

  retrieve(config: {
    query: string;
    corpus?: string;
    filter?: Record<string, unknown>;
    limit?: number;
    minScore?: number;
    signal?: AbortSignal;
  }): Promise<AIDocument[]>;
}

// ── Logger Service ──
export interface ProgressService {
  report(opts: { progress: number; total?: number; message?: string }): void;
}

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

// ── Capability Service (nested invocation) ──
export interface CapabilityDescription {
  name: string;
  domain: string;
  kind: string;
  inputSchema: Record<string, unknown>;
}

export interface CapabilityService {
  invoke(name: RegisteredCapabilityName, input: unknown): Promise<unknown>;
  describe?(name: RegisteredCapabilityName): CapabilityDescription | undefined;
}

// ── Internal runtime metadata (not part of public SDK docs) ──
export interface ExecutionRuntimeMetadata {
  invokeCapability?: (
    name: string,
    ctx: ExecutionContext,
    input: unknown,
  ) => Promise<
    | { success: true; data: unknown }
    | {
        success: false;
        error: { code: string; message: string; metadata?: Record<string, unknown> };
      }
  >;
  resolveCapability?: (name: string) => CapabilityContract | undefined;
  capabilityStack?: readonly string[];
  correlationId?: string;
  /** Canonical name of the capability that invoked the current handler (for nested audit/events). */
  invocationCaller?: string;
  /** @internal Mutable emit causation scope — not visible to capability handlers. */
  invocationEmitScope?: InvocationEmitScope;
  /** @internal Active transaction scope when running inside a transactional capability. */
  transactionScope?: TransactionScope;
  /**
   * @internal Post-commit deferred queue from an enclosing transactional parent.
   * Present even when the current capability does not share the parent's data/events
   * scope (e.g. nested AI), so success audits can still defer until parent commit.
   */
  deferredPostCommit?: Array<() => Promise<void>>;
  /** @internal Drizzle transaction runner wired by server/worker bootstrap. */
  withTransaction?: WithTransactionFn;
}

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

// ── Context Dependencies (passed to createExecutionContext) ──
export interface ContextDependencies {
  auth: AuthContext;
  data: DataService;
  events?: EventService;
  flows?: FlowService;
  jobs?: JobDispatchService;
  ai?: AIService;
  audit?: AuditService;
  logger?: LoggerService;
  time?: TimeService;
  config?: ConfigService;
  translations?: TranslationService;
  request?: RequestMeta;
  progress?: ProgressService;
  invokeCapability?: ExecutionRuntimeMetadata['invokeCapability'];
  resolveCapability?: ExecutionRuntimeMetadata['resolveCapability'];
  correlationId?: string;
  /** @internal Wired by server/MCP bootstrap for nested event causation. */
  invocationEmitScope?: ExecutionRuntimeMetadata['invocationEmitScope'];
  /** Drizzle transaction runner — tx-scoped data + events; audit stays on outer db. */
  withTransaction?: WithTransactionFn;
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
  jobs: JobDispatchService;
  ai: AIService;
  audit: AuditService;
  errors: ErrorService;
  logger: LoggerService;
  time: TimeService;
  config: ConfigService;
  security: SecurityService;
  translations: TranslationService;
  capabilities: CapabilityService;
  /** HTTP request metadata (IP, User-Agent) — present when invoked via HTTP */
  request?: RequestMeta;
  /** @internal Runtime-only invocation state — not part of the public SDK surface. */
  __runtime?: ExecutionRuntimeMetadata;

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
  /**
   * Present only when running under an MCP task. Capability handlers call
   * `ctx.progress?.report({ progress, total, message })` to emit
   * `notifications/progress` to the connected MCP client.
   */
  progress?: ProgressService;
}
