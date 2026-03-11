// ── Test Context Builder ──
// Factory for building test-friendly ExecutionContexts with mock services.

import type { ContextDependencies } from '../execution/context-factory.js';
import { createExecutionContext } from '../execution/context-factory.js';
import type { AuditService } from '../types/audit.js';
import type {
    AIDocument,
    AIService,
    DataService,
    EventService,
    ExecutionContext,
    FlowExecution,
    FlowService,
    LoggerService,
    Repository,
    TimeService,
} from '../types/context.js';
import type { AuthContext } from '../types/security.js';

// ── Test Auth Builder ──

export interface TestAuthOptions {
  userId?: string;
  roles?: string[];
  scopes?: string[];
  tenantId?: string;
  provider?: string;
  sessionId?: string;
}

/** Create a test AuthContext with sensible defaults */
export function createTestAuth(options?: TestAuthOptions): AuthContext {
  return {
    userId: options && 'userId' in options ? options.userId : 'test-user',
    roles: options?.roles ?? ['user'],
    scopes: options?.scopes ?? [],
    tenantId: options && 'tenantId' in options ? options.tenantId : 'test-tenant',
    provider: options?.provider ?? 'test',
    sessionId: options?.sessionId,
  };
}

// ── Mock Audit ──

export interface MockAuditService extends AuditService {
  /** All recorded audit events */
  readonly records: Array<{ eventType: string; metadata?: Record<string, unknown> }>;
  /** Clear recorded audit events */
  clear(): void;
}

/** Create a mock audit service that captures all recorded events */
export function mockAudit(): MockAuditService {
  const records: Array<{ eventType: string; metadata?: Record<string, unknown> }> = [];
  return {
    records,
    async record(eventType, metadata) {
      records.push({ eventType, metadata });
    },
    clear() {
      records.length = 0;
    },
  };
}

// ── Mock Events ──

export interface MockEventService extends EventService {
  /** All emitted events */
  readonly emitted: Array<{ eventName: string; payload: unknown }>;
  /** Clear emitted events */
  clear(): void;
}

/** Create a mock event service that captures all emitted events */
export function mockEvents(): MockEventService {
  const emitted: Array<{ eventName: string; payload: unknown }> = [];
  return {
    emitted,
    async emit(eventName, payload) {
      emitted.push({ eventName, payload });
    },
    clear() {
      emitted.length = 0;
    },
  };
}

// ── Mock Flows ──

export interface MockFlowService extends FlowService {
  /** All started flows */
  readonly started: Array<{ flowName: string; input: unknown }>;
  /** Clear tracked flows */
  clear(): void;
}

/** Create a mock flow service that captures flow operations */
export function mockFlows(): MockFlowService {
  const started: Array<{ flowName: string; input: unknown }> = [];
  let counter = 0;
  return {
    started,
    async start(flowName, input) {
      counter++;
      const exec: FlowExecution = { id: `flow-exec-${counter}`, flowName, status: 'running' };
      started.push({ flowName, input });
      return exec;
    },
    async resume() {},
    async cancel() {},
    async status(executionId) {
      return { id: executionId, flowName: 'unknown', status: 'unknown' };
    },
    clear() {
      started.length = 0;
    },
  };
}

// ── Mock AI ──

export interface AIResponse {
  generate?: unknown;
  extract?: unknown;
  classify?: string[];
  retrieve?: AIDocument[];
}

/** Create a mock AI service with configurable responses */
export function mockAI(responses?: AIResponse): AIService {
  return {
    async generate() {
      if (responses?.generate !== undefined) return responses.generate;
      return { text: 'mock-ai-response' };
    },
    async extract() {
      if (responses?.extract !== undefined) return responses.extract;
      return {};
    },
    async classify() {
      if (responses?.classify !== undefined) return responses.classify;
      return ['default'];
    },
    async retrieve() {
      if (responses?.retrieve !== undefined) return responses.retrieve;
      return [];
    },
  };
}

// ── Mock Logger ──

