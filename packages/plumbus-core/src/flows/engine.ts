import { databaseTime } from './database-clock.js';
import {
  createFlowExecutionRecord,
  flowAuthSchema,
  type FlowStartOptions,
} from './execution-record.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { deadLetterFlow } from './dead-letter.js';
import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { parseDurationToMs, resolveRetryPolicy, retryDelay } from '../config/index.js';
import { FlowCancelledError, LeaseLostError } from '../errors/index.js';
import { createStructuredLogger } from '../observability/metrics.js';
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
import { BackoffStrategy } from '../types/enums.js';
import type { FlowDefinition, FlowStep, ParallelStep } from '../types/flow.js';
import type { AuthContext } from '../types/security.js';
import type { FlowRegistry } from './registry.js';
import { flowExecutionsTable } from './schema.js';
import {
  assertTransition,
  FlowStatus,
  isTerminal,
  type StepHistoryEntry,
  StepStatus,
} from './state-machine.js';
import { buildHistoryEntry, executeStep, type StepExecutorDeps } from './step-executor.js';

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
  createContext?: (
    auth: AuthContext,
    metadata: { correlationId: string; flowId: string },
  ) => ExecutionContext;
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
   * Opt-in (default `false`): when enabled, caller-facing `ctx.flows.resume`,
   * `ctx.flows.cancel` and `ctx.flows.status` only act on executions started
   * by the same actor in the same tenant. Callers holding the `system` role
   * (worker and other internal paths) are exempt. Other callers get the same
   * "not found" error as for an unknown execution id.
   *
   * When omitted, the `PLUMBUS_FLOW_ENFORCE_OWNERSHIP=true` environment
   * variable enables it. Cross-tenant access is always rejected, regardless
   * of this option.
   */
  enforceExecutionOwnership?: boolean;
}

/**
 * Tenant scope for {@link createFlowEngine} `resumeWaitingByEvent`. Only
 * executions whose stored tenant equals `tenantId` are resumed; `null` means
 * "tenantless executions only".
 */
export interface FlowEventResumeScope {
  tenantId: string | null;
}

/** Stored owner of a flow execution, used by the caller-facing flow service. */
export interface FlowExecutionOwner {
  actor: string;
  tenantId: string | null;
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
  leaseToken: string | null;
  waitKind: string | null;
  leaseExpiresAt: Date | null;
}

