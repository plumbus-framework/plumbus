// ── Worker Process Bootstrap ──
// Separate process that starts background workers:
// outbox dispatcher, event delivery worker, flow step executor,
// flow scheduler. Handles graceful shutdown.

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { resolveEncryptionKey } from '../data/field-encryption.js';
import { FRAMEWORK_SCHEMA } from '../data/schema-generator.js';
import { createAuditService } from '../audit/service.js';
import { PlumbusError } from '../errors/plumbus-error.js';
import { ErrorCode } from '../types/enums.js';
import type { DataPlaneResolver } from '../tenancy/types.js';
import type { ConsumerRegistry } from '../events/consumer-registry.js';
import type { DispatcherConfig } from '../events/dispatcher.js';
import { createOutboxDispatcher } from '../events/dispatcher.js';
import { createEventEmitter } from '../events/emitter.js';
import { createIdempotencyService } from '../events/idempotency.js';
import type { EventQueue } from '../events/queue.js';
import type { EventRegistry } from '../events/registry.js';
import type { WorkerConfig } from '../events/worker.js';
import { createEventWorker } from '../events/worker.js';
import { hostApprovalRuntimeExtras } from '../approvals/host-runtime.js';
import type { ApprovalService, AuthorizationProvider } from '../approvals/types.js';
import { buildCapabilityRuntimeDeps } from '../execution/capability-invocation.js';
import { wireContextDependencies } from '../execution/context-deps.js';
import { createExecutionContext } from '../execution/context-factory.js';
import {
  resolveCompiledFlowRegistry,
  type CompiledFlowRegistry,
} from '../flows/compiled-registry.js';
import type { FlowEngineConfig } from '../flows/engine.js';
import { createFlowEngine, generateWorkerId } from '../flows/engine.js';
import { createFlowService } from '../flows/flow-service.js';
import { FlowStatus } from '../flows/state-machine.js';
import type { FlowRegistry } from '../flows/registry.js';
import type { SchedulerConfig } from '../flows/scheduler.js';
import { createFlowScheduler } from '../flows/scheduler.js';
import type { StepExecutorDeps } from '../flows/step-executor.js';
import { createFlowDelayedPromoter, scheduleDelayedFlowWake } from '../flows/flow-delayed.js';
import { createFlowStepConsumer } from '../flows/step-consumer.js';
import { createFlowTriggerHandler } from '../flows/triggers.js';
import type { RedisClient } from '../events/queue.js';
import type { CapabilityRegistry } from '../execution/capability-registry.js';
import type { EntityRegistry } from '../data/registry.js';
import { registerCapabilityConsumers } from '../runtime/register-consumers.js';
import type { AuditService } from '../types/audit.js';
import type { PlumbusConfig } from '../types/config.js';
import type { AIService, DataService, LoggerService } from '../types/context.js';
import type { PlumbusMetrics } from '../observability/metrics.js';
import type { AuthContext } from '../types/security.js';

// ── Error description helper ──
// Drizzle wraps the underlying driver error in `cause`, and its own `message`
// is just the literal SQL with a "Failed query:" prefix. Without the cause
// the worker logs hide the actual Postgres failure (missing column, broken
// constraint, etc.), which makes operational issues — especially schema drift
// after an `@plumbus/core` upgrade — extremely hard to diagnose.
//
// We pull out fields that postgres-js exposes on its error objects (code,
// detail, hint, position, where, schema, table, column, constraint, routine)
// in addition to the cause's own message, and surface them as a structured
// log payload alongside the original error message.
function describeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) {
    return { error: String(err) };
  }

  const out: Record<string, unknown> = { error: err.message };

  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    out.causeMessage = cause.message;
    const pgFields = [
      'code',
      'detail',
      'hint',
      'position',
      'where',
      'schema',
      'table',
      'column',
      'constraint',
      'routine',
      'severity',
    ] as const;
    const pg: Record<string, unknown> = {};
    for (const k of pgFields) {
      const v = (cause as unknown as Record<string, unknown>)[k];
      if (v !== undefined && v !== null && v !== '') pg[k] = v;
    }
    if (Object.keys(pg).length > 0) out.pg = pg;
  } else if (cause !== undefined) {
    out.cause = String(cause);
  }

  return out;
}

