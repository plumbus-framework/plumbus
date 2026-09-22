// ── Test Context Builder ──
// Factory for building test-friendly ExecutionContexts with mock services.

import type { ContextDependencies, ProgressService } from '../types/context.js';
import { buildCapabilityRuntimeDeps } from '../execution/capability-invocation.js';
import { CapabilityRegistry } from '../execution/capability-registry.js';
import { createExecutionContext } from '../execution/context-factory.js';
import type { CapabilityContract } from '../types/capability.js';
import type { AuditService } from '../types/audit.js';
import type {
  AggregateRow,
  AggregateValue,
  AIDocument,
  AIService,
  AIToolEnabledGenerateResult,
  DataService,
  EventService,
  ExecutionContext,
  FlowDescription,
  FlowExecution,
  FlowService,
  LoggerService,
  QueryOptions,
  Repository,
  TimeService,
} from '../types/context.js';
import type { EntityDefinition } from '../types/entity.js';
import type { FieldDescriptor } from '../types/fields.js';
import type { AuthContext } from '../types/security.js';
import { buildEntityFieldMap, validateRecord } from './field-validation.js';

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
    async emitMany(events) {
      for (const e of events) {
        emitted.push({ eventName: e.eventName, payload: e.payload });
      }
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

export interface MockFlowsOptions {
  /** Flow descriptions returned by `describe(flowName)`. */
  describe?: Record<string, FlowDescription>;
  /** Scripted `status(executionId)` results, keyed by execution id. */
  statuses?: Record<string, FlowExecution>;
}

/** Create a mock flow service that captures flow operations */
export function mockFlows(options?: MockFlowsOptions): MockFlowService {
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
      return (
        options?.statuses?.[executionId] ?? {
          id: executionId,
          flowName: 'unknown',
          status: 'unknown',
        }
      );
    },
    async heartbeat() {},
    describe(flowName) {
      return options?.describe?.[flowName];
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
    features: { perCallProviderModelReasoning: true },
    async recordProviderCost() {},
    checkProviderCostBudget() {},
    async generate(_config) {
      if (responses?.generate !== undefined) return responses.generate as Record<string, any>;
      return { text: 'mock-ai-response' };
    },
    generateWithUsage: (async (
      _config: Parameters<AIService['generateWithUsage']>[0],
    ): Promise<AIToolEnabledGenerateResult> => {
      const data =
        responses?.generate !== undefined
          ? (responses.generate as Record<string, any>)
          : { text: 'mock-ai-response' };
      const inputStr = JSON.stringify(_config);
      const outputStr = JSON.stringify(data);
      return {
        finishReason: 'stop',
        data,
        usage: {
          inputTokens: Math.ceil(inputStr.length / 4),
          outputTokens: Math.ceil(outputStr.length / 4),
          totalTokens: Math.ceil(inputStr.length / 4) + Math.ceil(outputStr.length / 4),
        },
        model: 'mock-model',
        provider: 'mock',
        cost: 0,
      };
    }) as AIService['generateWithUsage'],
    async *streamGenerate(_config) {
      const result =
        responses?.generate !== undefined
          ? (responses.generate as Record<string, any>)
          : { text: 'mock-ai-response' };
      const inputStr = JSON.stringify(_config);
      const outputStr = JSON.stringify(result);
      const usage = {
        inputTokens: Math.ceil(inputStr.length / 4),
        outputTokens: Math.ceil(outputStr.length / 4),
        totalTokens: Math.ceil(inputStr.length / 4) + Math.ceil(outputStr.length / 4),
      };
      yield { type: 'delta' as const, text: result.text ?? JSON.stringify(result) };
      yield {
        type: 'done' as const,
        data: result,
        usage,
        model: 'mock-model',
        provider: 'mock',
        cost: 0,
      };
    },
    async extract(_config) {
      if (responses?.extract !== undefined) return responses.extract as Record<string, any>;
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

  function filterRows(query?: Partial<T>, options?: QueryOptions): T[] {
    let results = [...store.values()];
    if (query) {
      results = results.filter((item) =>
        Object.entries(query).every(([key, value]) => (item as any)[key] === value),
      );
    }
    if (options?.dateFilters) {
      for (const [field, range] of Object.entries(options.dateFilters)) {
        if (range.gte) {
          const gte = range.gte instanceof Date ? range.gte : new Date(range.gte as any);
          results = results.filter((item) => {
            const v = (item as any)[field];
            return v && new Date(v) >= gte;
          });
        }
        if (range.lte) {
          const lte = range.lte instanceof Date ? range.lte : new Date(range.lte as any);
          results = results.filter((item) => {
            const v = (item as any)[field];
            return v && new Date(v) <= lte;
          });
        }
      }
    }
    if (options?.in) {
      for (const [field, vals] of Object.entries(options.in)) {
        if (!vals.length) continue;
        // Mirror SQL IN, which coerces query values to the column type (e.g. a numeric
        // column compared against a string param from an HTTP query): match by string
        // form, and exclude NULL/absent fields (`col IN (...)` is NULL — not TRUE — for
        // a NULL column, so those rows are dropped).
        const allowed = new Set(vals.map((v) => String(v)));
        results = results.filter((item) => {
          const v = (item as any)[field];
          return v != null && allowed.has(String(v));
        });
      }
    }
    if (options?.notEq) {
      for (const [field, val] of Object.entries(options.notEq)) {
        // Mirror SQL `<>`: under three-valued logic a NULL/absent column makes the
        // predicate NULL (not TRUE), so those rows are EXCLUDED — same as ne().
        results = results.filter((item) => {
          const v = (item as any)[field];
          return v != null && v !== val;
        });
      }
    }
    if (options?.search?.term) {
      const term = options.search.term.toLowerCase();
      const cols = options.search.columns;
      results = results.filter((item) =>
        cols.some((col) =>
          String((item as any)[col] ?? '')
            .toLowerCase()
            .includes(term),
        ),
      );
    }
    if (options?.orderBy) {
      const specs =
        typeof options.orderBy === 'string'
          ? [{ column: options.orderBy, dir: options.orderDir }]
          : options.orderBy;
      results.sort((a, b) => {
        for (const spec of specs) {
          // Mirror SQL applyOrder: a spec that omits `dir` falls back to the
          // top-level orderDir (then defaults to desc), not straight to desc.
          const dir = (spec.dir ?? options.orderDir) === 'asc' ? 1 : -1;
          const av = (a as any)[spec.column];
          const bv = (b as any)[spec.column];
          if (av < bv) return -1 * dir;
          if (av > bv) return 1 * dir;
        }
        return 0;
      });
    }
    return results;
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
    async createMany(records) {
      const out: T[] = [];
      for (const data of records) {
        const id = (data as any).id ?? `test-${++idCounter}`;
        const record = { ...data, id } as unknown as T;
        store.set(id, record);
        out.push(record);
      }
      return out;
    },
    async update(id, updates) {
      const existing = store.get(id);
      if (!existing) throw new Error(`Record not found: ${id}`);
      const updated = { ...existing, ...updates } as T;
      store.set(id, updated);
      return updated;
    },
    async updateWhere(id, predicate, updates) {
      const existing = store.get(id);
      if (!existing) return { matched: false, row: null };
      const ok = Object.entries(predicate as Record<string, unknown>).every(([k, v]) => {
        const actual = (existing as Record<string, unknown>)[k];
        if (v === null) return actual === null || actual === undefined;
        return actual === v;
      });
      if (!ok) return { matched: false, row: null };
      const updated = { ...existing, ...updates } as T;
      store.set(id, updated);
      return { matched: true, row: updated };
    },
    async delete(id) {
      store.delete(id);
    },
    async findMany(query, options) {
      let results = filterRows(query, options);
      if (options?.offset) {
        results = results.slice(options.offset);
      }
      if (options?.limit) {
        results = results.slice(0, options.limit);
      }
      return results;
    },
    async count(query, options) {
      return filterRows(query, options).length;
    },
    async aggregate(query, options) {
      // Mirror the Drizzle repository's aggregate() semantics exactly, so tests
      // written against createTestContext exercise the same behavior consumers
      // get in production.
      const rows = filterRows(query, {
        dateFilters: options?.dateFilters,
        search: options?.search,
        in: options?.in,
        notEq: options?.notEq,
      });

      const groupCols = toColumnArray(options?.groupBy);
      const sumCols = toColumnArray(options?.sum);
      const avgCols = toColumnArray(options?.avg);
      const minCols = toColumnArray(options?.min);
      const maxCols = toColumnArray(options?.max);
      const distinctCols = toColumnArray(options?.countDistinct);
      const wantCount = options?.count === true;

      const hasAggregate =
        wantCount ||
        sumCols.length > 0 ||
        avgCols.length > 0 ||
        minCols.length > 0 ||
        maxCols.length > 0 ||
        distinctCols.length > 0;
      if (!hasAggregate && groupCols.length === 0) {
        throw new Error('aggregate() requires at least one group column or aggregate function');
      }

      const computeRow = (
        groupRows: T[],
        keyValues: Record<string, AggregateValue>,
      ): AggregateRow => {
        const out: AggregateRow = { ...keyValues };
        for (const c of sumCols) {
          out[`sum_${c}`] = groupRows.reduce((s, r) => s + (Number((r as any)[c]) || 0), 0);
        }
        for (const c of avgCols) {
          const nums = groupRows.map((r) => Number((r as any)[c])).filter((n) => !Number.isNaN(n));
          out[`avg_${c}`] = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
        }
        for (const c of minCols) {
          const vals = groupRows.map((r) => (r as any)[c]).filter((v) => v != null);
          out[`min_${c}`] = vals.length
            ? (vals.reduce((a, b) => (b < a ? b : a)) as AggregateValue)
            : null;
        }
        for (const c of maxCols) {
          const vals = groupRows.map((r) => (r as any)[c]).filter((v) => v != null);
          out[`max_${c}`] = vals.length
            ? (vals.reduce((a, b) => (b > a ? b : a)) as AggregateValue)
            : null;
        }
        for (const c of distinctCols) {
          out[`countDistinct_${c}`] = new Set(
            groupRows
              .map((r) => (r as any)[c])
              .filter((v) => v != null)
              .map((v) => String(v)),
          ).size;
        }
        if (wantCount) out.count = groupRows.length;
        return out;
      };

      let resultRows: AggregateRow[];
      if (groupCols.length === 0) {
        // Exactly one grand-total row, even over zero matches (like SQL).
        resultRows = [computeRow(rows, {})];
      } else {
        const groups = new Map<string, { key: Record<string, AggregateValue>; rows: T[] }>();
        for (const r of rows) {
          const k = JSON.stringify(groupCols.map((g) => (r as any)[g] ?? null));
          let group = groups.get(k);
          if (!group) {
            const key: Record<string, AggregateValue> = {};
            for (const g of groupCols) key[g] = (r as any)[g] ?? null;
            group = { key, rows: [] };
            groups.set(k, group);
          }
          group.rows.push(r);
        }
        resultRows = [...groups.values()].map((g) => computeRow(g.rows, g.key));
      }

      if (options?.orderBy) {
        const specs =
          typeof options.orderBy === 'string'
            ? [{ column: options.orderBy, dir: options.orderDir }]
            : options.orderBy;
        resultRows.sort((a, b) => {
          for (const spec of specs) {
            const dir = (spec.dir ?? options.orderDir) === 'asc' ? 1 : -1;
            const av = a[spec.column];
            const bv = b[spec.column];
            if (av == null && bv == null) continue;
            if (av == null) return 1 * dir;
            if (bv == null) return -1 * dir;
            if (av < bv) return -1 * dir;
            if (av > bv) return 1 * dir;
          }
          return 0;
        });
      }
      if (options?.limit != null) {
        resultRows = resultRows.slice(0, Math.max(1, Math.min(1000, options.limit)));
      }
      return resultRows;
    },
  };
}

/** Normalize a string | string[] | undefined column spec to a string[]. */
function toColumnArray(value?: string | string[]): string[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

// ── Validating Repository Wrapper ──

function withFieldValidation<T extends Record<string, unknown>>(
  repo: Repository<T>,
  entityName: string,
  fields: Record<string, FieldDescriptor>,
): Repository<T> {
  function check(data: Record<string, unknown>) {
    const errors = validateRecord(entityName, fields, data);
    if (errors.length > 0) {
      const details = errors
        .map(
          (e) =>
            `  ${e.field}: expected ${e.expected}, got ${e.actual} (${JSON.stringify(e.value)})`,
        )
        .join('\n');
      throw new Error(`Test data validation failed for ${entityName}:\n${details}`);
    }
  }

  return {
    findById: (id) => repo.findById(id),
    async create(data) {
      check(data as Record<string, unknown>);
      return repo.create(data);
    },
    async createMany(records) {
      for (const data of records) {
        check(data as Record<string, unknown>);
      }
      return repo.createMany(records);
    },
    async update(id, updates) {
      check(updates as Record<string, unknown>);
      return repo.update(id, updates);
    },
    async updateWhere(id, predicate, updates) {
      check(updates as Record<string, unknown>);
      if (!repo.updateWhere) {
        throw new Error('updateWhere is not supported by the wrapped repository');
      }
      return repo.updateWhere(id, predicate, updates);
    },
    delete: (id) => repo.delete(id),
    findMany: (query, options) => repo.findMany(query, options),
    count: (query, options) => repo.count(query, options),
    aggregate: (query, options) => repo.aggregate(query, options),
  };
}

// ── Test Data Service ──

/** Create a test DataService from a map of entity name → initial records */
export function createTestData(
  data?: Record<string, Record<string, unknown>[]>,
  entityDefs?: EntityDefinition[],
): DataService {
  const fieldMap = entityDefs ? buildEntityFieldMap(entityDefs) : null;
  const dataService: DataService = {};

  function makeRepo(name: string, records?: Record<string, unknown>[]): Repository {
    const repo = createInMemoryRepository(records);
    const fields = fieldMap?.get(name);
    return fields ? withFieldValidation(repo, name, fields) : repo;
  }

  if (data) {
    for (const [name, records] of Object.entries(data)) {
      dataService[name] = makeRepo(name, records);
    }
  }
  return new Proxy(dataService, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (!target[prop]) {
        target[prop] = makeRepo(prop);
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
  /** Entity definitions for field-type validation on writes. */
  entities?: EntityDefinition[];
  progress?: ProgressService;
  events?: EventService;
  flows?: FlowService;
  ai?: AIService | AIResponse;
  audit?: AuditService;
  logger?: LoggerService;
  time?: TimeService | Date;
  config?: Record<string, unknown>;
  /** Register capabilities for nested ctx.capabilities.invoke in tests. */
  capabilities?: CapabilityContract[];
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

  const capRuntime =
    options?.capabilities && options.capabilities.length > 0
      ? (() => {
          const registry = new CapabilityRegistry();
          registry.registerAll(options.capabilities);
          return buildCapabilityRuntimeDeps(registry);
        })()
      : {};

  const deps: ContextDependencies = {
    auth: createTestAuth(options?.auth),
    data: createTestData(options?.data, options?.entities),
    events: options?.events ?? mockEvents(),
    flows: options?.flows ?? mockFlows(),
    ai: aiService,
    audit: options?.audit ?? mockAudit(),
    logger: options?.logger ?? mockLogger(),
    time: timeService,
    config: options?.config ?? {},
    progress: options?.progress ?? { report: () => {} },
    ...capRuntime,
  };

  return createExecutionContext(deps);
}