/** Type-safe partial update payload for flow executions. */
/** Legacy/corrupt snapshots never inherit the worker's privileges. */
function resolveFlowStepAuth(row: FlowExecutionRow): AuthContext | null {
  const result = flowAuthSchema.safeParse(row.authSnapshotJson);
  if (!result.success) return null;
  if ((result.data.tenantId ?? null) !== row.tenantId) return null;
  if (result.data.userId != null && result.data.userId !== row.actor) return null;
  return result.data;
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
  leaseToken?: string | null;
  waitKind?: string | null;
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
  const { db, registry, stepDeps, audit, onFlowError, createEventService } = config;
  const workerId = config.workerId ?? generateWorkerId();
  const leaseDurationMs = config.flowLeaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  const heartbeatIntervalMs = config.flowHeartbeatIntervalMs ?? Math.floor(leaseDurationMs / 3);
  const claimBatchSize = config.flowClaimBatchSize ?? DEFAULT_CLAIM_BATCH_SIZE;
  const logger = config.logger;
  const onFlowStepEnqueue = config.onFlowStepEnqueue;
  const onFlowDelayedSchedule = config.onFlowDelayedSchedule;
  const enforceExecutionOwnership =
    config.enforceExecutionOwnership ?? process.env.PLUMBUS_FLOW_ENFORCE_OWNERSHIP === 'true';
  const warnedKeys = new Set<string>();

  /** Log a warning once per engine instance (security-relevant legacy paths). */
  function warnOnce(key: string, message: string, metadata?: Record<string, unknown>): void {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    (logger ?? createStructuredLogger({ component: 'flows' })).warn(message, metadata);
  }

  async function maybeEnqueueFlowStep(
    executionId: string,
    correlationId?: string | null,
  ): Promise<void> {
    if (onFlowStepEnqueue) {
      try {
        await onFlowStepEnqueue(executionId, correlationId ?? executionId);
      } catch {
        logger?.error('Flow wake publication failed; database reconciliation will recover', {
          executionId,
        });
      }
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
  const claims = new Map<string, string>();
  const claimScope = new AsyncLocalStorage<{ id: string; token: string }>();

  /**
   * Start a new flow execution.
   */
  async function start(
    flowName: string,
    input: unknown,
    auth: AuthContext,
    opts?: FlowStartOptions,
  ): Promise<FlowExecution> {
    const flow = registry.get(flowName);
    if (!flow) {
      throw new Error(`Flow "${flowName}" is not registered`);
    }

    const execution = await createFlowExecutionRecord(db, flow, input, auth, opts);
    const executionId = execution.id;

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
  async function claimNext(batchSize?: number): Promise<FlowExecutionRow[]> {
    const limit = batchSize ?? claimBatchSize;
    const leaseDurationInterval = `${leaseDurationMs} milliseconds`;

    const result = await db.execute<Record<string, unknown>>(sql`
      UPDATE flow_executions
      SET status = ${FlowStatus.Running},
          lease_owner = ${workerId},
          lease_token = gen_random_uuid(),
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
      RETURNING *, lease_token AS "leaseToken", flow_name AS "flowName", current_step AS "currentStep", lease_owner AS "leaseOwner"
    `);

    const rows = result as unknown as FlowExecutionRow[];
    for (const row of rows) {
      if (row.leaseToken) claims.set(row.id, row.leaseToken);
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
          lease_token = gen_random_uuid(),
          lease_expires_at = now() + ${leaseDurationInterval}::interval,
          updated_at = now()
      WHERE id = ${executionId}
        AND (
             status = ${FlowStatus.Created}
          OR (status = ${FlowStatus.Running} AND lease_expires_at < now())
          OR (status = ${FlowStatus.Waiting} AND waiting_for_event IS NULL AND wake_at <= now())
        )
      RETURNING *, lease_token AS "leaseToken", flow_name AS "flowName", current_step AS "currentStep", lease_owner AS "leaseOwner"
    `);

    const rows = result as unknown as FlowExecutionRow[];
    const row = rows[0];
    if (row?.leaseToken) claims.set(row.id, row.leaseToken);
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
    const result = await db
      .update(flowExecutionsTable)
      .set({
        leaseExpiresAt: sql`now() + ${leaseDurationInterval}::interval`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(flowExecutionsTable.id, executionId),
          eq(flowExecutionsTable.leaseOwner, workerId),
          eq(
            flowExecutionsTable.leaseToken,
            claimScope.getStore()?.token ?? '00000000-0000-0000-0000-000000000000',
          ),
          sql`${flowExecutionsTable.leaseExpiresAt} > now()`,
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
        const rows = await db
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
  async function runNext(
    executionId: string,
    ctx: ExecutionContext,
    leaseToken?: string,
  ): Promise<FlowExecution> {
    let token = leaseToken ?? claims.get(executionId);
    if (!token) {
      const claimed = await claimExecution(executionId);
      token = claimed?.leaseToken ?? undefined;
      if (!token) {
        const current = await status(executionId);
        if (isTerminal(current.status as FlowStatus)) return current;
        throw new LeaseLostError('Flow must be claimed before execution', { executionId });
      }
    }
    return claimScope.run({ id: executionId, token }, () => runClaimedStep(executionId, ctx));
  }

  async function runClaimedStep(
    executionId: string,
    ctx: ExecutionContext,
  ): Promise<FlowExecution> {
    const rows = await db
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

    await guardedUpdate(executionId, {});

    const flow = registry.get(row.flowName);
    if (!flow) {
      throw new Error(`Flow "${row.flowName}" is not registered`);
    }

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

    // Build flow-scoped context from stored auth snapshot (not worker systemAuth roles)
    const flowAuth = resolveFlowStepAuth(row);
    if (!flowAuth) {
      await failFlow(
        executionId,
        row.flowName,
        'Missing or invalid flow auth snapshot; restart from a verified caller context',
        row,
      );
      return { id: executionId, flowName: row.flowName, status: FlowStatus.Failed };
    }
    ctx =
      config.createContext?.(flowAuth, {
        correlationId: row.correlationId ?? executionId,
        flowId: executionId,
      }) ?? ctx;
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
    const scopedAi =
      ctx.ai.withContext?.({ tenantId: flowAuth.tenantId, actor: flowAuth.userId }) ?? ctx.ai;
    const flowAi = wrapAiWithDefaultSignal(scopedAi, stepAc.signal);

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

    try {
      // Heartbeat remains active through parallel branches and commits.
      const startedAt = new Date();
      const result = await executeStep(step, flowCtx, row.input, row.state, stepDeps);
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
        return handleStepFailure(executionId, row, flow, history, result.error, result.permanent);
      }

      // Wait step — pause the flow
      if (result.waitEvent) {
        const ok = await guardedUpdate(executionId, {
          status: FlowStatus.Waiting,
          state: nextState,
          stepHistory: history,
          currentStep: currentStepName, // stay on current step until resumed
          waitingForEvent: result.waitEvent,
          waitKind: 'event',
          retryCount: 0,
          wakeAt: null,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
        });
        if (!ok) {
          throw new LeaseLostError(
            `Lease lost committing wait for flow execution "${executionId}"`,
            {
              executionId,
              workerId,
              step: currentStepName,
            },
          );
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
        const wakeAt = new Date((await databaseTime(db)).getTime() + delayMs);
        await guardedUpdate(executionId, {
          status: FlowStatus.Waiting,
          state: nextState,
          stepHistory: history,
          currentStep: nextStep,
          retryCount: 0,
          waitingForEvent: null,
          waitKind: 'delay',
          wakeAt,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
        });
        try {
          await onFlowDelayedSchedule?.(executionId, wakeAt, row.correlationId ?? executionId);
        } catch {
          logger?.error('Delay wake publication failed; database reconciliation will recover', {
            executionId,
          });
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
          retryCount: 0,
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
          retryCount: 0,
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
        retryCount: 0,
      });
      return { id: executionId, flowName: row.flowName, status: FlowStatus.Running };
    } finally {
      clearInterval(heartbeatTimer);
      if (!stepAc.signal.aborted) stepAc.abort();
      if (activeStepAborts.get(executionId) === stepAc) activeStepAborts.delete(executionId);
    }
  }

  /**
   * Resume a waiting flow (e.g., after an event arrives or approval granted).
   */
  async function resume(
    executionId: string,
    signal?: unknown,
    expectedWaitToken?: string | null,
  ): Promise<void> {
    return resumeExecution(executionId, signal, expectedWaitToken);
  }

  async function resumeExecution(
    executionId: string,
    signal: unknown,
    expectedWaitToken: string | null | undefined,
    expectedTenant?: FlowEventResumeScope,
  ): Promise<void> {
    const rows = await db
      .select()
      .from(flowExecutionsTable)
      .where(eq(flowExecutionsTable.id, executionId))
      .limit(1);

    const row = rows[0] as FlowExecutionRow | undefined;
    if (!row) throw new Error(`Flow execution "${executionId}" not found`);

    if (expectedWaitToken !== undefined && row.leaseToken !== expectedWaitToken)
      throw new LeaseLostError('Flow wait changed before signal delivery', { executionId });
    if (expectedTenant && (row.tenantId ?? null) !== expectedTenant.tenantId)
      throw new LeaseLostError('Flow tenant does not match the resuming event', { executionId });
    if (row.status !== FlowStatus.Waiting) {
      throw new Error(`Cannot resume flow "${executionId}" — current status is "${row.status}"`);
    }

    const flow = registry.get(row.flowName);
    if (!flow) throw new Error(`Flow "${row.flowName}" not registered`);

    if (!row.waitingForEvent && row.wakeAt && row.wakeAt.getTime() > Date.now()) {
      throw new LeaseLostError('Timed flow wait is not due', { executionId });
    }

    // Advance past the wait/delay step — set to created so claimNext picks it up
    const nextStep = row.waitingForEvent
      ? getNextStepName(flow.steps, row.currentStep ?? '')
      : row.currentStep;

    const resumed = await db
      .update(flowExecutionsTable)
      .set({
        status: FlowStatus.Created,
        currentStep: nextStep,
        retryCount: row.waitKind === 'retry' ? row.retryCount : 0,
        state: signal !== undefined ? signal : row.state,
        waitingForEvent: null,
        wakeAt: null,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        waitKind: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(flowExecutionsTable.id, executionId),
          eq(flowExecutionsTable.status, FlowStatus.Waiting),
          row.leaseToken
            ? eq(flowExecutionsTable.leaseToken, row.leaseToken)
            : isNull(flowExecutionsTable.leaseToken),
          expectedTenant ? tenantPredicate(expectedTenant.tenantId) : undefined,
        ),
      );
    if (getRowsAffected(resumed) === 0)
      throw new LeaseLostError('Flow changed while resuming', { executionId });

    await maybeEnqueueFlowStep(executionId, row.correlationId);
  }

  function tenantPredicate(tenantId: string | null) {
    return tenantId === null
      ? isNull(flowExecutionsTable.tenantId)
      : eq(flowExecutionsTable.tenantId, tenantId);
  }

  /**
   * Resume flows waiting on a specific event type.
   *
   * With a `scope`, only executions in that tenant are selected and the
   * guarded update re-checks the tenant; `{ tenantId: null }` resumes only
   * tenantless executions. The event trigger always passes the event's
   * tenant, so an event never resumes another tenant's execution.
   *
   * Without a `scope` (legacy direct engine callers) every tenant's waiting
   * executions are resumed, and a one-time warning is logged.
   *
   * Returns execution IDs resumed.
   */
  async function resumeWaitingByEvent(
    eventType: string,
    signal?: unknown,
    scope?: FlowEventResumeScope,
  ): Promise<string[]> {
    if (!scope) {
      warnOnce(
        'flow.resumeWaitingByEvent.unscoped',
        'resumeWaitingByEvent() called without a tenant scope: waiting executions of every tenant are resumed. Pass { tenantId } to limit it to one tenant.',
        { eventType },
      );
    }
    const waiting = await db
      .select({ id: flowExecutionsTable.id, leaseToken: flowExecutionsTable.leaseToken })
      .from(flowExecutionsTable)
      .where(
        and(
          eq(flowExecutionsTable.status, FlowStatus.Waiting),
          eq(flowExecutionsTable.waitingForEvent, eventType),
          scope ? tenantPredicate(scope.tenantId) : undefined,
        ),
      );
    const resumed: string[] = [];
    for (const row of waiting) {
      try {
        await resumeExecution(row.id, signal, row.leaseToken, scope);
        resumed.push(row.id);
      } catch (error) {
        if (!(error instanceof LeaseLostError)) throw error;
      }
    }
    return resumed;
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
   * Cancel a running or waiting flow.
   */
  async function cancel(executionId: string): Promise<void> {
    const rows = await db
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

    assertTransition(row.status as FlowStatus, FlowStatus.Cancelled);
    const cancelled = await db
      .update(flowExecutionsTable)
      .set({
        status: FlowStatus.Cancelled,
        completedAt: new Date(),
        updatedAt: new Date(),
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(flowExecutionsTable.id, executionId),
          inArray(flowExecutionsTable.status, [
            FlowStatus.Created,
            FlowStatus.Running,
            FlowStatus.Waiting,
          ]),
        ),
      );
    if (getRowsAffected(cancelled) === 0)
      throw new FlowCancelledError(executionId, { reason: 'already_terminal' });
    claims.delete(executionId);

    // Synchronously abort the step's AbortController if it is running in THIS
    // engine instance. Cross-process cancellations still converge via the next
    // heartbeat (which fails because status is no longer 'running').
    const activeAc = activeStepAborts.get(executionId);
    if (activeAc && !activeAc.signal.aborted) {
      activeAc.abort(new FlowCancelledError(executionId));
    }

    if (audit) {
      await audit.record(`flow.cancelled.${row.flowName}`, {
        executionId,
        flowName: row.flowName,
      });
    }
  }

  /**
   * Get the current status of a flow execution.
   */
  async function status(executionId: string): Promise<FlowExecution> {
    const rows = await db
      .select()
      .from(flowExecutionsTable)
      .where(eq(flowExecutionsTable.id, executionId))
      .limit(1);

    const row = rows[0] as FlowExecutionRow | undefined;
    if (!row) throw new Error(`Flow execution "${executionId}" not found`);

    return { id: row.id, flowName: row.flowName, status: row.status };
  }

  /**
   * Read the stored actor and tenant of an execution (undefined when the id
   * is unknown). Used by the caller-facing flow service for access checks.
   */
  async function getExecutionOwner(executionId: string): Promise<FlowExecutionOwner | undefined> {
    const rows = await db
      .select({ actor: flowExecutionsTable.actor, tenantId: flowExecutionsTable.tenantId })
      .from(flowExecutionsTable)
      .where(eq(flowExecutionsTable.id, executionId))
      .limit(1);
    const row = rows[0] as FlowExecutionOwner | undefined;
    return row ? { actor: row.actor, tenantId: row.tenantId ?? null } : undefined;
  }

  // ── Internal helpers ──

  async function handleStepFailure(
    executionId: string,
    row: FlowExecutionRow,
    flow: FlowDefinition,
    history: StepHistoryEntry[],
    error?: string,
    permanent = false,
  ): Promise<FlowExecution> {
    const retryCount = (row.retryCount ?? 0) + 1;
    const { attempts, ...policy } = flow.retry ?? {};
    const resolved = resolveRetryPolicy(policy, {
      maxAttempts: (attempts ?? 0) + 1,
      backoff: 'exponential',
      baseDelayMs: 1000,
      maxDelayMs: 60000,
    });

    if (!permanent && retryCount < resolved.maxAttempts) {
      const wakeAt = new Date(
        (await databaseTime(db)).getTime() + retryDelay(resolved, retryCount),
      );
      await guardedUpdate(executionId, {
        stepHistory: history,
        retryCount,
        lastError: error ?? null,
        status: FlowStatus.Waiting,
        waitKind: 'retry',
        waitingForEvent: null,
        wakeAt,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
      });
      try {
        await onFlowDelayedSchedule?.(executionId, wakeAt, row.correlationId ?? executionId);
      } catch {
        logger?.error('Retry wake publication failed; database reconciliation will recover', {
          executionId,
        });
      }
      return { id: executionId, flowName: row.flowName, status: FlowStatus.Waiting };
    }

    // Persist the final failed attempt before terminal disposition.
    await guardedUpdate(executionId, {
      stepHistory: history,
      retryCount,
      lastError: error ?? null,
    });
    await failFlow(executionId, row.flowName, error, row);
    return { id: executionId, flowName: row.flowName, status: FlowStatus.Failed };
  }

  async function completeFlow(executionId: string, flowName: string): Promise<void> {
    const ok = await guardedUpdate(executionId, {
      status: FlowStatus.Completed,
      currentStep: null,
      completedAt: new Date(),
      leaseOwner: null,
      leaseToken: null,
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
      leaseToken: null,
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
    try {
      await deadLetterFlow(db, executionId);
    } catch {
      logger?.error('Flow dead-letter persistence pending recovery', { executionId });
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
          db,
        });
      } catch {
        // Swallow — error logging must never break flow processing
      }
    }
  }

  async function markFailedFromRunner(
    executionId: string,
    error: unknown,
    leaseToken?: string,
  ): Promise<boolean> {
    if (error instanceof LeaseLostError || error instanceof FlowCancelledError || !leaseToken)
      return false;
    return claimScope.run({ id: executionId, token: leaseToken }, async () => {
      try {
        const rows = await db
          .select()
          .from(flowExecutionsTable)
          .where(eq(flowExecutionsTable.id, executionId))
          .limit(1);
        const row = rows[0] as FlowExecutionRow | undefined;
        if (!row) return false;
        await failFlow(
          executionId,
          row.flowName,
          error instanceof Error ? error.message : 'Runner failed',
          row,
        );
        return true;
      } catch (failure) {
        if (failure instanceof LeaseLostError) return false;
        throw failure;
      }
    });
  }

  async function guardedUpdate(id: string, updates: FlowExecutionUpdate): Promise<boolean> {
    const claim = claimScope.getStore();
    if (!claim || claim.id !== id)
      throw new LeaseLostError('Missing flow claim', { executionId: id });
    const result = await db
      .update(flowExecutionsTable)
      .set({
        ...updates,
        ...(updates.status === FlowStatus.Waiting ? { leaseToken: claim.token } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(flowExecutionsTable.id, id),
          eq(flowExecutionsTable.leaseOwner, workerId),
          eq(flowExecutionsTable.leaseToken, claim.token),
          eq(flowExecutionsTable.status, FlowStatus.Running),
          sql`${flowExecutionsTable.leaseExpiresAt} > now()`,
        ),
      );
    if (getRowsAffected(result) === 0)
      throw new LeaseLostError('Flow ownership lost while committing', {
        executionId: id,
        workerId,
      });
    if (updates.leaseToken === null && claims.get(id) === claim.token) claims.delete(id);
    return true;
  }

  return {
    start,
    wake: maybeEnqueueFlowStep,
    runNext,
    resume,
    resumeWaitingByEvent,
    listRunnable,
    claimNext,
    claimExecution,
    cancel,
    status,
    markFailedFromRunner,
    getExecutionOwner,
    warnOnce,
    get enforceExecutionOwnership() {
      return enforceExecutionOwnership;
    },
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
    features: ai.features,
    decide: (params) => ai.decide(withSignal(params)),
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