/**
 * The tenant a claimed flow execution belongs to.
 *
 * Claimed rows come back from a raw `RETURNING *`, so they carry the database's
 * own column names rather than the camel-cased ones the typed `select()` path
 * produces. Both spellings are read so the tenant is found either way.
 */
function claimedTenantRef(row: { tenantId?: string | null }): string | undefined {
  const columns = row as unknown as Record<string, unknown>;
  const value = columns.tenantId ?? columns.tenant_id;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

// ── Lease-column preflight ──
//
// 0.3.0 added `lease_owner` and `lease_expires_at` columns to flow_executions
// to support lease-based claiming across workers. If a consumer upgrades
// `@plumbus/core` but forgets to run `plumbus migrate generate` +
// `plumbus migrate apply`, the first claim-cycle UPDATE fails with PG error
// 42703 (undefined_column) deep inside drizzle, producing logs that don't
// point at the real fix. This probe runs one cheap `LIMIT 0` SELECT against
// those columns and rethrows a clear, actionable error when they're missing.
//
// Exported for direct testing.
export async function assertFlowLeaseColumns(db: PostgresJsDatabase): Promise<void> {
  try {
    await db.execute(sql`SELECT lease_owner, lease_expires_at FROM flow_executions LIMIT 0`);
  } catch (err) {
    const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
    const pgCode =
      cause && typeof cause === 'object' && 'code' in cause
        ? (cause as { code?: unknown }).code
        : undefined;
    if (pgCode === '42703') {
      throw new Error(
        'Plumbus 0.3.0 requires new columns on flow_executions (lease_owner, lease_expires_at).\n' +
          'Run `plumbus migrate generate` then `plumbus migrate apply` before starting workers.',
      );
    }
    throw err;
  }
}

// ── Worker Pool Config ──

/**
 * What a claimed unit of work carrying no tenant reference resolves to, once a
 * `dataPlaneResolver` is configured. `'refuse'` is the default and the
 * fail-closed choice: the unit fails rather than run against whichever database
 * happens to be at hand. `'control-plane'` runs it against the pool's own `db`.
 */
export type UntenantedDataPlanePolicy = 'refuse' | 'control-plane';

export interface WorkerPoolConfig {
  /** Plumbus framework config */
  config: PlumbusConfig;
  /**
   * Database connection.
   *
   * This is the pool's own database: the outbox it dispatches, the events it
   * delivers, the idempotency keys it records, the schedules it syncs and the
   * `flow_executions` rows it claims all live here. With no
   * `dataPlaneResolver` it is also the database every claimed unit of work
   * runs against.
   */
  db: PostgresJsDatabase;
  /** Events queue (outbox dispatcher + domain event delivery) */
  queue: EventQueue;
  /** Jobs queue (async kind: 'job' capabilities). Defaults to queue when omitted. */
  jobsQueue?: EventQueue;
  /** Flows queue (step wake notifications). Defaults to queue when omitted. */
  flowsQueue?: EventQueue;
  /** When true, flow poll loop runs at reconciliation interval (queue handles immediate wake). */
  queuesDurable?: boolean;
  /** Close all queue backends (e.g. shared Redis connection). */
  onQueuesClose?: () => Promise<void>;
  /** Redis client for delayed flow promotion (durable deployments). */
  redisClient?: RedisClient;
  /** Flows queue Redis prefix for delayed sorted set. */
  flowsPrefix?: string;
  /** Refresh queue depth gauges (durable deployments). */
  refreshQueueDepths?: () => Promise<void>;
  /** Enqueue a flow step wake after flow start/trigger (optional). */
  onFlowStepEnqueue?: (executionId: string, correlationId?: string) => Promise<void>;
  /** Capability registry for auto consumer registration. */
  capabilities?: CapabilityRegistry;
  /** Entity registry for auto consumer registration. */
  entities?: EntityRegistry;
  /** Sync MCP task status when MCP-sourced jobs complete (optional @plumbus/mcp). */
  onMcpJobComplete?: (
    jobId: string,
    result: 'completed' | 'failed',
    payload?: unknown,
    error?: unknown,
  ) => Promise<void>;
  /** Consumer registry */
  consumers: ConsumerRegistry;
  /** Flow registry */
  flows: FlowRegistry;
  /** Step executor dependencies (capability invoker + condition evaluator) */
  stepDeps: StepExecutorDeps;
  /** Optional audit service for flow execution audit trail */
  audit?: AuditService;
  /** Optional logger */
  logger?: LoggerService;
  /** Runtime metrics (optional — wired to worker /metrics endpoint). */
  metrics?: PlumbusMetrics;
  /** Outbox poll interval ms (default: 1000) */
  outboxPollIntervalMs?: number;
  /** Scheduler poll interval ms (default: 60000) */
  schedulerPollIntervalMs?: number;
  /** Flow execution poll interval ms (default: 1000) */
  flowPollIntervalMs?: number;
  /** Whether to start the outbox dispatcher (default: true) */
  enableDispatcher?: boolean;
  /** Whether to start the event worker (default: true) */
  enableEventWorker?: boolean;
  /** Whether to start the flow scheduler (default: true) */
  enableScheduler?: boolean;
  /** Whether to run flow execution worker loop (default: true) */
  enableFlowRunner?: boolean;
  /** Optional AI service for capability steps that use AI */
  aiService?: AIService;
  /** Optional data service factory for capability steps that access data */
  createDataService?: (auth?: AuthContext) => DataService;
  /** Optional event registry for capability steps that emit events */
  eventRegistry?: EventRegistry;
  /** Called when a flow fails permanently (after retries exhausted). */
  onFlowError?: FlowEngineConfig['onFlowError'];
  /** Lease duration in milliseconds for flow execution claims. Default: 300,000 (5 min). */
  flowLeaseDurationMs?: number;
  /** Heartbeat interval in milliseconds for extending flow leases. Default: leaseDurationMs / 3. */
  flowHeartbeatIntervalMs?: number;
  /** Max executions to claim per poll cycle. Default: 50. */
  flowClaimBatchSize?: number;
  /**
   * Resolve the database a claimed unit of work runs against, per unit rather
   * than per boot.
   *
   * Omitted (the default) the pool behaves exactly as it always has: every
   * claimed flow execution runs against `db`. Supplied, each claimed execution
   * is mapped to a tenant reference (`resolveTenantRef` over the row's stored
   * tenant, `tenantId` by default), that reference is resolved to a data plane,
   * and the execution's repositories, events, audit and transactions are wired
   * against the resolved handle's database. A reference the resolver does not
   * recognise fails that execution — no path substitutes another tenant's
   * database.
   *
   * When a resolver is set the engine is also given `spineDispatch` (pool `db`
   * is the spine). Claim moves to `opaque_dispatch` SKIP LOCKED; tenant-local
   * `flow_executions` / `execution_state` are loaded through the resolver.
   * The outbox dispatcher, event worker (idempotency + dead-letter), and
   * scheduler use `listTenantRefs` + this resolver so each tenant's tables
   * are read on that tenant's data plane. Pool `db` is the spine.
   *
   * Two consequences worth naming: the queue-driven flow step consumer is not
   * started in this mode (it builds its context synchronously and so cannot
   * resolve a data plane; the polling runner covers the same work), and
   * `createDataService` may not be combined with a resolver — the framework
   * wires repositories from the entity registry against the resolved plane
   * instead.
   */
  dataPlaneResolver?: DataPlaneResolver;
  /**
   * Tenant references the outbox dispatcher pumps when `dataPlaneResolver`
   * is set. Combined with tenants already resolved for claimed work.
   */
  listTenantRefs?: () => Iterable<string> | Promise<Iterable<string>>;
  /** Policy for claimed work carrying no tenant reference. Default: `'refuse'`. */
  untenantedDataPlane?: UntenantedDataPlanePolicy;
  /**
   * Map an auth context to the reference `dataPlaneResolver` is keyed by.
   * Defaults to `auth.tenantId`.
   */
  resolveTenantRef?: (auth: AuthContext) => string | undefined;
  /**
   * Optional approval service for the capability-pipeline gate.
   * Omitted: existing hosts boot unchanged.
   */
  approvals?: ApprovalService;
  /**
   * Host authorization revalidation after an approval wait.
   * Harness stub only unless the host supplies one.
   */
  authorizationProvider?: AuthorizationProvider;
  /**
   * Compiled flow definitions (Plan 02 Stage 5). When set, the engine
   * consumes signed JSON instead of live TypeScript steps.
   */
  compiledRegistry?: CompiledFlowRegistry;
  /**
   * Directory of `plumbus compile-flows` JSON. Used when `compiledRegistry`
   * is omitted. An explicit path that is missing, empty, or tampered fails
   * closed. Omitted: `{cwd}/.plumbus/compiled-flows` is loaded when it has JSON.
   */
  compiledFlowsDirectory?: string;
}

// ── Worker Pool Instance ──

export interface WorkerPool {
  /** Start all enabled workers */
  start(): Promise<void>;
  /** Graceful shutdown — stops all workers */
  stop(): Promise<void>;
  /** Whether any worker is running */
  readonly isRunning: boolean;
  /** Flow engine instance (for tests and consumer registration). */
  readonly flowEngine: ReturnType<typeof createFlowEngine>;
}

/** Create and configure a worker pool with all background processes */
export function createWorkerPool(poolConfig: WorkerPoolConfig): WorkerPool {
  const {
    db,
    queue,
    consumers,
    flows,
    stepDeps,
    audit,
    outboxPollIntervalMs = 1000,
    schedulerPollIntervalMs = 60_000,
    flowPollIntervalMs: flowPollIntervalMsConfig = 1000,
    enableDispatcher = true,
    enableEventWorker = true,
    enableScheduler = true,
    enableFlowRunner = true,
  } = poolConfig;

  const jobsQueue = poolConfig.jobsQueue ?? queue;
  const flowsQueue = poolConfig.flowsQueue ?? queue;
  const flowPollIntervalMs = poolConfig.queuesDurable
    ? Math.max(flowPollIntervalMsConfig, 30_000)
    : flowPollIntervalMsConfig;

  const logger = poolConfig.logger ?? createWorkerLogger();
  const metrics = poolConfig.metrics;
  const eventRegistry = poolConfig.eventRegistry;

  // ── Per-unit data-plane resolution (opt-in) ──

  const dataPlaneResolver = poolConfig.dataPlaneResolver;
  const untenantedDataPlane = poolConfig.untenantedDataPlane ?? 'refuse';
  const resolveTenantRef = poolConfig.resolveTenantRef ?? ((auth: AuthContext) => auth.tenantId);

  if (dataPlaneResolver && poolConfig.createDataService) {
    throw new Error(
      'dataPlaneResolver and createDataService cannot both be configured: a caller-built data ' +
        'service is bound to a database the resolver does not control, so tenant work would run ' +
        'against it instead of the resolved data plane. Supply `entities` and let the framework ' +
        'wire repositories against the resolved plane.',
    );
  }

  if (dataPlaneResolver) {
    logger.info(`Per-unit data-plane resolution enabled (untenanted work: ${untenantedDataPlane})`);
  }

  /**
   * Data planes resolved so far, keyed by tenant reference. Written by the
   * async resolution that precedes a unit of work and read by the engine's
   * per-auth service factories, which are synchronous and so cannot resolve.
   * A miss throws rather than falling back to the pool's own database.
   */
  const resolvedDataPlanes = new Map<string, PostgresJsDatabase>();
  const resolvedCoreSchemas = new Map<string, string>();

  function untenantedWorkError(): PlumbusError {
    return new PlumbusError(
      ErrorCode.Forbidden,
      'This worker resolves a database per unit of work and the claimed work carries no tenant reference',
      { reason: 'untenanted-unit-of-work' },
    );
  }

  /** Resolve (and remember) the data plane a unit of work runs against. */
  async function resolveUnitDataPlane(tenantRef: string | undefined): Promise<PostgresJsDatabase> {
    if (!dataPlaneResolver) return db;
    if (!tenantRef) {
      if (untenantedDataPlane === 'control-plane') return db;
      throw untenantedWorkError();
    }
    const handle = await dataPlaneResolver.resolve(tenantRef);
    resolvedDataPlanes.set(tenantRef, handle.db);
    resolvedCoreSchemas.set(tenantRef, handle.coreSchema);
    return handle.db;
  }

  /**
   * The data plane already resolved for an auth context. Used by the engine's
   * synchronous per-auth factories, which run inside a unit of work whose plane
   * was resolved just before it started.
   */
  function dataPlaneForAuth(auth: AuthContext): PostgresJsDatabase {
    if (!dataPlaneResolver) return db;
    const tenantRef = resolveTenantRef(auth);
    if (!tenantRef) {
      if (untenantedDataPlane === 'control-plane') return db;
      throw untenantedWorkError();
    }
    const resolved = resolvedDataPlanes.get(tenantRef);
    if (!resolved) {
      throw new PlumbusError(
        ErrorCode.Internal,
        `No data plane has been resolved for tenant reference "${tenantRef}" in this worker`,
        { tenantRef },
      );
    }
    return resolved;
  }

  async function listedTenantRefs(): Promise<string[]> {
    const listed = poolConfig.listTenantRefs ? [...(await poolConfig.listTenantRefs())] : [];
    return [...new Set([...listed, ...resolvedDataPlanes.keys()])];
  }

  // Idempotency service for event worker (pool fallback; tenanted delivery
  // builds a per-plane service inside createEventWorker when resolver is set).
  const idempotency = createIdempotencyService(db);

  const systemWorkerAuth: AuthContext = {
    userId: 'system-worker',
    roles: ['system'],
    scopes: [],
    provider: 'worker',
  };
  const workerAudit =
    audit ?? createAuditService({ db, auth: systemWorkerAuth, component: 'event-worker' });

  // Outbox dispatcher
  const dispatcherConfig: DispatcherConfig = {
    db,
    queue,
    audit: workerAudit,
    pollIntervalMs: outboxPollIntervalMs,
    metrics,
    ...(dataPlaneResolver
      ? {
          resolver: dataPlaneResolver,
          spineDb: db,
          listTenantRefs: listedTenantRefs,
        }
      : {}),
  };
  const dispatcher = enableDispatcher ? createOutboxDispatcher(dispatcherConfig) : null;

  // Event delivery worker
  const eventWorkerConfig: WorkerConfig = {
    db,
    queue,
    consumers,
    idempotency,
    audit: workerAudit,
    metrics,
    resolver: dataPlaneResolver,
  };
  const eventWorker = enableEventWorker ? createEventWorker(eventWorkerConfig) : null;

  const jobEventWorker =
    enableEventWorker && jobsQueue !== queue
      ? createEventWorker({
          db,
          queue: jobsQueue,
          consumers,
          idempotency,
          audit: workerAudit,
          metrics,
          resolver: dataPlaneResolver,
        })
      : null;

  // Flow engine + scheduler
  const { createDataService } = poolConfig;
  const flowEngineConfig: FlowEngineConfig = {
    db,
    registry: flows,
    stepDeps,
    audit,
    queue,
    onFlowError: poolConfig.onFlowError,
    workerId: generateWorkerId(),
    flowLeaseDurationMs: poolConfig.flowLeaseDurationMs,
    flowHeartbeatIntervalMs: poolConfig.flowHeartbeatIntervalMs,
    flowClaimBatchSize: poolConfig.flowClaimBatchSize,
    logger,
    onFlowStepEnqueue: poolConfig.queuesDurable ? poolConfig.onFlowStepEnqueue : undefined,
    onFlowDelayedSchedule:
      poolConfig.queuesDurable && poolConfig.redisClient && poolConfig.flowsPrefix
        ? async (executionId, wakeAt) => {
            await scheduleDelayedFlowWake({
              client: poolConfig.redisClient as RedisClient,
              flowsPrefix: poolConfig.flowsPrefix as string,
              executionId,
              wakeAt,
            });
          }
        : undefined,
    spineDispatch: dataPlaneResolver ? { db, resolver: dataPlaneResolver } : undefined,
    compiledRegistry: resolveCompiledFlowRegistry({
      compiledRegistry: poolConfig.compiledRegistry,
      compiledFlowsDirectory: poolConfig.compiledFlowsDirectory,
    }),
    createDataService: createDataService ? (auth) => createDataService(auth) : undefined,
    createEventService: eventRegistry
      ? (auth) => {
          // Without a resolver this is the pool's own `db`, unchanged.
          const authDb = dataPlaneForAuth(auth);
          return createEventEmitter({
            db: authDb,
            auth,
            registry: eventRegistry,
            audit: audit ?? createAuditService({ db: authDb, auth }),
          });
        }
      : undefined,
  };
  const flowEngine = createFlowEngine(flowEngineConfig);

  if (poolConfig.capabilities && poolConfig.entities && eventRegistry) {
    registerCapabilityConsumers({
      capabilities: poolConfig.capabilities,
      consumers,
      events: eventRegistry,
      entities: poolConfig.entities,
      db,
      config: poolConfig.config,
      flowEngine,
      aiService: poolConfig.aiService,
      logger,
      metrics,
      onMcpJobComplete: poolConfig.onMcpJobComplete,
      approvals: poolConfig.approvals,
      authorizationProvider: poolConfig.authorizationProvider,
    });
  }

  // Auto-register flow trigger consumer for all event-triggered flows
  const triggerEventTypes = new Set<string>();
  for (const flow of flows.getAll()) {
    if (flow.trigger?.event) {
      triggerEventTypes.add(flow.trigger.event);
    }
  }
  if (triggerEventTypes.size > 0) {
    const triggerHandler = createFlowTriggerHandler({ registry: flows, engine: flowEngine });
    consumers.register({
      id: 'plumbus:flow-trigger',
      eventTypes: [...triggerEventTypes],
      handler: async (envelope) => {
        await triggerHandler.handleEvent(envelope);
      },
    });
    logger.info(`Registered flow trigger consumer for ${triggerEventTypes.size} event types`);
  }

  const schedulerConfig: SchedulerConfig = {
    db,
    registry: flows,
    engine: flowEngine,
    pollIntervalMs: schedulerPollIntervalMs,
    ...(dataPlaneResolver ? { resolver: dataPlaneResolver, listTenantRefs: listedTenantRefs } : {}),
  };
  const scheduler = enableScheduler ? createFlowScheduler(schedulerConfig) : null;
  let flowRunnerTimer: ReturnType<typeof setInterval> | null = null;

  async function runFlowCycle(): Promise<void> {
    if (!enableFlowRunner) return;
    try {
      const claimed = await flowEngine.claimNext();
      if (claimed.length === 0) return;

      const systemAuth = {
        userId: 'system-flow-runner',
        roles: ['system'],
        scopes: [],
        provider: 'worker',
      };

      // One context for the whole batch when every unit runs against the same
      // database — the resolver path builds one per claimed row instead.
      const baseCtx = dataPlaneResolver ? undefined : buildFlowRunnerContext(systemAuth);

      for (const row of claimed) {
        try {
          // Resolving inside the per-row try means an unknown or absent tenant
          // fails this execution the same way a failing step does, instead of
          // aborting the cycle for every other tenant in the batch.
          const ctx =
            baseCtx ??
            buildFlowRunnerContext(
              systemAuth,
              await resolveUnitDataPlane(
                resolveTenantRef({ ...systemAuth, tenantId: claimedTenantRef(row) }),
              ),
            );
          // Drain consecutive in-flow steps in a single tick.
          //
          // Why: claimNext() acquires a lease (status='running',
          // lease_expires_at = now()+leaseDurationMs) for the whole flow
          // execution row. runNext() runs ONE step and, on normal
          // advancement (next sequential step, parallel completion, or
          // conditional branch), updates currentStep but intentionally
          // leaves status='running' and the lease intact. If we returned
          // here after a single step, the row would sit idle until the
          // lease expired (default 5 min) before claimNext() picked it up
          // again — producing multi-minute "no errors, no progress" gaps
          // between successive steps of the same flow execution.
          //
          // Looping while status === Running means the worker that holds
          // the lease keeps running steps until the flow either Waits
          // (event/delay), Completes, Fails, or is Cancelled. Heartbeats
          // inside runNext extend the lease while a step is executing;
          // between steps the lease is still valid because we never
          // released it. A hard cap (`maxStepsPerCycle`) bounds the loop
          // so a runaway conditional/loop in a flow can't monopolise the
          // worker forever — when the cap is hit we break, the lease will
          // expire normally and another claim cycle (or the same worker)
          // will pick the row up.
          const maxStepsPerCycle = 1000;
          let stepsRun = 0;
          while (stepsRun < maxStepsPerCycle) {
            const result = await flowEngine.runNext(row.id, ctx);
            stepsRun += 1;
            if (result.status !== FlowStatus.Running) {
              break;
            }
          }
          if (stepsRun >= maxStepsPerCycle) {
            logger.warn('Flow drain hit maxStepsPerCycle; releasing for next cycle', {
              executionId: row.id,
              workerId: flowEngine.workerId,
              stepsRun,
              maxStepsPerCycle,
            });
          }
        } catch (err) {
          logger.error('Flow execution run failed', {
            executionId: row.id,
            workerId: flowEngine.workerId,
            ...describeError(err),
          });
          // Finalize the row as failed so the next poll cycle doesn't re-claim
          // it via the `status='running' AND lease_expires_at < now()`
          // crash-recovery branch in claimNext and spin forever. The engine
          // method is idempotent and guards on status, so this is safe even
          // if the row was concurrently finalized by cancel() or a peer worker.
          try {
            await flowEngine.markFailedFromRunner(row.id, err);
          } catch (finalizeErr) {
            logger.error('Failed to finalize flow execution after run error', {
              executionId: row.id,
              workerId: flowEngine.workerId,
              ...describeError(finalizeErr),
            });
          }
        }
      }
    } catch (err) {
      logger.error('Flow claim cycle failed', describeError(err));
    }
  }

  /**
   * Build the base context a claimed unit of work runs with.
   *
   * `contextDb` defaults to the pool's own database, which is what every caller
   * passes unless a `dataPlaneResolver` resolved a different plane for this
   * particular unit of work.
   */
  function buildFlowRunnerContext(
    systemAuth: AuthContext = {
      userId: 'system-flow-runner',
      roles: ['system'],
      scopes: [],
      provider: 'worker',
    },
    contextDb: PostgresJsDatabase = db,
  ): import('../types/context.js').ExecutionContext {
    if (poolConfig.entities && eventRegistry) {
      const tenantRef = resolveTenantRef(systemAuth);
      const durableSchema =
        (tenantRef ? resolvedCoreSchemas.get(tenantRef) : undefined) ?? FRAMEWORK_SCHEMA;
      return createExecutionContext(
        wireContextDependencies(
          {
            db: contextDb,
            auth: systemAuth,
            entities: poolConfig.entities,
            events: eventRegistry,
            encryptionKey: resolveEncryptionKey(),
            durableDispatch: dataPlaneResolver ? { schemaName: durableSchema } : undefined,
          },
          {
            flows: createFlowService(flowEngine, systemAuth, flows),
            ai: poolConfig.aiService,
            logger,
            config: poolConfig.config as unknown as Record<string, unknown>,
            ...(poolConfig.capabilities ? buildCapabilityRuntimeDeps(poolConfig.capabilities) : {}),
            ...hostApprovalRuntimeExtras(poolConfig),
          },
        ),
      );
    }

    const systemAudit = audit ?? createAuditService({ db: contextDb, auth: systemAuth });
    const dataService = poolConfig.createDataService
      ? poolConfig.createDataService(systemAuth)
      : ({} as DataService);
    const eventService = eventRegistry
      ? createEventEmitter({
          db: contextDb,
          auth: systemAuth,
          registry: eventRegistry,
          audit: systemAudit,
        })
      : undefined;
    return createExecutionContext({
      auth: systemAuth,
      data: dataService,
      events: eventService,
      flows: createFlowService(flowEngine, systemAuth, flows),
      ai: poolConfig.aiService,
      audit: systemAudit,
      logger,
      config: poolConfig.config as unknown as Record<string, unknown>,
      ...(poolConfig.capabilities ? buildCapabilityRuntimeDeps(poolConfig.capabilities) : {}),
      ...hostApprovalRuntimeExtras(poolConfig),
    });
  }

  if (dataPlaneResolver && enableFlowRunner && flowsQueue) {
    logger.warn(
      'Flow step queue consumer not started: it builds its context synchronously and cannot ' +
        'resolve a data plane per unit of work. The polling flow runner covers the same work; ' +
        'lower flowPollIntervalMs if the added latency matters.',
    );
  }

  const flowStepConsumer =
    enableFlowRunner && flowsQueue && !dataPlaneResolver
      ? createFlowStepConsumer({
          flowsQueue,
          engine: flowEngine,
          buildContext: buildFlowRunnerContext,
          logger,
          metrics,
          onReenqueue: poolConfig.onFlowStepEnqueue
            ? async (executionId) => {
                await poolConfig.onFlowStepEnqueue?.(executionId);
              }
            : undefined,
        })
      : null;

  const flowDelayedPromoter =
    enableFlowRunner && poolConfig.queuesDurable && poolConfig.redisClient && poolConfig.flowsPrefix
      ? createFlowDelayedPromoter({
          client: poolConfig.redisClient,
          flowsPrefix: poolConfig.flowsPrefix,
          flowsQueue,
          logger,
        })
      : null;

  let depthRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  return {
    get flowEngine() {
      return flowEngine;
    },

    async start() {
      if (running) return;

      // Schema preflight: 0.3.0 added `lease_owner` and `lease_expires_at`
      // to flow_executions. Consumers who upgrade `@plumbus/core` but skip
      // `plumbus migrate apply` would otherwise hit a cryptic UPDATE error
      // on the first claim cycle. Probe the columns once at startup and
      // emit an actionable error instead.
      if (enableFlowRunner) {
        await assertFlowLeaseColumns(db);
      }

      running = true;

      // Sync flow schedules to DB
      if (scheduler) {
        const synced = await scheduler.syncSchedules();
        logger.info(`Synced ${synced} flow schedules`);
        scheduler.start();
        logger.info('Flow scheduler started');
      }

      if (enableFlowRunner) {
        flowRunnerTimer = setInterval(() => {
          void runFlowCycle();
        }, flowPollIntervalMs);
        void runFlowCycle();
        logger.info('Flow execution runner started');
      }

      if (dispatcher) {
        dispatcher.start();
        logger.info('Outbox dispatcher started');
      }

      if (eventWorker) {
        eventWorker.start();
        logger.info('Event delivery worker started');
      }

      if (jobEventWorker) {
        jobEventWorker.start();
        logger.info('Job delivery worker started');
      }

      if (flowStepConsumer) {
        flowStepConsumer.start();
        logger.info('Flow step queue consumer started');
      }

      if (flowDelayedPromoter) {
        flowDelayedPromoter.start();
        logger.info('Flow delayed wake promoter started');
      }

      if (poolConfig.refreshQueueDepths && metrics) {
        const refresh = async () => {
          try {
            await poolConfig.refreshQueueDepths?.();
          } catch (err) {
            logger.warn('Queue depth refresh failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        };
        await refresh();
        depthRefreshTimer = setInterval(() => {
          void refresh();
        }, 15_000);
      }

      logger.info('Worker pool started');
    },

    async stop() {
      if (!running) return;
      logger.info('Shutting down worker pool...');

      // Stop in reverse order: new work first, then in-flight
      if (scheduler) {
        scheduler.stop();
        logger.info('Flow scheduler stopped');
      }

      if (flowRunnerTimer) {
        clearInterval(flowRunnerTimer);
        flowRunnerTimer = null;
        logger.info('Flow execution runner stopped');
      }

      if (dispatcher) {
        dispatcher.stop();
        logger.info('Outbox dispatcher stopped');
      }

      if (flowStepConsumer) {
        flowStepConsumer.stop();
        logger.info('Flow step queue consumer stopped');
      }

      if (flowDelayedPromoter) {
        flowDelayedPromoter.stop();
        logger.info('Flow delayed wake promoter stopped');
      }

      if (depthRefreshTimer) {
        clearInterval(depthRefreshTimer);
        depthRefreshTimer = null;
      }

      if (jobEventWorker && jobEventWorker !== eventWorker) {
        jobEventWorker.stop();
        logger.info('Job delivery worker stopped');
      }

      if (eventWorker) {
        eventWorker.stop();
        logger.info('Event delivery worker stopped');
      }

      if (poolConfig.onQueuesClose) {
        await poolConfig.onQueuesClose();
      } else {
        await queue.close();
      }
      logger.info('Queue closed');

      running = false;
      logger.info('Worker pool stopped');
    },

    get isRunning() {
      return running;
    },
  };
}

// ── Worker Logger ──

function createWorkerLogger(): LoggerService {
  const prefix = '[plumbus:worker]';
  return {
    debug(message, metadata) {
      console.debug(`${prefix} ${message}`, metadata ? JSON.stringify(metadata) : '');
    },
    info(message, metadata) {
      console.info(`${prefix} ${message}`, metadata ? JSON.stringify(metadata) : '');
    },
    warn(message, metadata) {
      console.warn(`${prefix} ${message}`, metadata ? JSON.stringify(metadata) : '');
    },
    error(message, metadata) {
      console.error(`${prefix} ${message}`, metadata ? JSON.stringify(metadata) : '');
    },
  };
}
