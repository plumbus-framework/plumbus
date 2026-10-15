// ── Worker Process Bootstrap ──
// Separate process that starts background workers:
// outbox dispatcher, event delivery worker, flow step executor,
// flow scheduler. Handles graceful shutdown.

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { resolveEncryptionKey } from '../data/field-encryption.js';
import { FRAMEWORK_SCHEMA, resolveFrameworkSchema } from '../data/schema-generator.js';
import { createAuditService } from '../audit/service.js';
import { FlowDefinitionUnavailableError } from '../errors/index.js';
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
import type { EventDeadLetterInfo, EventDeliveryOptions } from '../events/index.js';
import type { WorkerConfig } from '../events/worker.js';
import { createEventWorker } from '../events/worker.js';
import { createJobDispatchService, publishPendingJobs } from '../jobs/index.js';
import { hostApprovalRuntimeExtras } from '../approvals/host-runtime.js';
import type { GovernedArtifactStore } from '../ai/governed-artifacts.js';
import { resolveGovernedArtifactStore } from '../ai/governed-artifacts.js';
import type { ApprovalService, AuthorizationProvider } from '../approvals/types.js';
import {
  type CapabilityErrorInfo,
  fireCapabilityErrorHook,
} from '../execution/capability-error-hook.js';
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
import { recoverFlowStartIntents, sweepFailedFlows } from '../flows/index.js';
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
import { settleBy } from '../runtime/graceful-shutdown.js';
import { registerCapabilityConsumers } from '../runtime/register-consumers.js';
import type { AuditService } from '../types/audit.js';
import type { PlumbusConfig } from '../types/config.js';
import type { AIService, DataService, LoggerService } from '../types/context.js';
import type { PlumbusErrorLike } from '../types/errors.js';
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

// ── Flow step capability errors ──
// buildStepDeps names the capability on a failure that came from executeCapability;
// unknown names and rejected job targets carry no name and are not reported.
// An aborted step (flow cancelled or lease lost) is discarded by the engine, so
// its failure is not reported either.
function withCapabilityErrorHook(
  stepDeps: StepExecutorDeps,
  hook: WorkerPoolConfig['onCapabilityError'],
  resolveDb: (auth: AuthContext) => PostgresJsDatabase,
): StepExecutorDeps {
  if (!hook) return stepDeps;
  return {
    ...stepDeps,
    executeCapability: async (capabilityName, ctx, input) => {
      const result = await stepDeps.executeCapability(capabilityName, ctx, input);
      if (!result.success && result.capability && !ctx.signal?.aborted) {
        const error = result.error as PlumbusErrorLike;
        fireCapabilityErrorHook(hook, {
          capabilityName: result.capability.name,
          domain: result.capability.domain,
          errorCode: error.code,
          errorMessage: error.message,
          metadata: error.metadata,
          userId: ctx.auth.userId,
          tenantId: ctx.auth.tenantId,
          db: resolveDb(ctx.auth),
          source: 'flow',
        });
      }
      return result;
    },
  };
}

