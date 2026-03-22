import type { z } from 'zod';
import type { AuditService } from './audit.js';
import type { ErrorService } from './errors.js';
import type { RegisteredEntities, RegisteredEventName, RegisteredFlowName } from './registry.js';
import type { AuthContext } from './security.js';
import type { TranslationService } from './translation.js';

// ── Repository (per-entity data access) ──
export interface Repository<T = Record<string, any>> {
  findById(id: string): Promise<T | null>;
  create(data: Record<string, any>): Promise<T>;
  update(id: string, updates: Record<string, any>): Promise<T>;
  delete(id: string): Promise<void>;
  findMany(query?: Record<string, any>): Promise<T[]>;
}

// ── Data Service (all entity repositories) ──
// Uses RegisteredEntities from the type registry. When consumer apps run
// `plumbus generate`, a module augmentation populates PlumbusRegistry.entities
// with typed repository mappings. Until then, falls back to Record<string, Repository>.
export type DataService = RegisteredEntities;

// ── Event Service ──
export interface EventService {
  emit(eventName: RegisteredEventName, payload: unknown): Promise<void>;
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

// ── AI Service ──
export interface AIService {
  generate(config: {
    prompt: string;
    input: Record<string, unknown>;
  }): Promise<Record<string, any>>;

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
export type ConfigService = Record<string, unknown>;

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

  // Flow-specific (only present inside flow step execution)
  state?: unknown;
  step?: string;
  flowId?: string;
}
