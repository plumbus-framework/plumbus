import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { parseDurationToMs } from '../config/duration.js';
import { FlowCancelledError, LeaseLostError, PlumbusError } from '../errors/index.js';
import {
  BUDGET_EXHAUSTED,
  consumeExecutionBudget,
  createExecutionBudgetLedger,
  writeExecutionBudget,
} from './budget.js';
import type { ApprovalService } from '../approvals/types.js';
import type { EventQueue } from '../events/queue.js';
import type { AuditService } from '../types/audit.js';
import type {
  AIService,
  DataService,
  EventService,
  ExecutionContext,
  FlowExecution,
  LoggerService,
} from '../types/context.js';
import { AuthRole, BackoffStrategy, ErrorCode, FlowStepType } from '../types/enums.js';
import type { CapabilityStep, FlowDefinition, FlowStep, ParallelStep } from '../types/flow.js';
import type { AuthContext } from '../types/security.js';
import { FRAMEWORK_SCHEMA } from '../data/schema-generator.js';
import {
  ackSpineDispatch,
  casAdvanceExecution,
  claimSpineDispatch,
  insertDispatchOutbox,
  loadExecutionState,
  persistAcceptanceOnDb,
  publishOutboxToSpine,
} from '../durable/index.js';
import type { OpaqueDispatchRecord } from '../durable/types.js';
import type { DataPlaneResolver } from '../tenancy/types.js';
import { flowDefinitionId, hydrateCompiledFlow } from './compile-flow.js';
import type { CompiledFlowRegistry } from './compiled-registry.js';
import {
  assertSupportedDefinitionStrategy,
  DefinitionInFlightStrategy,
  type DefinitionInFlightStrategy as DefinitionInFlightStrategyName,
} from './definition-strategy.js';
import type { FlowRegistry } from './registry.js';
import { flowExecutionsTable } from './schema.js';
import {
  assertTransition,
  FlowStatus,
  isTerminal,
  type StepHistoryEntry,
  StepStatus,
} from './state-machine.js';
import {
  buildHistoryEntry,
  executeStep,
  type StepExecutorDeps,
  type StepResult,
} from './step-executor.js';

/** Default lease duration: 5 minutes */
const DEFAULT_LEASE_DURATION_MS = 300_000;
/** Default claim batch size */
const DEFAULT_CLAIM_BATCH_SIZE = 50;

/**
 * Read the affected-row count from a Drizzle UPDATE/INSERT/DELETE result in a
 * driver-agnostic way. postgres-js exposes this as `.count` (the array-like
 * `Result` has `length === 0` when no RETURNING clause is used), while
 * node-postgres exposes it as `.rowCount`. Returning `length` is only a
 * correct fallback for queries that include `.returning(...)`.
 *
 * Historical bug: reading only `rowCount ?? length` silently returned 0 for
 * every postgres-js UPDATE without RETURNING, which caused `extendLease` to
 * always report "lease lost" even when the row was successfully updated.
 */
function getRowsAffected(result: unknown): number {
  const r = result as { rowCount?: unknown; count?: unknown; length?: unknown } | null | undefined;
  if (typeof r?.rowCount === 'number') return r.rowCount;
  if (typeof r?.count === 'number') return r.count;
  if (typeof r?.length === 'number') return r.length;
  return 0;
}

export interface FlowEngineConfig {
  db: PostgresJsDatabase;
  registry: FlowRegistry;
  stepDeps: StepExecutorDeps;
  audit?: AuditService;
  queue?: EventQueue;
  /** Create a data service scoped to a specific auth context (for tenant isolation in flows). */
  createDataService?: (auth: AuthContext) => DataService;
  /** Create an event service scoped to a specific auth context. */
  createEventService?: (auth: AuthContext) => EventService;
  /** Called when a flow fails permanently (after retries exhausted). */
  onFlowError?: (info: {
    executionId: string;
    flowName: string;
    step: string | null;
    error: string;
    tenantId?: string | null;
    actor?: string;
    db?: PostgresJsDatabase;
  }) => Promise<void> | void;
  /** Unique worker identity. Auto-generated if not provided. */
  workerId?: string;
  /** Lease duration in milliseconds. Default: 300,000 (5 min). */
  flowLeaseDurationMs?: number;
  /** Heartbeat interval in milliseconds. Default: leaseDurationMs / 3. */
  flowHeartbeatIntervalMs?: number;
  /** Max executions to claim per poll cycle. Default: 50. */
  flowClaimBatchSize?: number;
  /** When set, enqueue flow step wake messages (durable queue deployments). */
  onFlowStepEnqueue?: (executionId: string, correlationId?: string) => Promise<void>;
  /** When set, schedule delayed flow wake via Redis sorted set (durable deployments). */
  onFlowDelayedSchedule?: (
    executionId: string,
    wakeAt: Date,
    correlationId?: string,
  ) => Promise<void>;
  /**
   * Optional logger used for diagnostic events (heartbeat ticks, unexpected
   * lease-extension failures, etc). If omitted, the engine is silent. The
   * worker bootstrap passes its pino-backed logger here so engine diagnostics
   * land in the same `[plumbus:worker]` stream as everything else.
   */
  logger?: LoggerService;
  /**
   * Protocol A: claim wake-ups from a spine database, then load tenant-local
   * flow_executions / execution_state via the resolver. Omitted, the engine
   * keeps today's single-database claim loop on `flow_executions`.
   */
  spineDispatch?: FlowSpineDispatchConfig;
  /**
   * Optional compiled-definition registry (Plan 02 Stage 5). When set,
   * the engine consumes compiled JSON (not live TypeScript steps):
   * `start` requires a published version and pins it on `flow_executions`.
   * Omitted: existing live-TS `FlowRegistry` path is unchanged.
   */
  compiledRegistry?: CompiledFlowRegistry;
  /** Stage 4 approval service — required for `approval-outcome` steps. */
  approvals?: ApprovalService;
}

export interface FlowSpineDispatchConfig {
  db: PostgresJsDatabase;
  resolver: DataPlaneResolver;
  /** Schema holding tenant durable tables. Default `core_plumbus`. */
  coreSchema?: string;
}

interface FlowExecutionRow {
  id: string;
  flowName: string;
  domain: string;
  status: string;
  input: unknown;
  state: unknown;
  currentStep: string | null;
  stepHistory: unknown;
  retryCount: number;
  lastError: string | null;
  waitingForEvent: string | null;
  wakeAt: Date | null;
  actor: string;
  tenantId: string | null;
  authSnapshotJson: unknown;
  correlationId: string | null;
  triggerEventId: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  definitionVersion: string | null;
  definitionDigest: string | null;
}

/** Type-safe partial update payload for flow executions. */
/** Step auth from stored snapshot; falls back to worker auth for legacy rows. */
function resolveFlowStepAuth(row: FlowExecutionRow, workerAuth: AuthContext): AuthContext {
  const snapshot = row.authSnapshotJson as AuthContext | null | undefined;
  if (snapshot) {
    return {
      ...snapshot,
      userId: row.actor ?? snapshot.userId,
      tenantId: row.tenantId ?? snapshot.tenantId,
    };
  }
  return {
    ...workerAuth,
    tenantId: row.tenantId ?? workerAuth.tenantId,
    userId: row.actor ?? workerAuth.userId,
  };
}

