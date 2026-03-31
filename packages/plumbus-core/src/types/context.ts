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

// ── AI Service ──
export interface AIService {
  generate(config: {
    prompt: string;
    input: Record<string, unknown>;
  }): Promise<Record<string, any>>;

  /** Like generate(), but also returns actual token usage from the provider */
  generateWithUsage(config: {
    prompt: string;
    input: Record<string, unknown>;
  }): Promise<AIGenerateResult>;

  /** Stream AI generation, yielding incremental text deltas and a final validated result */
  streamGenerate(config: {
    prompt: string;
    input: Record<string, unknown>;
  }): AsyncIterable<AIStreamEvent>;

  extract(config: {
    schema: z.ZodTypeAny;
    text: string;
    prompt?: string;
    input?: Record<string, unknown>;
  }): Promise<Record<string, any>>;

  classify(config: { labels: string[]; text: string }): Promise<string[]>;

  retrieve(config: { query: string }): Promise<AIDocument[]>;
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

  // Flow-specific (only present inside flow step execution)
  state?: unknown;
  step?: string;
  flowId?: string;
}