// ── Flow-execution column preflight ──
//
// The engine selects every column the framework added to flow_executions:
// the claim lease (`lease_owner`, `lease_expires_at`, 0.3.0), the claim token
// and wait kind (`lease_token`, `wait_kind`), replay and schedule provenance
// (`replay_of`, `schedule_id`, `schedule_tick_id`) and the compiled-definition
// pin (`definition_version`, `definition_digest`). If a consumer upgrades
// `@plumbus/core` but forgets to run `plumbus migrate generate` +
// `plumbus migrate apply`, the first claim-cycle query fails with PG error
// 42703 (undefined_column) deep inside drizzle, producing logs that don't
// point at the real fix. This probe runs one cheap `LIMIT 0` SELECT against
// those columns and rethrows a clear, actionable error when they're missing.
//
// Exported for direct testing.
export async function assertFlowLeaseColumns(db: PostgresJsDatabase): Promise<void> {
  try {
    await db.execute(
      sql`SELECT lease_owner, lease_expires_at, lease_token, wait_kind, replay_of, schedule_id, schedule_tick_id, definition_version, definition_digest FROM flow_executions LIMIT 0`,
    );
  } catch (err) {
    const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
    const pgCode =
      cause && typeof cause === 'object' && 'code' in cause
        ? (cause as { code?: unknown }).code
        : undefined;
    if (pgCode === '42703') {
      throw new Error(
        'Plumbus requires migrated flow_executions (lease_owner, lease_expires_at, lease_token, wait_kind, replay_of, schedule_id, schedule_tick_id, definition_version, definition_digest).\n' +
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
  /** Event delivery policy (retry, unrouted, ignored event types). Default: `config.workers.eventDelivery`. */
  eventDelivery?: EventDeliveryOptions;
  /** Called after an event delivery is dead-lettered (best-effort; failures are logged). */
  onEventDeadLetter?: (info: EventDeadLetterInfo) => void | Promise<void>;
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
  /** The schema the tenant durable tables (execution_state, dispatch_outbox) live in. Read by the flow engine when it writes them and by the outbox dispatcher when it reads them. Default: PLUMBUS_FRAMEWORK_SCHEMA, else the framework default (core_plumbus). */
  frameworkSchema?: string;
  /** Optional AI service for capability steps that use AI */
  aiService?: AIService;
  /** Optional data service factory for capability steps that access data */
  createDataService?: (auth?: AuthContext) => DataService;
  /** Optional event registry for capability steps that emit events */
  eventRegistry?: EventRegistry;
  /** Called when a flow fails permanently (after retries exhausted). */
  onFlowError?: FlowEngineConfig['onFlowError'];
  /**
   * Called when a flow step, job, or event handler capability returns a non-success
   * result. Fire-and-forget: hook errors are logged and never change retries or
   * failure handling. Flow steps are reported when `stepDeps` comes from `buildStepDeps`;
   * jobs and event handlers when the pool registers their consumers (`capabilities`,
   * `entities` and `eventRegistry` set).
   */
  onCapabilityError?: (info: CapabilityErrorInfo) => void | Promise<void>;
  /** Lease duration in milliseconds for flow execution claims. Default: 300,000 (5 min). */
  flowLeaseDurationMs?: number;
  /** Heartbeat interval in milliseconds for extending flow leases. Default: leaseDurationMs / 3. */
  flowHeartbeatIntervalMs?: number;
  /** Max executions to claim per poll cycle. Default: 50. */
  flowClaimBatchSize?: number;
  /**
   * How often the runner starts flows whose post-commit start never happened (a process died
   * between a capability's commit and its deferred `ctx.flows.start`): due rows of
   * `flow_start_intents` on the pool and on every listed tenant plane. Default 10 000 ms.
   */
  flowStartRecoveryIntervalMs?: number;
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
   * Where a claimed unit's repositories, events and audit are wired when `dataPlaneResolver`
   * is set. `'resolved'` (default): against the unit's tenant plane. `'control-plane'`: against
   * the pool's own database, for a host that routes tenant data itself and reaches the plane
   * from its handlers — the flows are still placed on the tenant plane and claimed from the
   * spine either way.
   */
  unitDataPlane?: 'resolved' | 'control-plane';
  /**
   * Tenant planes for the flow scheduler alone: one schedule row per tenant for flows
   * scheduled on `tenants`, started with that tenant on auth. Flows, events and the outbox keep
   * the pool's data plane (the schedule's durable ticks and executions are written to the pool
   * too) — for a host that routes tenant data itself and has no `dataPlaneResolver`. Ignored when
   * `dataPlaneResolver` is set (it already covers the scheduler).
   */
  schedulePlanes?: {
    resolver: DataPlaneResolver;
    listTenantRefs: () => Iterable<string> | Promise<Iterable<string>>;
  };
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
   * Optional governed prompt/policy store. Omitted: existing hosts boot unchanged.
   * Same resolution rules as createServer.
   */
  artifacts?: GovernedArtifactStore;
  /**
   * Directory for the filesystem governed artifact store when `artifacts` is omitted.
   */
  artifactsDirectory?: string;
  /**
   * Host authorization revalidation after an approval wait.
   * Harness stub only unless the host supplies one.
   */
  authorizationProvider?: AuthorizationProvider;
  /**
   * Compiled flow definitions. When set, the engine
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

export interface WorkerPoolStopOptions {
  /**
   * Epoch milliseconds until which `stop()` waits for the flow step running now. The runner
   * claims nothing new once stop begins and, after the running step, releases its execution
   * for another worker instead of draining the next step. Omitted, `stop()` does not wait for
   * a running step (it is abandoned when the host closes the database, and its lease expires).
   */
  deadlineAt?: number;
}

export interface WorkerPool {
  /** Start all enabled workers */
  start(): Promise<void>;
  /** Graceful shutdown — stops all workers */
  stop(options?: WorkerPoolStopOptions): Promise<void>;
  /**
   * True while the flow runner is inside a cycle — after `stop()`, a step that was still
   * running at the deadline and was abandoned.
   */
  readonly flowCycleInFlight?: boolean;
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
    frameworkSchema,
    enableDispatcher = true,
    enableEventWorker = true,
    enableScheduler = poolConfig.config.workers?.enableScheduler ?? true,
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
  const artifacts = resolveGovernedArtifactStore({
    artifacts: poolConfig.artifacts,
    artifactsDirectory: poolConfig.artifactsDirectory,
  });

  // ── Per-unit data-plane resolution (opt-in) ──

  const dataPlaneResolver = poolConfig.dataPlaneResolver;
  const untenantedDataPlane = poolConfig.untenantedDataPlane ?? 'refuse';
  const unitsOnControlPlane = poolConfig.unitDataPlane === 'control-plane';
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
    logger.info(
      `Per-unit data-plane resolution enabled (untenanted work: ${untenantedDataPlane}; unit repositories: ${unitsOnControlPlane ? 'control-plane' : 'resolved'})`,
    );
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
    if (!dataPlaneResolver || unitsOnControlPlane) return db;
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
    if (!dataPlaneResolver || unitsOnControlPlane) return db;
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
    logger,
    pollIntervalMs: outboxPollIntervalMs,
    metrics,
    ...(dataPlaneResolver
      ? {
          resolver: dataPlaneResolver,
          spineDb: db,
          listTenantRefs: listedTenantRefs,
          // The pump reads `dispatch_outbox` where the engine below writes it.
          ...(frameworkSchema ? { frameworkSchema } : {}),
        }
      : {}),
  };
  const dispatcher = enableDispatcher ? createOutboxDispatcher(dispatcherConfig) : null;

  // Event delivery worker
  const eventWorkerConfig: WorkerConfig = {
    ...(poolConfig.eventDelivery ?? poolConfig.config.workers?.eventDelivery),
    onEventDeadLetter: poolConfig.onEventDeadLetter,
    db,
    queue,
    consumers,
    idempotency,
    audit: workerAudit,
    logger,
    metrics,
    resolver: dataPlaneResolver,
  };
  const eventWorker = enableEventWorker ? createEventWorker(eventWorkerConfig) : null;

  const jobEventWorker =
    enableEventWorker && jobsQueue !== queue
      ? createEventWorker({
          ...(poolConfig.eventDelivery ?? poolConfig.config.workers?.eventDelivery),
          onEventDeadLetter: poolConfig.onEventDeadLetter,
          db,
          queue: jobsQueue,
          consumers,
          idempotency,
          audit: workerAudit,
          logger,
          metrics,
          resolver: dataPlaneResolver,
        })
      : null;

  // Flow engine + scheduler
  const { createDataService } = poolConfig;
  /** The data plane each execution in the current flow cycle runs against, keyed by execution id. */
  const unitPlanes = new Map<string, PostgresJsDatabase>();
  const flowEngineConfig: FlowEngineConfig = {
    db,
    registry: flows,
    stepDeps: withCapabilityErrorHook(stepDeps, poolConfig.onCapabilityError, dataPlaneForAuth),
    audit,
    queue,
    onFlowError: poolConfig.onFlowError,
    workerId: generateWorkerId(),
    flowLeaseDurationMs: poolConfig.flowLeaseDurationMs,
    flowHeartbeatIntervalMs: poolConfig.flowHeartbeatIntervalMs,
    flowClaimBatchSize: poolConfig.flowClaimBatchSize,
    logger,
    // The engine logs `definition-unavailable` and releases the execution; count it here.
    onDefinitionUnavailable: (info) =>
      metrics?.flowDefinitionUnavailable?.inc({ flow: info.flowName, reason: info.reason }),
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
    // The engine claims tenant hints from the spine and, under `'control-plane'`, the spine's
    // own rows for untenanted flows beside them — the same policy the pool applies to a
    // claimed unit with no tenant.
    spineDispatch: dataPlaneResolver
      ? {
          db,
          resolver: dataPlaneResolver,
          untenanted: untenantedDataPlane,
          // The host's framework schema (PLUMBUS_FRAMEWORK_SCHEMA): the engine qualifies the
          // tenant's durable tables with it when it writes dispatch acceptance and outbox
          // rows. Without it the engine falls back to the compiled-in default, which drifts
          // from a host that provisioned its planes under another schema name.
          coreSchema: frameworkSchema ?? resolveFrameworkSchema() ?? FRAMEWORK_SCHEMA,
        }
      : undefined,
    compiledRegistry: resolveCompiledFlowRegistry({
      compiledRegistry: poolConfig.compiledRegistry,
      compiledFlowsDirectory: poolConfig.compiledFlowsDirectory,
    }),
    // Each step runs with the flow's caller identity and correlation, wired against the data
    // plane the runner resolved for this execution (the pool's own `db` without a resolver).
    createContext: (auth, metadata) =>
      buildFlowRunnerContext(
        auth,
        unitPlanes.get(metadata.flowId) ?? dataPlaneForAuth(auth),
        metadata,
      ),
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
      onCapabilityError: poolConfig.onCapabilityError,
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

  const schedulePlanes = poolConfig.schedulePlanes;
  const schedulerConfig: SchedulerConfig = {
    db,
    registry: flows,
    engine: flowEngine,
    pollIntervalMs: schedulerPollIntervalMs,
    logger,
    // Under a resolver tenant-plane schedules start their flows on that plane; with schedule
    // planes alone the flows keep the pool plane, so their ticks and executions live there.
    ...(dataPlaneResolver
      ? {
          resolver: dataPlaneResolver,
          listTenantRefs: listedTenantRefs,
          tenantExecutions: 'schedule-plane' as const,
        }
      : schedulePlanes
        ? {
            resolver: schedulePlanes.resolver,
            listTenantRefs: schedulePlanes.listTenantRefs,
            tenantExecutions: 'pool' as const,
          }
        : {}),
  };
  if (!dataPlaneResolver && schedulePlanes) {
    logger.info('Flow scheduler runs on the pool plane and every tenant plane the host lists');
  }
  const scheduler = enableScheduler ? createFlowScheduler(schedulerConfig) : null;
  let flowRunnerTimer: ReturnType<typeof setInterval> | null = null;

  let flowCycleRunning = false;
  /** The flow cycle running now (claims and the steps it drains); stop() waits for it. */
  let flowCycleInFlight: Promise<void> | null = null;
  /** The execution the cycle is draining, for the shutdown log. */
  let drainingExecutionId: string | null = null;
  function triggerFlowCycle(): void {
    const cycle = runFlowCycle();
    if (flowCycleInFlight) return;
    flowCycleInFlight = cycle;
    void cycle.finally(() => {
      if (flowCycleInFlight === cycle) flowCycleInFlight = null;
    });
  }
  /**
   * The cycle's sweep or claim query in flight. stop() waits for it so the host can close the
   * database right after; a step already running is left to finish on its own, as before.
   */
  let pollInFlight: Promise<unknown> | null = null;
  function polling<T>(work: Promise<T>): Promise<T> {
    pollInFlight = work;
    return work.finally(() => {
      if (pollInFlight === work) pollInFlight = null;
    });
  }
  let lastTenantSweepAt = -Infinity;
  /**
   * The tenant-plane dead-letter sweep in flight. It runs beside the claim cycle, never inside
   * it, so an unreachable plane cannot hold up claiming; stop() waits for it like a poll.
   */
  let tenantSweepInFlight: Promise<void> | null = null;
  /** When each sweep source last warned: the pool, the tenant list, and every tenant plane apart. */
  const lastSweepWarningAt = new Map<string, number>();

  function warnSweepFailed(
    err: unknown,
    source: 'pool' | 'tenant-list' | { tenantRef: string },
  ): void {
    // A missing dead-letter table fails every cycle; say so once a minute, not once a second.
    // Counted per source, so one failing source never hides another.
    const key = typeof source === 'string' ? source : `tenant-plane:${source.tenantRef}`;
    if (Date.now() - (lastSweepWarningAt.get(key) ?? -Infinity) < 60_000) return;
    lastSweepWarningAt.set(key, Date.now());
    logger.warn('Flow dead-letter sweep failed', {
      ...(typeof source === 'string'
        ? { source }
        : { source: 'tenant-plane', tenantRef: source.tenantRef }),
      ...describeError(err),
    });
  }

  /**
   * Snapshot failed pool executions that have no dead letter yet. Runs every cycle, before the
   * claims. Never throws: a sweep failure must not stop the cycle from claiming work.
   */
  async function sweepPoolDeadLetters(): Promise<void> {
    try {
      await sweepFailedFlows(db);
    } catch (err) {
      warnSweepFailed(err, 'pool');
    }
  }

  /**
   * The same snapshot on each listed tenant plane (where tenant flows live), one plane after
   * another, and the plane's due deferred flow starts. A backstop only: `failFlow` already
   * writes the dead letter on the execution's plane. Never throws, and stops at the next plane
   * once the pool is stopping.
   */
  async function sweepTenantDeadLetters(resolver: DataPlaneResolver): Promise<void> {
    let tenantRefs: string[];
    try {
      tenantRefs = await listedTenantRefs();
    } catch (err) {
      warnSweepFailed(err, 'tenant-list');
      return;
    }
    for (const tenantRef of tenantRefs) {
      if (!running) return;
      let planeDb: PostgresJsDatabase;
      try {
        planeDb = (await resolver.resolve(tenantRef)).db;
        await sweepFailedFlows(planeDb);
      } catch (err) {
        warnSweepFailed(err, { tenantRef });
        continue;
      }
      // Deferred flow starts a request or a step on this plane committed and never started.
      if (enableFlowRunner && running) await recoverIntentsOn(planeDb, `tenant-plane:${tenantRef}`);
    }
  }

  /**
   * With a resolver, start the tenant-plane sweep once a minute (counted from the end of the
   * previous one) without awaiting it: an unreachable plane can take a connect timeout per
   * sweep, and the cycle keeps claiming on every plane meanwhile. One sweep at a time, and none
   * once stop() has begun: stop() reads `tenantSweepInFlight` only once, after the cycle's poll.
   */
  function startTenantSweepWhenDue(): void {
    if (!dataPlaneResolver || !running || tenantSweepInFlight) return;
    if (Date.now() - lastTenantSweepAt < 60_000) return;
    lastTenantSweepAt = Date.now();
    const sweep = sweepTenantDeadLetters(dataPlaneResolver)
      .catch((err) => warnSweepFailed(err, 'tenant-list'))
      .finally(() => {
        lastTenantSweepAt = Date.now();
        if (tenantSweepInFlight === sweep) tenantSweepInFlight = null;
      });
    tenantSweepInFlight = sweep;
  }

  let intentRecoveryTimer: ReturnType<typeof setInterval> | null = null;
  /** The deferred-start recovery sweep in flight; stop() waits for it like a poll. */
  let intentRecoveryInFlight: Promise<void> | null = null;
  const lastIntentWarningAt = new Map<string, number>();

  async function recoverIntentsOn(planeDb: PostgresJsDatabase, source: string): Promise<void> {
    try {
      await recoverFlowStartIntents({
        db: planeDb,
        start: (intent) =>
          flowEngine.start(intent.flowName, intent.input, intent.auth, {
            executionId: intent.executionId,
          }),
        logger,
      });
    } catch (err) {
      // A database not yet migrated fails every sweep; say so once a minute per source.
      if (Date.now() - (lastIntentWarningAt.get(source) ?? -Infinity) < 60_000) return;
      lastIntentWarningAt.set(source, Date.now());
      logger.warn('Deferred flow start recovery failed', { source, ...describeError(err) });
    }
  }

  /**
   * Start leftover deferred flow starts on the pool. Tenant planes are recovered by the
   * once-a-minute tenant sweep, which already visits every listed plane.
   */
  function triggerIntentRecovery(): void {
    if (!running || intentRecoveryInFlight) return;
    const sweep = recoverIntentsOn(db, 'pool').finally(() => {
      if (intentRecoveryInFlight === sweep) intentRecoveryInFlight = null;
    });
    intentRecoveryInFlight = sweep;
  }

  /** Hand a running execution back between steps; a failure leaves it to lease expiry. */
  async function releaseForShutdown(executionId: string, leaseToken?: string): Promise<void> {
    try {
      const released = await flowEngine.releaseClaim(executionId, leaseToken);
      logger.info('Worker stopping: released the flow execution for another worker', {
        executionId,
        workerId: flowEngine.workerId,
        released,
      });
    } catch (err) {
      logger.warn('Worker stopping: could not release the flow execution; its lease expires', {
        executionId,
        workerId: flowEngine.workerId,
        ...describeError(err),
      });
    }
  }

  async function runFlowCycle(): Promise<void> {
    if (!enableFlowRunner || !running || flowCycleRunning) return;
    flowCycleRunning = true;
    try {
      await polling(sweepPoolDeadLetters());
      startTenantSweepWhenDue();
      // Lease only work that can start now. Prefetched rows otherwise wait behind
      // long steps without a heartbeat, and another poll can reclaim them.
      const cycleLimit = poolConfig.flowClaimBatchSize ?? 50;
      for (let count = 0; count < cycleLimit && running; count += 1) {
        const claimed = await polling(flowEngine.claimNext(1));
        if (claimed.length === 0) break;

        const systemAuth = {
          userId: 'system-flow-runner',
          roles: ['system'],
          scopes: [],
          provider: 'worker',
        };

        // Build a shared-plane context for this claim; the resolver path instead
        // builds the context from the claimed tenant below.
        const baseCtx = dataPlaneResolver ? undefined : buildFlowRunnerContext(systemAuth);

        for (const row of claimed) {
          // The claim's fencing token: every write the engine makes for this run carries it,
          // and a runner that lost it can no longer finalize the execution.
          const leaseToken = row.leaseToken ?? undefined;
          try {
            // Resolving inside the per-row try means an unknown or absent tenant
            // fails this execution the same way a failing step does, instead of
            // aborting the cycle for every other tenant in the batch.
            // The unit's auth carries the row's tenant, so the repositories, audit and durable
            // schema the context is wired with are the resolved plane's — not the pool's.
            const unitTenantRef = resolveTenantRef({
              ...systemAuth,
              tenantId: claimedTenantRef(row),
            });
            const unitAuth = unitTenantRef
              ? { ...systemAuth, tenantId: unitTenantRef }
              : systemAuth;
            const unitDb = baseCtx ? db : await resolveUnitDataPlane(unitTenantRef);
            unitPlanes.set(row.id, unitDb);
            const ctx = baseCtx ?? buildFlowRunnerContext(unitAuth, unitDb);
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
            //
            // Once stop() has begun, the step running now finishes and the execution is
            // released (lease expired now, spine hint ready) rather than drained further, so
            // another worker continues it at once.
            const maxStepsPerCycle = 1000;
            let stepsRun = 0;
            drainingExecutionId = row.id;
            while (stepsRun < maxStepsPerCycle) {
              const result = await flowEngine.runNext(row.id, ctx, leaseToken);
              stepsRun += 1;
              if (result.status !== FlowStatus.Running) {
                break;
              }
              if (!running) {
                await releaseForShutdown(row.id, leaseToken);
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
            // A missing definition is not a failure: the engine released the execution for a
            // worker that has it, and already logged `definition-unavailable`.
            if (!(err instanceof FlowDefinitionUnavailableError)) {
              logger.error('Flow execution run failed', {
                executionId: row.id,
                workerId: flowEngine.workerId,
                ...describeError(err),
              });
            }
            // Finalize the row as failed so the next poll cycle doesn't re-claim
            // it via the `status='running' AND lease_expires_at < now()`
            // crash-recovery branch in claimNext and spin forever. The engine
            // fences the write with this claim's token, so a runner whose lease
            // was lost (or whose flow was cancelled) never fails another
            // worker's execution.
            try {
              await flowEngine.markFailedFromRunner(row.id, err, leaseToken);
            } catch (finalizeErr) {
              logger.error('Failed to finalize flow execution after run error', {
                executionId: row.id,
                workerId: flowEngine.workerId,
                ...describeError(finalizeErr),
              });
            }
          } finally {
            drainingExecutionId = null;
            unitPlanes.delete(row.id);
          }
        }
      }
    } catch (err) {
      logger.error('Flow claim cycle failed', describeError(err));
    } finally {
      flowCycleRunning = false;
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
    metadata?: { correlationId: string; flowId: string },
  ): import('../types/context.js').ExecutionContext {
    // A unit on a resolved tenant plane gets no job queue: its transaction would write the job
    // intent on the plane while publication, recovery and the job consumer all read the pool, so
    // the job would never run (or would run against the pool with the tenant's auth). Its
    // `ctx.jobs.enqueue` throws until the job pipeline is plane-aware.
    const jobs =
      poolConfig.capabilities && contextDb === db
        ? createJobDispatchService({
            db,
            jobQueue: jobsQueue,
            resolveCapability: (name) => poolConfig.capabilities?.get(name),
            auth: systemAuth,
            source: 'flow',
            correlationId: metadata?.correlationId,
            logger,
          })
        : undefined;
    if (poolConfig.entities && eventRegistry) {
      const tenantRef = resolveTenantRef(systemAuth);
      const durableSchema =
        (tenantRef ? resolvedCoreSchemas.get(tenantRef) : undefined) ?? FRAMEWORK_SCHEMA;
      return createExecutionContext(
        wireContextDependencies(
          {
            db: contextDb,
            auth: systemAuth,
            correlationId: metadata?.correlationId,
            getCausationId: () => metadata?.flowId,
            // The host audit records on the pool; a tenant unit keeps its plane-local audit.
            ...(contextDb === db && audit ? { audit } : {}),
            entities: poolConfig.entities,
            events: eventRegistry,
            encryptionKey: resolveEncryptionKey(),
            durableDispatch:
              dataPlaneResolver && !unitsOnControlPlane ? { schemaName: durableSchema } : undefined,
          },
          {
            jobs,
            flows: createFlowService(flowEngine, systemAuth, flows),
            ai: poolConfig.aiService,
            logger,
            config: poolConfig.config as unknown as Record<string, unknown>,
            ...(poolConfig.capabilities ? buildCapabilityRuntimeDeps(poolConfig.capabilities) : {}),
            ...hostApprovalRuntimeExtras(poolConfig),
            ...(artifacts ? { artifacts } : {}),
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
          correlationId: metadata?.correlationId,
          causationId: metadata?.flowId,
          registry: eventRegistry,
          audit: systemAudit,
        })
      : undefined;
    return createExecutionContext({
      auth: systemAuth,
      data: dataService,
      events: eventService,
      jobs,
      flows: createFlowService(flowEngine, systemAuth, flows),
      ai: poolConfig.aiService,
      audit: systemAudit,
      logger,
      config: poolConfig.config as unknown as Record<string, unknown>,
      ...(poolConfig.capabilities ? buildCapabilityRuntimeDeps(poolConfig.capabilities) : {}),
      ...hostApprovalRuntimeExtras(poolConfig),
      ...(artifacts ? { artifacts } : {}),
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
  let jobPublishTimer: ReturnType<typeof setInterval> | undefined;
  let publishingJobs: Promise<unknown> | undefined;
  function recoverJobs() {
    if (publishingJobs) return;
    publishingJobs = publishPendingJobs(db, jobsQueue, undefined, 50, logger)
      .catch(() => logger.error('Pending job publication recovery failed'))
      .finally(() => {
        publishingJobs = undefined;
      });
  }

  return {
    get flowEngine() {
      return flowEngine;
    },

    async start() {
      if (running) return;

      // Schema preflight: the engine reads the claim, wait, provenance and
      // definition-pin columns the framework added to flow_executions.
      // Consumers who upgrade `@plumbus/core` but skip `plumbus migrate apply`
      // would otherwise hit a cryptic query error on the first claim cycle.
      // Probe the columns once at startup and emit an actionable error instead.
      if (enableFlowRunner) {
        await assertFlowLeaseColumns(db);
      }

      // Sync flow schedules to DB
      if (scheduler) {
        const synced = await scheduler.syncSchedules();
        logger.info(`Synced ${synced} flow schedules`);
        scheduler.start();
        logger.info('Flow scheduler started');
      }

      running = true;
      if (poolConfig.capabilities?.getAll().some((capability) => capability.kind === 'job')) {
        jobPublishTimer = setInterval(recoverJobs, 1000);
        recoverJobs();
      }

      if (enableFlowRunner) {
        flowRunnerTimer = setInterval(triggerFlowCycle, flowPollIntervalMs);
        triggerFlowCycle();
        intentRecoveryTimer = setInterval(
          triggerIntentRecovery,
          poolConfig.flowStartRecoveryIntervalMs ?? 10_000,
        );
        triggerIntentRecovery();
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

    async stop(options?: WorkerPoolStopOptions) {
      if (!running) return;
      running = false;
      logger.info('Shutting down worker pool...');
      clearInterval(jobPublishTimer);
      await publishingJobs;

      // Stop in reverse order: new work first, then in-flight
      if (scheduler) {
        await scheduler.stop();
        logger.info('Flow scheduler stopped');
      }

      if (flowRunnerTimer) {
        clearInterval(flowRunnerTimer);
        flowRunnerTimer = null;
        if (intentRecoveryTimer) clearInterval(intentRecoveryTimer);
        intentRecoveryTimer = null;
        await pollInFlight?.catch(() => undefined);
        // The tenant sweeps end at their next plane now that `running` is false.
        await tenantSweepInFlight?.catch(() => undefined);
        await intentRecoveryInFlight?.catch(() => undefined);
        // The step running now gets until the deadline; the cycle claims nothing more.
        const cycle = flowCycleInFlight;
        if (cycle && options?.deadlineAt !== undefined) {
          const finished = await settleBy(cycle, options.deadlineAt);
          if (!finished) {
            logger.warn(
              'Flow step still running at the shutdown deadline; abandoned, its lease expires',
              { executionId: drainingExecutionId, workerId: flowEngine.workerId },
            );
          }
        }
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

    get flowCycleInFlight() {
      return flowCycleInFlight !== null;
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