export interface MockLoggerService extends LoggerService {
  readonly logs: Array<{
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    metadata?: Record<string, unknown>;
  }>;
  clear(): void;
}

/** Create a mock logger that captures all log entries silently */
export function mockLogger(): MockLoggerService {
  const logs: Array<{
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    metadata?: Record<string, unknown>;
  }> = [];
  return {
    logs,
    debug(message, metadata) {
      logs.push({ level: 'debug', message, metadata });
    },
    info(message, metadata) {
      logs.push({ level: 'info', message, metadata });
    },
    warn(message, metadata) {
      logs.push({ level: 'warn', message, metadata });
    },
    error(message, metadata) {
      logs.push({ level: 'error', message, metadata });
    },
    clear() {
      logs.length = 0;
    },
  };
}

// ── In-Memory Repository ──

/** Create an in-memory repository for testing entity operations */
export function createInMemoryRepository<
  T extends Record<string, unknown> = Record<string, unknown>,
>(initialData?: T[]): Repository<T> {
  const store = new Map<string, T>();
  let idCounter = 0;
  if (initialData) {
    for (const item of initialData) {
      const id = (item as any).id ?? `test-${++idCounter}`;
      store.set(id, { ...item, id });
    }
  }

  return {
    async findById(id) {
      return store.get(id) ?? null;
    },
    async create(data) {
      const id = (data as any).id ?? `test-${++idCounter}`;
      const record = { ...data, id } as unknown as T;
      store.set(id, record);
      return record;
    },
    async update(id, updates) {
      const existing = store.get(id);
      if (!existing) throw new Error(`Record not found: ${id}`);
      const updated = { ...existing, ...updates } as T;
      store.set(id, updated);
      return updated;
    },
    async delete(id) {
      store.delete(id);
    },
    async findMany(query) {
      const all = [...store.values()];
      if (!query) return all;
      return all.filter((item) =>
        Object.entries(query).every(([key, value]) => (item as any)[key] === value),
      );
    },
  };
}

// ── Test Data Service ──

/** Create a test DataService from a map of entity name → initial records */
export function createTestData(entities?: Record<string, Record<string, unknown>[]>): DataService {
  const data: DataService = {};
  if (entities) {
    for (const [name, records] of Object.entries(entities)) {
      data[name] = createInMemoryRepository(records);
    }
  }
  return new Proxy(data, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (!target[prop]) {
        target[prop] = createInMemoryRepository();
      }
      return target[prop];
    },
  });
}

// ── Fixed Time Service ──

/** Create a time service that returns a fixed date (useful for deterministic tests) */
export function fixedTime(date?: Date): TimeService {
  const fixed = date ?? new Date('2025-01-01T00:00:00Z');
  return { now: () => fixed };
}

// ── Create Test Context ──

export interface TestContextOptions {
  auth?: TestAuthOptions;
  data?: Record<string, Record<string, unknown>[]>;
  events?: EventService;
  flows?: FlowService;
  ai?: AIService | AIResponse;
  audit?: AuditService;
  logger?: LoggerService;
  time?: TimeService | Date;
  config?: Record<string, unknown>;
}

/**
 * Create a fully configured test execution context.
 * All services default to mocks. Override any service via options.
 */
export function createTestContext(options?: TestContextOptions): ExecutionContext {
  const aiService: AIService =
    options?.ai && typeof (options.ai as AIService).generate === 'function'
      ? (options.ai as AIService)
      : mockAI(options?.ai as AIResponse | undefined);

  const timeService: TimeService =
    options?.time instanceof Date ? fixedTime(options.time) : (options?.time ?? fixedTime());

  const deps: ContextDependencies = {
    auth: createTestAuth(options?.auth),
    data: createTestData(options?.data),
    events: options?.events ?? mockEvents(),
    flows: options?.flows ?? mockFlows(),
    ai: aiService,
    audit: options?.audit ?? mockAudit(),
    logger: options?.logger ?? mockLogger(),
    time: timeService,
    config: options?.config ?? {},
  };

  return createExecutionContext(deps);
}