interface FlowExecutionUpdate {
  status?: string;
  input?: unknown;
  state?: unknown;
  currentStep?: string | null;
  stepHistory?: StepHistoryEntry[];
  retryCount?: number;
  lastError?: string | null;
  waitingForEvent?: string | null;
  wakeAt?: Date | null;
  completedAt?: Date | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: Date | null;
}

/**
 * Generate a deterministic-ish worker id for the current process.
 */
export function generateWorkerId(): string {
  return `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

/**
 * Creates the flow execution engine that manages flow lifecycle:
 * start, run steps, handle wait/resume, and persist state.
 *
 * Supports lease-based claiming to prevent duplicate step execution
 * across multiple workers sharing the same database.
 */
export function createFlowEngine(config: FlowEngineConfig) {
  const { db, registry, audit, onFlowError, createEventService } = config;
  const compiledRegistry = config.compiledRegistry;
  const approvals = config.approvals;
  const stepDeps: StepExecutorDeps = {
    ...config.stepDeps,
    findApprovalForExecution:
      config.stepDeps.findApprovalForExecution ??
      (approvals ? (executionId) => approvals.findByExecutionId(executionId) : undefined),
  };
  const workerId = config.workerId ?? generateWorkerId();
  const leaseDurationMs = config.flowLeaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  const heartbeatIntervalMs = config.flowHeartbeatIntervalMs ?? Math.floor(leaseDurationMs / 3);
  const claimBatchSize = config.flowClaimBatchSize ?? DEFAULT_CLAIM_BATCH_SIZE;
  const logger = config.logger;
  const onFlowStepEnqueue = config.onFlowStepEnqueue;
  const spineDispatch = config.spineDispatch;
  const durableSchema = spineDispatch?.coreSchema ?? FRAMEWORK_SCHEMA;
  const executionStores = new Map<string, PostgresJsDatabase>();
  const claimedHints = new Map<string, OpaqueDispatchRecord>();
  const executionPins = new Map<
    string,
    { flowDefinitionId: string; definitionVersion: string; definitionDigest?: string }
  >();

  function restorePinFromRow(row: FlowExecutionRow): void {
    if (executionPins.has(row.id)) return;
    if (!row.definitionVersion) return;
    executionPins.set(row.id, {
      flowDefinitionId: flowDefinitionId({ domain: row.domain, name: row.flowName }),
      definitionVersion: row.definitionVersion,
      definitionDigest: row.definitionDigest ?? undefined,
    });
  }

  function resolveCompiledForStart(flow: FlowDefinition) {
    if (!compiledRegistry) return undefined;
    const id = flowDefinitionId(flow);
    const compiled = compiledRegistry.getLatest(id);
    if (!compiled) {
      throw new PlumbusError(ErrorCode.NotFound, `compiled definition required for "${id}"`, {
        reason: 'compiled-definition-required',
      });
    }
    return compiled;
  }

  function resolveExecutionFlow(executionId: string, flowName: string): FlowDefinition {
    const authoring = registry.get(flowName);
    if (!authoring) {
      throw new Error(`Flow "${flowName}" is not registered`);
    }
    if (!compiledRegistry) return authoring;
    const pin = executionPins.get(executionId);
    if (!pin) {
      throw new PlumbusError(
        ErrorCode.NotFound,
        `Flow "${flowName}" has no pinned compiled definition`,
        { reason: 'compiled-definition-missing', executionId },
      );
    }
    const compiled = compiledRegistry.get(pin.flowDefinitionId, pin.definitionVersion);
    if (!compiled) {
      throw new PlumbusError(
        ErrorCode.NotFound,
        `compiled definition "${pin.flowDefinitionId}@${pin.definitionVersion}" is not in the registry`,
        { reason: 'compiled-definition-missing' },
      );
    }
    if (pin.definitionDigest && compiled.definitionDigest !== pin.definitionDigest) {
      throw new PlumbusError(
        ErrorCode.Conflict,
        `compiled definition digest mismatch for "${pin.flowDefinitionId}@${pin.definitionVersion}"`,
        { reason: 'compiled-definition-digest-mismatch' },
      );
    }
    return hydrateCompiledFlow(compiled, authoring);
  }

  function storeFor(executionId: string): PostgresJsDatabase {
    return executionStores.get(executionId) ?? db;
  }
  const onFlowDelayedSchedule = config.onFlowDelayedSchedule;

  async function maybeEnqueueFlowStep(
    executionId: string,
    correlationId?: string | null,
  ): Promise<void> {
    if (onFlowStepEnqueue) {
      await onFlowStepEnqueue(executionId, correlationId ?? executionId);
    }
  }

  /**
   * AbortControllers for currently-executing steps in THIS engine instance,
   * keyed by executionId. `cancel()` uses this to abort the running step
   * synchronously when the cancel request arrives in the same process as
   * the worker. Cross-process cancels still converge via the next heartbeat
   * (which now also fails when status != 'running').
   */
  const activeStepAborts = new Map<string, AbortController>();

  /**
   * Start a new flow execution.
   */
  async function start(
    flowName: string,
    input: unknown,
    auth: AuthContext,
    opts?: { correlationId?: string; triggerEventId?: string; executionId?: string },
  ): Promise<FlowExecution> {
    const flow = registry.get(flowName);
    if (!flow) {
      throw new Error(`Flow "${flowName}" is not registered`);
    }

    // Validate input
    const parseResult = flow.input.safeParse(input);
    if (!parseResult.success) {
      throw new Error(`Flow "${flowName}": invalid input — ${parseResult.error.message}`);
    }

    const executionId = opts?.executionId ?? randomUUID();
    const compiled = resolveCompiledForStart(flow);
    const executionFlow = compiled ? hydrateCompiledFlow(compiled, flow) : flow;
    const definitionVersion = compiled?.definitionVersion ?? '0.0.0';
    if (compiled) {
      executionPins.set(executionId, {
        flowDefinitionId: compiled.flowDefinitionId,
        definitionVersion: compiled.definitionVersion,
        definitionDigest: compiled.definitionDigest,
      });
    }
    let initialState: unknown = flow.state
      ? (() => {
          const parsed = flow.state.safeParse({});
          return parsed.success ? parsed.data : {};
        })()
      : null;
    if (flow.budget) {
      initialState = writeExecutionBudget(
        initialState,
        createExecutionBudgetLedger({
          executionId,
          profileId: flow.budget.profileId,
          allocated: flow.budget.allocated,
          unitId: flow.budget.unitId,
          dimensionId: flow.budget.dimensionId,
        }),
      );
    }

    let writeDb = db;
    if (spineDispatch) {
      if (!auth.tenantId) {
        throw new PlumbusError(
          ErrorCode.Forbidden,
          'spine dispatch requires a tenant reference on flow start',
          { reason: 'untenanted-flow-start' },
        );
      }
      const handle = await spineDispatch.resolver.resolve(auth.tenantId);
      writeDb = handle.db;
      executionStores.set(executionId, writeDb);
    }

    await writeDb.insert(flowExecutionsTable).values({
      id: executionId,
      flowName,
      domain: flow.domain,
      status: FlowStatus.Created,
      input: parseResult.data as Record<string, unknown>,
      state: initialState as Record<string, unknown> | null,
      currentStep: executionFlow.steps[0]?.name ?? null,
      stepHistory: [],
      actor: auth.userId ?? 'system',
      tenantId: auth.tenantId ?? null,
      authSnapshotJson: auth,
      correlationId: opts?.correlationId ?? null,
      triggerEventId: opts?.triggerEventId ?? null,
      definitionVersion: compiled?.definitionVersion ?? null,
      definitionDigest: compiled?.definitionDigest ?? null,
    } satisfies typeof flowExecutionsTable.$inferInsert);

    if (audit) {
      await audit.record(`flow.started.${flowName}`, {
        executionId,
        flowName,
        actor: auth.userId,
        tenantId: auth.tenantId,
        outcome: 'success',
      });
    }

    await maybeEnqueueFlowStep(executionId, opts?.correlationId);

    if (spineDispatch && auth.tenantId) {
      const nowIso = new Date().toISOString();
      const firstStepId = executionFlow.steps[0]?.name ?? 'terminal';
      const accepted = await persistAcceptanceOnDb(
        writeDb,
        {
          executionId,
          tenantRef: auth.tenantId,
          definitionId: flowName,
          definitionVersion,
          firstStepId,
          correlationId: opts?.correlationId ?? executionId,
          nowIso,
        },
        durableSchema,
      );
      await publishOutboxToSpine(
        writeDb,
        spineDispatch.db,
        accepted.outbox,
        `disp:${executionId}:1`,
        nowIso,
        durableSchema,
      );
    }

    return {
      id: executionId,
      flowName,
      status: FlowStatus.Created,
    };
  }

  /**
   * Atomically claim up to `batchSize` runnable flow executions.
   * Uses FOR UPDATE SKIP LOCKED so concurrent workers each get different rows.
   * Also reclaims rows whose lease has expired (crash recovery).
   */
  async function claimNextFromSpine(batchSize?: number): Promise<FlowExecutionRow[]> {
    if (!spineDispatch) return [];
    const hints = await claimSpineDispatch(spineDispatch.db, {
      workerId,
      leaseDurationMs,
      limit: batchSize ?? claimBatchSize,
    });
    const rows: FlowExecutionRow[] = [];
    for (const hint of hints) {
      try {
        const handle = await spineDispatch.resolver.resolve(hint.tenantRouteId);
        const tenantState = await loadExecutionState(handle.db, hint.executionId, durableSchema);
        if (
          !tenantState ||
          tenantState.terminal ||
          tenantState.revision !== hint.expectedRevision ||
          tenantState.tenantEpoch !== hint.tenantEpoch
        ) {
          await ackSpineDispatch(spineDispatch.db, hint.dispatchId);
          continue;
        }
        const execRows = await handle.db
          .select()
          .from(flowExecutionsTable)
          .where(eq(flowExecutionsTable.id, hint.executionId))
          .limit(1);
        const row = execRows[0] as FlowExecutionRow | undefined;
        if (!row) {
          await ackSpineDispatch(spineDispatch.db, hint.dispatchId);
          continue;
        }
        executionStores.set(hint.executionId, handle.db);
        claimedHints.set(hint.executionId, hint);
        await handle.db
          .update(flowExecutionsTable)
          .set({
            status: FlowStatus.Running,
            leaseOwner: workerId,
            leaseExpiresAt: new Date(Date.now() + leaseDurationMs),
            updatedAt: new Date(),
          })
          .where(eq(flowExecutionsTable.id, hint.executionId));
        rows.push({
          ...row,
          status: FlowStatus.Running,
          leaseOwner: workerId,
        });
      } catch (error) {
        logger?.error('spine claim failed closed for one dispatch', {
          dispatchId: hint.dispatchId,
          executionId: hint.executionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return rows;
  }

  async function claimNext(batchSize?: number): Promise<FlowExecutionRow[]> {
    if (spineDispatch) {
      return claimNextFromSpine(batchSize);
    }
    const limit = batchSize ?? claimBatchSize;
    const leaseDurationInterval = `${leaseDurationMs} milliseconds`;

    const result = await db.execute<Record<string, unknown>>(sql`
      UPDATE flow_executions
      SET status = ${FlowStatus.Running},
          lease_owner = ${workerId},
          lease_expires_at = now() + ${leaseDurationInterval}::interval,
          updated_at = now()
      WHERE id IN (
        SELECT id
        FROM flow_executions
        WHERE
             status = ${FlowStatus.Created}
          OR (status = ${FlowStatus.Running} AND lease_expires_at < now())
          OR (status = ${FlowStatus.Waiting} AND waiting_for_event IS NULL AND wake_at <= now())
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      RETURNING *
    `);

    const rows = result as unknown as FlowExecutionRow[];
    for (const row of rows) {
      if (audit) {
        const wasExpired = row.status === FlowStatus.Running;
        if (wasExpired) {
          await audit.record('flow.lease.expired', {
            executionId: row.id,
            flowName: row.flowName,
            workerId,
            previousOwner: row.leaseOwner,
            step: row.currentStep,
          });
        }
        await audit.record('flow.lease.claimed', {
          executionId: row.id,
          flowName: row.flowName,
          workerId,
          step: row.currentStep,
        });
      }
    }

    return rows;
  }

  /**
   * Claim a specific execution by ID (used by flow step queue consumer).
   * Returns the row when claimed, undefined when not runnable or already leased.
   */
  async function claimExecution(executionId: string): Promise<FlowExecutionRow | undefined> {
    const leaseDurationInterval = `${leaseDurationMs} milliseconds`;

    const result = await db.execute<Record<string, unknown>>(sql`
      UPDATE flow_executions
      SET status = ${FlowStatus.Running},
          lease_owner = ${workerId},
          lease_expires_at = now() + ${leaseDurationInterval}::interval,
          updated_at = now()
      WHERE id = ${executionId}
        AND (
             status = ${FlowStatus.Created}
          OR (status = ${FlowStatus.Running} AND lease_expires_at < now())
          OR (status = ${FlowStatus.Waiting} AND waiting_for_event IS NULL AND wake_at <= now())
        )
      RETURNING *
    `);

    const rows = result as unknown as FlowExecutionRow[];
    const row = rows[0];
    if (row && audit) {
      await audit.record('flow.lease.claimed', {
        executionId: row.id,
        flowName: row.flowName,
        workerId,
        step: row.currentStep,
        source: 'claimExecution',
      });
    }
    return row;
  }

  /**
   * Extend the lease for a flow execution.
   * Returns true if the lease was extended, false if the lease was lost.
   *
   * The WHERE clause also requires `status = 'running'`. If another actor
   * (e.g. `cancel()`) has flipped the status to `cancelled`/`failed`, the
   * UPDATE matches 0 rows and we take the same "lease lost" path — which
   * the heartbeat uses to abort the per-step AbortController so the running
   * capability can cooperatively stop its in-flight AI / HTTP work.
   */
  async function extendLease(executionId: string): Promise<boolean> {
    const leaseDurationInterval = `${leaseDurationMs} milliseconds`;
    const result = await storeFor(executionId)
      .update(flowExecutionsTable)
      .set({
        leaseExpiresAt: sql`now() + ${leaseDurationInterval}::interval`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(flowExecutionsTable.id, executionId),
          eq(flowExecutionsTable.leaseOwner, workerId),
          eq(flowExecutionsTable.status, FlowStatus.Running),
        ),
      );
    const rowsAffected = getRowsAffected(result);
    if (rowsAffected === 0 && logger) {
      // D1 diagnostic: the heartbeat's status+owner guard didn't match, which
      // means something mutated the row out from under us (status flipped by
      // cancel/complete/failure, or a different worker stole the lease). Read
      // the row back and log its actual shape plus our own identity so we can
      // tell at a glance which dimension diverged. Best-effort: a failure
      // here must not break the heartbeat.
      try {
        const rows = await storeFor(executionId)
          .select({
            status: flowExecutionsTable.status,
            leaseOwner: flowExecutionsTable.leaseOwner,
            leaseExpiresAt: flowExecutionsTable.leaseExpiresAt,
            updatedAt: flowExecutionsTable.updatedAt,
            currentStep: flowExecutionsTable.currentStep,
          })
          .from(flowExecutionsTable)
          .where(eq(flowExecutionsTable.id, executionId))
          .limit(1);
        const row = rows[0];
        logger.warn('extendLease matched 0 rows', {
          executionId,
          expectedWorkerId: workerId,
          expectedStatus: FlowStatus.Running,
          actual: row
            ? {
                status: row.status,
                leaseOwner: row.leaseOwner,
                leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
                updatedAt: row.updatedAt?.toISOString() ?? null,
                currentStep: row.currentStep,
              }
            : null,
          nowMs: Date.now(),
        });
      } catch (diagErr) {
        logger.warn('extendLease diagnostic SELECT failed', {
          executionId,
          error: diagErr instanceof Error ? diagErr.message : String(diagErr),
        });
      }
    }
    return rowsAffected > 0;
  }

  /**
   * Run the next step(s) for a flow execution.
   * This is designed to be called by a worker process.
   * The execution must have been claimed by this worker (via claimNext) first.
   */
  async function runNext(executionId: string, ctx: ExecutionContext): Promise<FlowExecution> {
    const result = await runNextUnsynced(executionId, ctx);
    await syncSpineAfterRun(executionId, result);
    return result;
  }

  async function runNextUnsynced(
    executionId: string,
    ctx: ExecutionContext,
  ): Promise<FlowExecution> {
    const rows = await storeFor(executionId)
      .select()
      .from(flowExecutionsTable)
      .where(eq(flowExecutionsTable.id, executionId))
      .limit(1);

    const row = rows[0] as FlowExecutionRow | undefined;
    if (!row) {
      throw new Error(`Flow execution "${executionId}" not found`);
    }

    if (isTerminal(row.status as FlowStatus)) {
      return { id: row.id, flowName: row.flowName, status: row.status };
    }

    restorePinFromRow(row);
    const flow = resolveExecutionFlow(executionId, row.flowName);

    // Do not auto-run event waits, and do not run delayed waits until due.
    if (row.status === FlowStatus.Waiting && row.waitingForEvent) {
      return { id: row.id, flowName: row.flowName, status: FlowStatus.Waiting };
    }
    if (row.status === FlowStatus.Waiting && row.wakeAt && row.wakeAt.getTime() > Date.now()) {
      return { id: row.id, flowName: row.flowName, status: FlowStatus.Waiting };
    }

    // Transition to running (only if not already claimed via claimNext)
    if (row.status === FlowStatus.Created || row.status === FlowStatus.Waiting) {
      assertTransition(row.status as FlowStatus, FlowStatus.Running);
      await guardedUpdate(executionId, {
        status: FlowStatus.Running,
        waitingForEvent: null,
        wakeAt: null,
        leaseOwner: workerId,
        leaseExpiresAt: new Date(Date.now() + leaseDurationMs),
      });
    }

    // Find current step
    const currentStepName = row.currentStep;
    if (!currentStepName) {
      // No more steps — complete the flow
      await completeFlow(executionId, row.flowName);
      return { id: executionId, flowName: row.flowName, status: FlowStatus.Completed };
    }

    const step = flow.steps.find((s) => s.name === currentStepName);
    if (!step) {
      await failFlow(
        executionId,
        row.flowName,
        `Step "${currentStepName}" not found in flow definition`,
        row,
      );
      return { id: executionId, flowName: row.flowName, status: FlowStatus.Failed };
    }

    if (step.type === FlowStepType.Capability) {
      const charged = consumeExecutionBudget(row.state, 1);
      if (charged) {
        row.state = charged.state;
        if (charged.exhausted) {
          const history = Array.isArray(row.stepHistory)
            ? ([...row.stepHistory] as StepHistoryEntry[])
            : [];
          return handleStepFailure(executionId, row, flow, history, BUDGET_EXHAUSTED);
        }
        await guardedUpdate(executionId, { state: charged.state });
      }
    }

    // Build flow-scoped context from stored auth snapshot (not worker systemAuth roles)
    const flowAuth = resolveFlowStepAuth(row, ctx.auth);
    const flowData = config.createDataService ? config.createDataService(flowAuth) : ctx.data;
    const flowEvents = createEventService ? createEventService(flowAuth) : ctx.events;

    // Create a heartbeat function for manual use by step handlers
    const heartbeatFn = async (): Promise<void> => {
      const extended = await extendLease(executionId);
      if (!extended) {
        throw new LeaseLostError(
          `Lease lost for flow execution "${executionId}" (worker: ${workerId})`,
          { executionId, workerId, step: currentStepName },
        );
      }
    };

    // Per-step AbortController: aborted when the lease is lost (either
    // because another worker claimed the execution OR because cancel() flipped
    // the status out of 'running'). Capability handlers can subscribe via
    // `ctx.signal` and pass it to AI/HTTP calls to stop cooperatively rather
    // than continuing to burn budget as a zombie.
    const stepAc = new AbortController();
    activeStepAborts.set(executionId, stepAc);

    // Auto-thread `signal` into AI calls so capability authors don't have to
    // pass it explicitly. An explicit `signal` in the call overrides the
    // step default. See AIService type for the per-method signal parameter.
    const flowAi = wrapAiWithDefaultSignal(ctx.ai, stepAc.signal);

    const flowCtx: ExecutionContext = {
      ...ctx,
      auth: flowAuth,
      data: flowData,
      events: flowEvents,
      ai: flowAi,
      state: row.state,
      step: currentStepName,
      flowId: executionId,
      workerId,
      signal: stepAc.signal,
      flows: {
        ...ctx.flows,
        // `ctx.flows` on the worker baseCtx is bound to systemAuth (no
        // tenantId). If a capability inside this step calls
        // `ctx.flows.start(innerFlow, ...)`, the inner flow's stored
        // `actor`/`tenantId` would inherit systemAuth — and any tenantScoped
        // capability inside the inner flow would then reject with "Tenant
        // context required". Rebind `start` to use the current flowAuth so
        // nested flows inherit the calling flow's identity and tenant.
        start: (flowName: string, input: unknown) =>
          start(flowName, input, flowAuth, {
            correlationId: row.correlationId ?? undefined,
            triggerEventId: executionId,
          }),
        heartbeat: heartbeatFn,
      },
    };

    // Start automatic heartbeat timer
    let leaseLost = false;
    let heartbeatTickCount = 0;
    const heartbeatStartedAtMs = Date.now();
    const heartbeatTimer = setInterval(async () => {
      heartbeatTickCount += 1;
      const tick = heartbeatTickCount;
      const firedAtMs = Date.now();
      const expectedFireAtMs = heartbeatStartedAtMs + tick * heartbeatIntervalMs;
      const driftMs = firedAtMs - expectedFireAtMs;
      // D2 diagnostic: emit one log line per heartbeat tick so we can see
      // whether ticks are firing on schedule (event-loop starvation shows up
      // here as large positive `driftMs`). First tick is logged at `info`
      // because that's typically enough for a post-mortem; subsequent ticks
      // at `debug` to avoid log spam for long-running flows.
      if (logger) {
        const payload = {
          executionId,
          workerId,
          step: currentStepName,
          tick,
          firedAtMs,
          expectedFireAtMs,
          driftMs,
          heartbeatIntervalMs,
        };
        if (tick === 1) {
          logger.info('flow.heartbeat.tick', payload);
        } else {
          logger.debug('flow.heartbeat.tick', payload);
        }
      }
      let extended: boolean;
      try {
        extended = await extendLease(executionId);
      } catch (err) {
        // Transient infrastructure failure (DB connection blip, pool
        // contention under load): the row was not touched, so the lease is
        // most likely still valid and the next tick simply retries. This
        // must NOT take the lease-lost path (the step is still healthy) and
        // must NOT escape the interval callback — an async setInterval
        // callback has no awaiter, so a throw here surfaces as a
        // process-level unhandled rejection.
        if (logger) {
          logger.warn('flow.heartbeat.extend_failed', {
            executionId,
            workerId,
            step: currentStepName,
            tick,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      try {
        if (extended) {
          if (audit) {
            await audit.record('flow.lease.extended', {
              executionId,
              flowName: row.flowName,
              workerId,
              step: currentStepName,
            });
          }
        } else {
          leaseLost = true;
          if (!stepAc.signal.aborted) {
            stepAc.abort(
              new LeaseLostError(
                `Lease lost for flow execution "${executionId}" (worker: ${workerId})`,
                { executionId, workerId, step: currentStepName },
              ),
            );
          }
          if (audit) {
            await audit.record('flow.lease.lost', {
              executionId,
              flowName: row.flowName,
              workerId,
              step: currentStepName,
            });
          }
        }
      } catch (err) {
        // Audit sinks are best-effort; never let their failures escape the
        // interval callback. The abort above has already happened when the
        // lease was genuinely lost.
        if (logger) {
          logger.warn('flow.heartbeat.audit_failed', {
            executionId,
            workerId,
            step: currentStepName,
            tick,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }, heartbeatIntervalMs);

    // Execute the step
    let result: StepResult;
    const startedAt = new Date();
    try {
      result = await executeStep(step, flowCtx, row.input, row.state, stepDeps);
    } finally {
      clearInterval(heartbeatTimer);
      // Abort any stray detached tasks once the step settles so they observe
      // the abort promptly. If already aborted (lease loss), this is a no-op.
      if (!stepAc.signal.aborted) {
        stepAc.abort();
      }
      if (activeStepAborts.get(executionId) === stepAc) {
        activeStepAborts.delete(executionId);
      }
    }
    const completedAt = new Date();

    // Check if lease was lost during step execution
    if (leaseLost) {
      throw new LeaseLostError(
        `Lease lost during step "${currentStepName}" of flow execution "${executionId}"`,
        { executionId, workerId, step: currentStepName },
      );
    }

    const historyEntry = buildHistoryEntry(currentStepName, result, startedAt, completedAt);
    const history = Array.isArray(row.stepHistory) ? (row.stepHistory as StepHistoryEntry[]) : [];
    history.push(historyEntry);
    const nextState = mergeExecutionState(row.state, result.data);

    if (audit) {
      await audit.record(`flow.step.${result.status}.${currentStepName}`, {
        executionId,
        flowName: row.flowName,
        step: currentStepName,
        status: result.status,
        error: result.error,
      });
    }

    // Handle result
    if (result.status === StepStatus.Failed) {
      return handleStepFailure(executionId, row, flow, history, result.error);
    }

    // Wait step — pause the flow
    if (result.waitEvent) {
      const ok = await guardedUpdate(executionId, {
        status: FlowStatus.Waiting,
        state: nextState,
        stepHistory: history,
        currentStep: currentStepName, // stay on current step until resumed
        waitingForEvent: result.waitEvent,
        wakeAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      if (!ok) {
        throw new LeaseLostError(`Lease lost committing wait for flow execution "${executionId}"`, {
          executionId,
          workerId,
          step: currentStepName,
        });
      }
      return { id: executionId, flowName: row.flowName, status: FlowStatus.Waiting };
    }

    // Delay step — schedule next step after duration
    if (result.delayDuration) {
      const nextStep = getNextStepName(flow.steps, currentStepName);
      let delayMs: number;
      try {
        delayMs = parseDurationToMs(result.delayDuration, { label: 'delay' });
      } catch (err) {
        return handleStepFailure(
          executionId,
          row,
          flow,
          history,
          err instanceof Error ? err.message : String(err),
        );
      }
      const wakeAt = new Date(Date.now() + delayMs);
      await guardedUpdate(executionId, {
        status: FlowStatus.Waiting,
        state: nextState,
        stepHistory: history,
        currentStep: nextStep,
        waitingForEvent: null,
        wakeAt,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      if (onFlowDelayedSchedule) {
        await onFlowDelayedSchedule(executionId, wakeAt, row.correlationId ?? executionId);
      }
      return { id: executionId, flowName: row.flowName, status: FlowStatus.Waiting };
    }

    // Parallel step — execute all branches concurrently, then advance
    if (result.parallelBranches) {
      let parallelState = nextState;
      const branchSteps = result.parallelBranches
        .map((branchName) => flow.steps.find((s) => s.name === branchName))
        .filter((s): s is FlowStep => s != null);

      const branchResults = await Promise.allSettled(
        branchSteps.map(async (branchStep) => {
          const branchStart = new Date();
          const branchResult = await executeStep(
            branchStep,
            flowCtx,
            row.input,
            row.state,
            stepDeps,
          );
          const branchEnd = new Date();
          return { branchStep, branchResult, branchStart, branchEnd };
        }),
      );

      // Merge branch history entries after all branches complete (avoids concurrent mutation)
      for (const settled of branchResults) {
        if (settled.status === 'fulfilled') {
          const { branchStep, branchResult, branchStart, branchEnd } = settled.value;
          history.push(buildHistoryEntry(branchStep.name, branchResult, branchStart, branchEnd));
          parallelState = mergeExecutionState(parallelState, branchResult.data);
        }
      }

      const anyFailed = branchResults.some(
        (r) =>
          r.status === 'rejected' ||
          (r.status === 'fulfilled' && r.value.branchResult.status === StepStatus.Failed),
      );

      if (anyFailed) {
        return handleStepFailure(
          executionId,
          row,
          flow,
          history,
          'One or more parallel branches failed',
        );
      }

      const nextStep = getNextStepName(flow.steps, currentStepName);
      await guardedUpdate(executionId, {
        state: parallelState,
        stepHistory: history,
        currentStep: nextStep,
      });
      if (!nextStep) {
        await completeFlow(executionId, row.flowName);
        return { id: executionId, flowName: row.flowName, status: FlowStatus.Completed };
      }
      return { id: executionId, flowName: row.flowName, status: FlowStatus.Running };
    }

    // Conditional step — jump to the chosen branch
    if (result.nextStep) {
      await guardedUpdate(executionId, {
        state: nextState,
        stepHistory: history,
        currentStep: result.nextStep,
      });
      return { id: executionId, flowName: row.flowName, status: FlowStatus.Running };
    }

    // Normal completion — advance to next step
    const nextStep = getNextStepName(flow.steps, currentStepName);
    if (!nextStep) {
      await guardedUpdate(executionId, { state: nextState, stepHistory: history });
      await completeFlow(executionId, row.flowName);
      return { id: executionId, flowName: row.flowName, status: FlowStatus.Completed };
    }

    await guardedUpdate(executionId, {
      state: nextState,
      stepHistory: history,
      currentStep: nextStep,
    });
    return { id: executionId, flowName: row.flowName, status: FlowStatus.Running };
  }

  /**
   * Resume a waiting flow (e.g., after an event arrives or approval granted).
   */
  async function resume(executionId: string, signal?: unknown): Promise<void> {
    const rows = await storeFor(executionId)
      .select()
      .from(flowExecutionsTable)
      .where(eq(flowExecutionsTable.id, executionId))
      .limit(1);

    const row = rows[0] as FlowExecutionRow | undefined;
    if (!row) throw new Error(`Flow execution "${executionId}" not found`);

    if (row.status !== FlowStatus.Waiting) {
      throw new Error(`Cannot resume flow "${executionId}" — current status is "${row.status}"`);
    }

    restorePinFromRow(row);
    const flow = resolveExecutionFlow(executionId, row.flowName);

    // Advance past the wait/delay step — set to created so claimNext picks it up
    const nextStep = getNextStepName(flow.steps, row.currentStep ?? '');

    await updateExecution(executionId, {
      status: FlowStatus.Created,
      currentStep: nextStep,
      state: signal !== undefined ? signal : row.state,
      waitingForEvent: null,
      wakeAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    });

    await maybeEnqueueFlowStep(executionId, row.correlationId);
  }

  /**
   * Resume all flows waiting on a specific event type.
   * Uses FOR UPDATE SKIP LOCKED to prevent duplicate resumes across workers.
   * Returns execution IDs resumed.
   */
  async function resumeWaitingByEvent(eventType: string, signal?: unknown): Promise<string[]> {
    const result = await db.execute<{ id: string }>(sql`
      UPDATE flow_executions
      SET status = ${FlowStatus.Created},
          waiting_for_event = NULL,
          wake_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = now()
      WHERE id IN (
        SELECT id
        FROM flow_executions
        WHERE status = ${FlowStatus.Waiting}
          AND waiting_for_event = ${eventType}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `);

    const rows = result as unknown as { id: string }[];

    // If a signal was provided, update state for each resumed execution
    if (signal !== undefined) {
      for (const row of rows) {
        await updateExecution(row.id, { state: signal });
      }
    }

    for (const row of rows) {
      await maybeEnqueueFlowStep(row.id);
    }

    return rows.map((row) => row.id);
  }

  /**
   * Returns execution IDs that should be processed now.
   */
  async function listRunnable(limit = 50): Promise<string[]> {
    const now = new Date();
    const rows = await db
      .select({ id: flowExecutionsTable.id })
      .from(flowExecutionsTable)
      .where(
        or(
          inArray(flowExecutionsTable.status, [FlowStatus.Created, FlowStatus.Running]),
          and(
            eq(flowExecutionsTable.status, FlowStatus.Waiting),
            isNull(flowExecutionsTable.waitingForEvent),
            lte(flowExecutionsTable.wakeAt, now),
          ),
        ),
      )
      .limit(limit);

    return rows.map((row) => row.id);
  }

  /**
   * Cancel a running or waiting flow. Completed steps with `compensate`
   * run their compensation capability first (recovery CompensationState v1).
   */
  async function cancel(
    executionId: string,
    opts?: { actor?: string; skipCompensation?: boolean },
  ): Promise<void> {
    const rows = await storeFor(executionId)
      .select()
      .from(flowExecutionsTable)
      .where(eq(flowExecutionsTable.id, executionId))
      .limit(1);

    const row = rows[0] as FlowExecutionRow | undefined;
    if (!row) throw new Error(`Flow execution "${executionId}" not found`);

    if (isTerminal(row.status as FlowStatus)) {
      throw new Error(
        `Cannot cancel flow "${executionId}" — already in terminal state "${row.status}"`,
      );
    }

    restorePinFromRow(row);
    const flow = resolveExecutionFlow(executionId, row.flowName);
    const history = Array.isArray(row.stepHistory)
      ? ([...row.stepHistory] as StepHistoryEntry[])
      : [];

    // Abort the in-flight step before compensation so it cannot commit.
    const activeAc = activeStepAborts.get(executionId);
    if (activeAc && !activeAc.signal.aborted) {
      activeAc.abort(new FlowCancelledError(executionId));
    }

    if (!opts?.skipCompensation) {
      await runCompensations(executionId, row, flow, history);
    }

    assertTransition(row.status as FlowStatus, FlowStatus.Cancelled);
    await updateExecution(executionId, {
      status: FlowStatus.Cancelled,
      stepHistory: history,
      completedAt: new Date(),
    });

    if (audit) {
      await audit.record(`flow.cancelled.${row.flowName}`, {
        executionId,
        flowName: row.flowName,
        actor: opts?.actor ?? row.actor,
        compensated: history.some((entry) => entry.step.startsWith('compensate:')),
      });
    }
  }

  async function terminate(executionId: string, opts?: { actor?: string }): Promise<void> {
    return cancel(executionId, { actor: opts?.actor, skipCompensation: true });
  }

  async function runCompensations(
    executionId: string,
    row: FlowExecutionRow,
    flow: FlowDefinition,
    history: StepHistoryEntry[],
  ): Promise<void> {
    const completed = new Set(
      history.filter((entry) => entry.status === StepStatus.Completed).map((entry) => entry.step),
    );
    const compensable = [...flow.steps].reverse().filter((step): step is CapabilityStep => {
      return (
        step.type === FlowStepType.Capability &&
        typeof step.compensate === 'string' &&
        step.compensate.length > 0 &&
        completed.has(step.name)
      );
    });
    if (compensable.length === 0) return;

    const flowAuth = resolveFlowStepAuth(row, {
      userId: row.actor,
      roles: [AuthRole.System],
      scopes: [],
      provider: 'flow-compensation',
      tenantId: row.tenantId ?? undefined,
    });
    const ctx = {
      auth: flowAuth,
      data: config.createDataService ? config.createDataService(flowAuth) : {},
      events: createEventService
        ? createEventService(flowAuth)
        : { emit: async () => undefined, emitMany: async () => undefined },
      flows: {
        start: async () => ({
          id: executionId,
          flowName: row.flowName,
          status: FlowStatus.Cancelled,
        }),
        resume: async () => undefined,
        cancel: async () => undefined,
        status: async () => ({ id: executionId, flowName: row.flowName, status: row.status }),
      },
      ai: {},
      audit: audit ?? { record: async () => undefined },
      errors: {},
      logger: logger ?? { debug() {}, info() {}, warn() {}, error() {} },
      time: { now: () => new Date() },
      config: {},
      security: {},
      translations: { locale: 'en', t: (key: string) => key },
      state: row.state,
      flowId: executionId,
    } as unknown as ExecutionContext;

    for (const step of compensable) {
      const startedAt = new Date();
      const result = await stepDeps.executeCapability(step.compensate!, ctx, row.input);
      const completedAt = new Date();
      history.push(
        buildHistoryEntry(
          `compensate:${step.name}`,
          {
            status: result.success ? StepStatus.Completed : StepStatus.Failed,
            error: result.success
              ? undefined
              : typeof result.error === 'object' && result.error !== null
                ? JSON.stringify(result.error)
                : String(result.error),
          },
          startedAt,
          completedAt,
        ),
      );
      if (audit) {
        await audit.record(`flow.compensated.${step.name}`, {
          executionId,
          flowName: row.flowName,
          sourceStep: step.name,
          compensation: step.compensate,
          outcome: result.success ? 'succeeded' : 'failed',
        });
      }
    }
  }

  /**
   * Get the current status of a flow execution.
   */
  async function status(executionId: string): Promise<FlowExecution> {
    const rows = await storeFor(executionId)
      .select()
      .from(flowExecutionsTable)
      .where(eq(flowExecutionsTable.id, executionId))
      .limit(1);

    const row = rows[0] as FlowExecutionRow | undefined;
    if (!row) throw new Error(`Flow execution "${executionId}" not found`);

    return { id: row.id, flowName: row.flowName, status: row.status };
  }

  // ── Internal helpers ──

  async function handleStepFailure(
    executionId: string,
    row: FlowExecutionRow,
    flow: FlowDefinition,
    history: StepHistoryEntry[],
    error?: string,
  ): Promise<FlowExecution> {
    const retryCount = row.retryCount + 1;
    const maxRetries = flow.retry?.attempts ?? 0;

    if (retryCount <= maxRetries) {
      // Retry: keep current step, increment counter
      await guardedUpdate(executionId, {
        stepHistory: history,
        retryCount,
        lastError: error ?? null,
      });
      return { id: executionId, flowName: row.flowName, status: FlowStatus.Running };
    }

    // Exhausted retries — fail the flow
    await failFlow(executionId, row.flowName, error, row);
    return { id: executionId, flowName: row.flowName, status: FlowStatus.Failed };
  }

  async function completeFlow(executionId: string, flowName: string): Promise<void> {
    const ok = await guardedUpdate(executionId, {
      status: FlowStatus.Completed,
      currentStep: null,
      completedAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    if (!ok) return; // Lease lost — another worker owns this execution
    if (audit) {
      await audit.record(`flow.completed.${flowName}`, { executionId, flowName });
    }
  }

  async function failFlow(
    executionId: string,
    flowName: string,
    error?: string,
    row?: FlowExecutionRow,
  ): Promise<void> {
    const ok = await guardedUpdate(executionId, {
      status: FlowStatus.Failed,
      lastError: error ?? 'Unknown error',
      completedAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    if (!ok) return; // Lease lost — another worker owns this execution
    if (audit) {
      await audit.record(`flow.failed.${flowName}`, {
        executionId,
        flowName,
        error,
      });
    }
    if (onFlowError) {
      try {
        await onFlowError({
          executionId,
          flowName,
          step: row?.currentStep ?? null,
          error: error ?? 'Unknown error',
          tenantId: row?.tenantId,
          actor: row?.actor,
          db: storeFor(executionId),
        });
      } catch {
        // Swallow — error logging must never break flow processing
      }
    }
  }

  async function updateExecution(id: string, updates: FlowExecutionUpdate): Promise<void> {
    await storeFor(id)
      .update(flowExecutionsTable)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(flowExecutionsTable.id, id));
  }

  /**
   * Finalize an execution as `failed` from the flow runner's perspective when
   * `runNext` rejects with an unhandled error (e.g. `LeaseLostError` from a
   * heartbeat). Without this, a zombie row left by a previously-crashed worker
   * would be re-claimed by `claimNext` on every poll cycle (via the
   * `status='running' AND lease_expires_at < now()` crash-recovery branch),
   * retry forever, and pile up log noise.
   *
   * The guard is `status IN ('running','created','waiting')` (a set-guard, NOT
   * a `lease_owner = workerId` check): on `LeaseLostError` the lease is by
   * definition no longer ours, and we still want to stop the loop. A
   * concurrent successful completion or an explicit `cancel()` will have
   * already moved the row to a terminal status, and the `IN (...)` clause
   * turns this call into a no-op in those races.
   *
   * Idempotent: second call on an already-finalized row is a no-op.
   */
  async function markFailedFromRunner(executionId: string, error: unknown): Promise<boolean> {
    const message =
      error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';
    const result = await storeFor(executionId)
      .update(flowExecutionsTable)
      .set({
        status: FlowStatus.Failed,
        lastError: message,
        completedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(flowExecutionsTable.id, executionId),
          inArray(flowExecutionsTable.status, [
            FlowStatus.Running,
            FlowStatus.Created,
            FlowStatus.Waiting,
          ]),
        ),
      );
    const rowsAffected = getRowsAffected(result);
    if (rowsAffected > 0 && audit) {
      await audit.record('flow.runner.finalized', {
        executionId,
        workerId,
        error: message,
      });
    }
    return rowsAffected > 0;
  }

  /**
   * Update execution with lease ownership guard.
   * Returns true if the update succeeded (we still own the lease),
   * false if the lease was lost (0 rows affected).
   */
  async function guardedUpdate(id: string, updates: FlowExecutionUpdate): Promise<boolean> {
    const result = await storeFor(id)
      .update(flowExecutionsTable)
      .set({ ...updates, updatedAt: new Date() })
      .where(and(eq(flowExecutionsTable.id, id), eq(flowExecutionsTable.leaseOwner, workerId)));
    const rowsAffected = getRowsAffected(result);
    return rowsAffected > 0;
  }

  async function syncSpineAfterRun(executionId: string, result: FlowExecution): Promise<void> {
    if (!spineDispatch) return;
    const hint = claimedHints.get(executionId);
    const tenantDb = executionStores.get(executionId);
    if (!hint || !tenantDb) return;
    const nowIso = new Date().toISOString();
    const flowRow = (
      await tenantDb
        .select({ currentStep: flowExecutionsTable.currentStep })
        .from(flowExecutionsTable)
        .where(eq(flowExecutionsTable.id, executionId))
        .limit(1)
    )[0];
    const nextStepId = flowRow?.currentStep ?? hint.stepId;
    const terminal =
      result.status === FlowStatus.Completed ||
      result.status === FlowStatus.Failed ||
      result.status === FlowStatus.Cancelled;
    const cas = await casAdvanceExecution(
      tenantDb,
      {
        executionId,
        expectedRevision: hint.expectedRevision,
        nextStatus: terminal
          ? result.status === FlowStatus.Completed
            ? 'succeeded'
            : result.status === FlowStatus.Cancelled
              ? 'cancelled'
              : 'failed'
          : 'running',
        nextStepId,
        terminal,
        nowIso,
        sideEffectKey: `${executionId}:${hint.stepId}:${hint.expectedRevision}`,
        sideEffectLabel: `${executionId}:${hint.stepId}`,
      },
      durableSchema,
    );
    await ackSpineDispatch(spineDispatch.db, hint.dispatchId);
    claimedHints.delete(executionId);
    if (cas !== 'ok' || terminal) return;
    const advanced = await loadExecutionState(tenantDb, executionId, durableSchema);
    if (!advanced || advanced.terminal || !flowRow?.currentStep) return;
    const nextStep = flowRow.currentStep;
    const outbox = await insertDispatchOutbox(tenantDb, advanced, nextStep, nowIso, durableSchema);
    await publishOutboxToSpine(
      tenantDb,
      spineDispatch.db,
      outbox,
      `disp:${executionId}:${advanced.revision}`,
      nowIso,
      durableSchema,
    );
  }

  async function applyDefinitionStrategy(
    executionId: string,
    strategy: string,
  ): Promise<{ strategy: DefinitionInFlightStrategyName; applied: true }> {
    assertSupportedDefinitionStrategy(strategy);

    const rows = await storeFor(executionId)
      .select()
      .from(flowExecutionsTable)
      .where(eq(flowExecutionsTable.id, executionId))
      .limit(1);
    const row = rows[0] as FlowExecutionRow | undefined;
    if (!row) throw new Error(`Flow execution "${executionId}" not found`);

    if (strategy === DefinitionInFlightStrategy.CompleteOnOriginal) {
      restorePinFromRow(row);
      return { strategy, applied: true };
    }

    if (!isTerminal(row.status as FlowStatus)) {
      await cancel(executionId);
    }
    await updateExecution(executionId, { lastError: DefinitionInFlightStrategy.StopAndRecover });
    return { strategy: DefinitionInFlightStrategy.StopAndRecover, applied: true };
  }

  return {
    start,
    runNext,
    resume,
    resumeWaitingByEvent,
    listRunnable,
    claimNext,
    claimExecution,
    cancel,
    terminate,
    status,
    markFailedFromRunner,
    applyDefinitionStrategy,
    get workerId() {
      return workerId;
    },
  };
}

/**
 * Wrap an AIService so that every method defaults `signal` to the flow step's
 * AbortSignal when the caller doesn't pass one explicitly. `streamGenerate`
 * is a sync function returning an AsyncIterable and is wrapped accordingly.
 */
function wrapAiWithDefaultSignal(ai: AIService, defaultSignal: AbortSignal): AIService {
  const withSignal = <T extends { signal?: AbortSignal }>(params: T): T => ({
    ...params,
    signal: params.signal ?? defaultSignal,
  });

  return {
    recordProviderCost: (entry, costContext) => ai.recordProviderCost(entry, costContext),
    checkProviderCostBudget: (config) => ai.checkProviderCostBudget(config),
    generate: (params) => ai.generate(withSignal(params)),
    generateWithUsage: ((config: Parameters<AIService['generateWithUsage']>[0]) =>
      ai.generateWithUsage(withSignal(config))) as AIService['generateWithUsage'],
    streamGenerate: (params) => ai.streamGenerate(withSignal(params)),
    extract: (params) => ai.extract(withSignal(params)),
    classify: (params) => ai.classify(withSignal(params)),
    retrieve: (params) => ai.retrieve(withSignal(params)),
  };
}

function mergeExecutionState(currentState: unknown, stepData: unknown): unknown {
  if (stepData === undefined) {
    return currentState;
  }

  if (
    currentState &&
    typeof currentState === 'object' &&
    !Array.isArray(currentState) &&
    stepData &&
    typeof stepData === 'object' &&
    !Array.isArray(stepData)
  ) {
    return {
      ...(currentState as Record<string, unknown>),
      ...(stepData as Record<string, unknown>),
    };
  }

  return stepData;
}

/**
 * Collect all step names that are branches of parallel steps.
 * These should be skipped during linear step advancement.
 */
function collectBranchNames(steps: FlowStep[]): Set<string> {
  const branches = new Set<string>();
  for (const step of steps) {
    if (step.type === 'parallel' && 'branches' in step) {
      for (const b of (step as ParallelStep).branches) branches.add(b);
    }
  }
  return branches;
}

/**
 * Get the next step name in a linear flow sequence.
 * Returns undefined if we're at the last step.
 * Skips branch steps that belong to parallel steps.
 */
function getNextStepName(steps: FlowStep[], currentStepName: string): string | undefined {
  const branchNames = collectBranchNames(steps);
  let idx = steps.findIndex((s) => s.name === currentStepName);
  if (idx === -1 || idx >= steps.length - 1) return undefined;
  idx++;
  while (idx < steps.length && branchNames.has(steps[idx]?.name ?? '')) {
    idx++;
  }
  if (idx >= steps.length) return undefined;
  return steps[idx]?.name;
}

/**
 * Compute a retry delay in milliseconds given the retry policy.
 */
export function computeRetryDelay(retryCount: number, backoff: string, baseDelayMs = 1000): number {
  if (backoff === BackoffStrategy.Exponential) {
    return baseDelayMs * 2 ** (retryCount - 1);
  }
  return baseDelayMs; // fixed
}
