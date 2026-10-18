import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import type { ApprovalService } from '../approvals/types.js';
import { parseDurationToMs, resolveRetryPolicy, retryDelay } from '../config/index.js';
import { FRAMEWORK_SCHEMA } from '../data/schema-generator.js';
import {
  ackSpineDispatch,
  advanceExecutionWakeOnDb,
  advanceSpineDispatchNotBefore,
  casAdvanceExecution,
  claimSpineDispatch,
  deadLetterSpineDispatch,
  extendSpineDispatchLease,
  findSpineDispatchTenantRoute,
  insertDispatchOutbox,
  loadExecutionState,
  markExecutionStateTerminal,
  markOutboxAckedBySpineRow,
  persistAcceptanceOnDb,
  persistRetryScheduleOnDb,
  publishOutboxToSpine,
  releaseSpineDispatch,
} from '../durable/index.js';
import {
  type DispatchOutboxRow,
  type OpaqueDispatchRecord,
  SpineDeliveryState,
} from '../durable/types.js';
import {
  FlowCancelledError,
  FlowDefinitionUnavailableError,
  FlowDefinitionUnavailableReason,
  LeaseLostError,
  PlumbusError,
} from '../errors/index.js';
import type { EventQueue } from '../events/queue.js';
import type { DataPlaneResolver } from '../tenancy/types.js';
import type { AuditService } from '../types/audit.js';
import type {
  AIService,
  DataService,
  EventService,
  ExecutionContext,
  FlowExecution,
  FlowWakeResult,
  LoggerService,
} from '../types/context.js';
import { BackoffStrategy, ErrorCode, FlowStepType, FlowWakeSkipReason } from '../types/enums.js';
import type { CapabilityStep, FlowDefinition, FlowStep, ParallelStep } from '../types/flow.js';
import type { AuthContext } from '../types/security.js';
import {
  BUDGET_EXHAUSTED,
  consumeExecutionBudget,
  createExecutionBudgetLedger,
  writeExecutionBudget,
} from './budget.js';
import { flowDefinitionId, hydrateCompiledFlow } from './compile-flow.js';
import type { CompiledFlowRegistry } from './compiled-registry.js';
import { databaseTime } from './database-clock.js';
import { deadLetterFlow } from './dead-letter.js';
import {
  assertSupportedDefinitionStrategy,
  DefinitionInFlightStrategy,
  type DefinitionInFlightStrategy as DefinitionInFlightStrategyName,
} from './definition-strategy.js';
import {
  createFlowExecutionRecord,
  flowAuthSchema,
  type FlowStartOptions,
} from './execution-record.js';
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
/** Never matches a real claim token; fences a lease extension made outside a claim scope. */
const NO_CLAIM_TOKEN = '00000000-0000-0000-0000-000000000000';
/** `flow_executions.wait_kind` of a retry backoff, which `ctx.flows.wake` leaves alone. */
const RETRY_WAIT_KIND = 'retry';
/** Stands in for a malformed execution id in a refused wake's audit record and log line. */
const MALFORMED_EXECUTION_ID = '(malformed)';

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
/** SQLSTATE 23505 on the error or the driver error it wraps. */
function isUniqueViolation(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 3; depth += 1) {
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

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
  /**
   * Build the execution context a flow step runs with, from the execution's verified
   * caller identity (jobs, correlation and causation bound to the flow). Omitted, the
   * context passed to `runNext` is used.
   */
  createContext?: (
    auth: AuthContext,
    metadata: { correlationId: string; flowId: string },
  ) => ExecutionContext;
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
   * Optional compiled-definition registry. When set,
   * the engine consumes compiled JSON (not live TypeScript steps):
   * `start` requires a published version and pins it on `flow_executions`.
   * Omitted: existing live-TS `FlowRegistry` path is unchanged.
   */
  compiledRegistry?: CompiledFlowRegistry;
  /** Stage 4 approval service — required for `approval-outcome` steps. */
  approvals?: ApprovalService;
  /**
   * Called when a claimed execution is released because this engine lacks its definition
   * (flow not registered, pinned compiled version missing or with another digest, or — live
   * definitions only — its current step not in the definition). The execution stays runnable
   * for a worker that has the definition; the worker pool logs and counts it here.
   */
  onDefinitionUnavailable?: (info: FlowDefinitionUnavailableInfo) => void;
  /**
   * How long this engine leaves an execution it released for a missing definition to other
   * workers before claiming it again. Default 60 000 ms.
   */
  definitionUnavailableRetryMs?: number;
}

export interface FlowDefinitionUnavailableInfo {
  executionId: string;
  flowName: string;
  reason: FlowDefinitionUnavailableReason;
  /** The pinned compiled version, when the execution has one. */
  definitionVersion?: string;
  workerId: string;
}

export interface FlowSpineDispatchConfig {
  db: PostgresJsDatabase;
  resolver: DataPlaneResolver;
  /** Schema holding tenant durable tables. Default `core_plumbus`. */
  coreSchema?: string;
  /**
   * What a flow started with no tenant reference does. `'refuse'` (the default) is the
   * fail-closed choice a single-tenant-per-plane deployment wants. `'control-plane'` places
   * such a flow on `db` — the spine — exactly as an engine without spine dispatch would, and
   * claims it from there beside the tenant hints: control-plane work (a fleet sweep, a
   * platform procedure an operator started) has no tenant plane to live on and no private
   * state to keep off the spine.
   */
  untenanted?: 'refuse' | 'control-plane';
  /**
   * How many claims a hint survives without its tenant plane resolving before it is parked
   * as dead-lettered instead of being re-leased on every poll — a tenant whose plane is gone
   * (closed, dropped) leaves hints behind. Default 10.
   */
  maxClaimAttempts?: number;
}

/**
 * A flow execution persisted by `createExecution` and not yet announced. The creating
 * transaction must commit before `announceExecution` and `wake` run.
 */
export interface PendingFlowExecution extends FlowExecution {
  status: typeof FlowStatus.Created;
  /** The start's correlation id, or the execution id when none was given. */
  correlationId: string;
  /** Set only when spine dispatch placed the execution on its tenant's plane. */
  tenantRef?: string;
  /** The acceptance outbox row whose spine hint is published after commit (tenant-placed only). */
  acceptance?: DispatchOutboxRow;
  /** The compiled definition the execution is pinned to. */
  pin?: { flowDefinitionId: string; definitionVersion: string; definitionDigest?: string };
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
  definitionVersion: string | null;
  definitionDigest: string | null;
}

/** Legacy/corrupt snapshots never inherit the worker's privileges. */
function resolveFlowStepAuth(row: FlowExecutionRow): AuthContext | null {
  const result = flowAuthSchema.safeParse(row.authSnapshotJson);
  if (!result.success) return null;
  if ((result.data.tenantId ?? null) !== row.tenantId) return null;
  if (result.data.userId != null && result.data.userId !== row.actor) return null;
  return result.data;
}

/** Type-safe partial update payload for flow executions. */
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
 * across multiple workers sharing the same database. Every claim carries a
 * token; every state write is fenced by owner, token, `status = 'running'`
 * and an unexpired lease, on whichever plane the execution's row lives.
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
  const onFlowDelayedSchedule = config.onFlowDelayedSchedule;
  const spineDispatch = config.spineDispatch;
  const durableSchema = spineDispatch?.coreSchema ?? FRAMEWORK_SCHEMA;
  const maxClaimAttempts = spineDispatch?.maxClaimAttempts ?? 10;
  const untenantedOnControlPlane = spineDispatch?.untenanted === 'control-plane';
  const executionStores = new Map<string, PostgresJsDatabase>();
  const claimedHints = new Map<string, OpaqueDispatchRecord>();
  const scheduledRetries = new Map<string, { stepId: string; notBefore: string }>();
  const executionPins = new Map<
    string,
    { flowDefinitionId: string; definitionVersion: string; definitionDigest?: string }
  >();
  /** Claim tokens this engine holds, by execution id. */
  const claims = new Map<string, string>();
  const definitionUnavailableRetryMs = config.definitionUnavailableRetryMs ?? 60_000;
  /**
   * Executions this engine released for a missing definition, with the time until which its
   * claims skip them: other workers (one that has the definition) get them meanwhile, and a
   * worker that lacks it takes each such execution at most once per window — no hot loop.
   */
  const unavailableUntil = new Map<string, number>();

  function skippedExecutionIds(): string[] {
    const now = Date.now();
    for (const [id, until] of unavailableUntil) {
      if (until <= now) unavailableUntil.delete(id);
    }
    return [...unavailableUntil.keys()];
  }

  function rememberUnavailable(executionId: string): void {
    // Bounded: past the cap the oldest entry goes (it is claimed, and released, once more).
    if (unavailableUntil.size >= 10_000) {
      const oldest = unavailableUntil.keys().next().value;
      if (oldest !== undefined) unavailableUntil.delete(oldest);
    }
    unavailableUntil.set(executionId, Date.now() + definitionUnavailableRetryMs);
  }

  function reportUnavailable(info: Omit<FlowDefinitionUnavailableInfo, 'workerId'>): void {
    logger?.warn('definition-unavailable: released a claimed flow execution for another worker', {
      ...info,
      workerId,
    });
    try {
      config.onDefinitionUnavailable?.({ ...info, workerId });
    } catch {
      // Observability must never break claiming.
    }
  }

  /**
   * The definition this engine would run an execution with, or `FlowDefinitionUnavailableError`
   * when it lacks it: the flow, the pinned compiled version, or that version's digest. A
   * compiled-registry engine still fails an execution that has no pin at all, as before.
   */
  function resolveRunnableFlow(executionId: string, flowName: string): FlowDefinition {
    const authoring = registry.get(flowName);
    if (!authoring) {
      throw new FlowDefinitionUnavailableError(
        executionId,
        flowName,
        FlowDefinitionUnavailableReason.FlowNotRegistered,
      );
    }
    const pin = executionPins.get(executionId);
    if (compiledRegistry && pin) {
      const compiled = compiledRegistry.get(pin.flowDefinitionId, pin.definitionVersion);
      if (!compiled) {
        throw new FlowDefinitionUnavailableError(
          executionId,
          flowName,
          FlowDefinitionUnavailableReason.CompiledVersionMissing,
          { definitionVersion: pin.definitionVersion },
        );
      }
      if (pin.definitionDigest && compiled.definitionDigest !== pin.definitionDigest) {
        throw new FlowDefinitionUnavailableError(
          executionId,
          flowName,
          FlowDefinitionUnavailableReason.CompiledDigestMismatch,
          { definitionVersion: pin.definitionVersion },
        );
      }
    }
    return resolveExecutionFlow(executionId, flowName);
  }

  /** The claim a step (and its heartbeat) runs under; every guarded write is fenced by it. */
  const claimScope = new AsyncLocalStorage<{ id: string; token: string }>();

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

  /**
   * Finds the plane an execution's row lives on when this engine did not start or claim it —
   * a request-side engine reading, cancelling or resuming a flow another process placed on a
   * tenant plane. The spine's dispatch hint names the tenant route; the resolver names the
   * plane. Without a hint the execution is the engine's own (control-plane) row, or unknown,
   * and `db` answers as before.
   */
  async function locateStore(executionId: string): Promise<PostgresJsDatabase> {
    const cached = executionStores.get(executionId);
    if (cached) return cached;
    if (!spineDispatch) return db;
    try {
      const tenantRouteId = await findSpineDispatchTenantRoute(spineDispatch.db, executionId);
      if (!tenantRouteId) return db;
      const handle = await spineDispatch.resolver.resolve(tenantRouteId);
      executionStores.set(executionId, handle.db);
      return handle.db;
    } catch (error) {
      logger?.warn(
        'could not locate the plane of a dispatched execution; using the engine database',
        {
          executionId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return db;
    }
  }

  async function loadRow(
    store: PostgresJsDatabase,
    executionId: string,
  ): Promise<FlowExecutionRow | undefined> {
    const rows = await store
      .select()
      .from(flowExecutionsTable)
      .where(eq(flowExecutionsTable.id, executionId))
      .limit(1);
    return rows[0] as FlowExecutionRow | undefined;
  }

  /** The columns a wake decides by: no input, state or history, which can be large. */
  const waitColumns = {
    id: flowExecutionsTable.id,
    flowName: flowExecutionsTable.flowName,
    status: flowExecutionsTable.status,
    currentStep: flowExecutionsTable.currentStep,
    waitingForEvent: flowExecutionsTable.waitingForEvent,
    wakeAt: flowExecutionsTable.wakeAt,
    waitKind: flowExecutionsTable.waitKind,
    leaseToken: flowExecutionsTable.leaseToken,
    tenantId: flowExecutionsTable.tenantId,
    correlationId: flowExecutionsTable.correlationId,
  };
  type FlowWaitRow = Pick<FlowExecutionRow, keyof typeof waitColumns>;

  async function loadWaitRow(
    store: PostgresJsDatabase,
    executionId: string,
  ): Promise<FlowWaitRow | undefined> {
    const rows = await store
      .select(waitColumns)
      .from(flowExecutionsTable)
      .where(eq(flowExecutionsTable.id, executionId))
      .limit(1);
    return rows[0];
  }

  /** Publishes a wake for the execution; a failed publication is recovered by database polling. */
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

  /**
   * Persist a new execution — the row, its compiled-definition pin and budget ledger, and,
   * when spine dispatch places it on a tenant plane, its acceptance (durable state + outbox
   * row) — and nothing else: no audit, no wake, no spine publication. `store` may be a
   * transaction; the caller commits it, then calls `announceExecution` and `wake`.
   */
  async function createExecution(
    store: PostgresJsDatabase,
    flowName: string,
    input: unknown,
    auth: AuthContext,
    opts: FlowStartOptions = {},
  ): Promise<PendingFlowExecution> {
    const flow = registry.get(flowName);
    if (!flow) {
      throw new Error(`Flow "${flowName}" is not registered`);
    }
    if (spineDispatch && !auth.tenantId && !untenantedOnControlPlane) {
      throw new PlumbusError(
        ErrorCode.Forbidden,
        'spine dispatch requires a tenant reference on flow start',
        { reason: 'untenanted-flow-start' },
      );
    }
    const tenantRef = spineDispatch ? auth.tenantId : undefined;

    const executionId = opts.executionId ?? randomUUID();
    const compiled = resolveCompiledForStart(flow);
    const executionFlow = compiled ? hydrateCompiledFlow(compiled, flow) : flow;
    const firstStep = executionFlow.steps[0]?.name ?? null;

    let budgetState: Record<string, unknown> | undefined;
    if (flow.budget) {
      const defaultState: unknown = flow.state
        ? (() => {
            const parsed = flow.state.safeParse({});
            return parsed.success ? parsed.data : {};
          })()
        : null;
      budgetState = writeExecutionBudget(
        defaultState,
        createExecutionBudgetLedger({
          executionId,
          profileId: flow.budget.profileId,
          allocated: flow.budget.allocated,
          unitId: flow.budget.unitId,
          dimensionId: flow.budget.dimensionId,
        }),
      );
    }

    await createFlowExecutionRecord(
      store,
      flow,
      input,
      auth,
      { ...opts, executionId },
      {
        ...(budgetState ? { state: budgetState } : {}),
        currentStep: firstStep,
        definitionVersion: compiled?.definitionVersion ?? null,
        definitionDigest: compiled?.definitionDigest ?? null,
      },
    );

    const correlationId = opts.correlationId ?? executionId;
    let acceptance: DispatchOutboxRow | undefined;
    if (tenantRef) {
      const accepted = await persistAcceptanceOnDb(
        store,
        {
          executionId,
          tenantRef,
          definitionId: flowName,
          definitionVersion: compiled?.definitionVersion ?? '0.0.0',
          firstStepId: firstStep ?? 'terminal',
          correlationId,
          nowIso: new Date().toISOString(),
        },
        durableSchema,
      );
      acceptance = accepted.outbox;
    }

    return {
      id: executionId,
      flowName,
      status: FlowStatus.Created,
      correlationId,
      ...(tenantRef ? { tenantRef, acceptance } : {}),
      ...(compiled
        ? {
            pin: {
              flowDefinitionId: compiled.flowDefinitionId,
              definitionVersion: compiled.definitionVersion,
              definitionDigest: compiled.definitionDigest,
            },
          }
        : {}),
    };
  }

  /**
   * After the transaction that created `pending` committed: remember where the row lives and
   * which definition it is pinned to, audit the start, and hand the spine the acceptance's
   * hint. `placement.store` is the plane's own handle (never a transaction). A failed hint
   * publication does not fail the start — the dispatcher's outbox pump publishes the row.
   */
  async function announceExecution(
    pending: PendingFlowExecution,
    placement: { store: PostgresJsDatabase; auth: AuthContext },
  ): Promise<void> {
    if (spineDispatch) executionStores.set(pending.id, placement.store);
    if (pending.pin) executionPins.set(pending.id, pending.pin);

    if (audit) {
      await audit.record(`flow.started.${pending.flowName}`, {
        executionId: pending.id,
        flowName: pending.flowName,
        actor: placement.auth.userId,
        tenantId: placement.auth.tenantId,
        outcome: 'success',
      });
    }

    if (spineDispatch && pending.acceptance) {
      try {
        await publishOutboxToSpine(
          placement.store,
          spineDispatch.db,
          pending.acceptance,
          `disp:${pending.id}:1`,
          new Date().toISOString(),
          durableSchema,
        );
      } catch (error) {
        logger?.warn('spine hint publication failed; the outbox pump publishes it', {
          executionId: pending.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Start a new flow execution.
   */
  async function start(
    flowName: string,
    input: unknown,
    auth: AuthContext,
    opts?: FlowStartOptions,
  ): Promise<FlowExecution> {
    if (!registry.get(flowName)) {
      throw new Error(`Flow "${flowName}" is not registered`);
    }

    // Placement: a tenant's flow lives on its plane; an untenanted one (when allowed) on the
    // spine's own table; without spine dispatch everything lives on `db`.
    let store = db;
    let tenantPlaced = false;
    if (spineDispatch) {
      if (auth.tenantId) {
        store = (await spineDispatch.resolver.resolve(auth.tenantId)).db;
        tenantPlaced = true;
      } else {
        store = spineDispatch.db;
      }
    }

    // The row and its acceptance commit together on the tenant's plane.
    let pending: PendingFlowExecution;
    try {
      pending = tenantPlaced
        ? await store.transaction((tx) =>
            createExecution(tx as unknown as PostgresJsDatabase, flowName, input, auth, opts),
          )
        : await createExecution(store, flowName, input, auth, opts);
    } catch (error) {
      // Starting by execution id is idempotent: a deferred start and its recovery (or any
      // retried start) that find the execution already created get it back, not a second one.
      if (opts?.executionId && isUniqueViolation(error)) {
        const existing = await loadRow(store, opts.executionId);
        if (existing && existing.flowName === flowName) {
          if (spineDispatch) executionStores.set(existing.id, store);
          return { id: existing.id, flowName, status: existing.status };
        }
      }
      throw error;
    }

    await announceExecution(pending, { store, auth });
    await maybeEnqueueFlowStep(pending.id, opts?.correlationId);

    return {
      id: pending.id,
      flowName,
      status: FlowStatus.Created,
    };
  }

  /**
   * Claim tenant-placed executions through their spine hints. The hint lease decides who may
   * run the step; the tenant row is then claimed with a fresh token (in database time), which
   * fences out any earlier runner of the same row.
   */
  async function claimNextFromSpine(batchSize?: number): Promise<FlowExecutionRow[]> {
    if (!spineDispatch) return [];
    const hints = await claimSpineDispatch(spineDispatch.db, {
      workerId,
      leaseDurationMs,
      limit: batchSize ?? claimBatchSize,
      excludeExecutionIds: skippedExecutionIds(),
    });
    const leaseDurationInterval = `${leaseDurationMs} milliseconds`;
    const rows: FlowExecutionRow[] = [];
    // A hint's definition id and version are whatever its acceptance wrote (a host's
    // `persistAcceptance` may use its own ids), so the definition check waits for the tenant
    // row's flow name and pin, in runNext; a release there hands back both row and hint.
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
          await dropSpineHint(handle.db, hint.dispatchId);
          continue;
        }
        const row = await loadRow(handle.db, hint.executionId);
        // A row cancelled or otherwise closed outside the run loop keeps no claim on the
        // hint that was published for it: drop the hint rather than revive the row.
        if (!row || isTerminal(row.status as FlowStatus)) {
          await dropSpineHint(handle.db, hint.dispatchId);
          continue;
        }
        // A row waiting for an event, or for a wake time that has not come, is not runnable
        // whatever the hint says; leave the hint to lapse rather than run the wait step again.
        if (
          row.status === FlowStatus.Waiting &&
          (row.waitingForEvent !== null || (row.wakeAt !== null && row.wakeAt > new Date()))
        ) {
          continue;
        }
        const token = randomUUID();
        const claimed = await handle.db
          .update(flowExecutionsTable)
          .set({
            status: FlowStatus.Running,
            leaseOwner: workerId,
            leaseToken: token,
            leaseExpiresAt: sql`now() + ${leaseDurationInterval}::interval`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(flowExecutionsTable.id, hint.executionId),
              inArray(flowExecutionsTable.status, [
                FlowStatus.Created,
                FlowStatus.Running,
                FlowStatus.Waiting,
              ]),
              // A running row whose lease is live belongs to the worker running it, whatever
              // state its hint is in: never mint a second claim over it.
              sql`(${flowExecutionsTable.status} <> ${FlowStatus.Running}
                OR ${flowExecutionsTable.leaseExpiresAt} IS NULL
                OR ${flowExecutionsTable.leaseExpiresAt} < now())`,
            ),
          );
        if (getRowsAffected(claimed) === 0) {
          const current = await loadRow(handle.db, hint.executionId);
          if (!current || isTerminal(current.status as FlowStatus)) {
            // The row became terminal between the read and the claim.
            await dropSpineHint(handle.db, hint.dispatchId);
          } else {
            // Leased elsewhere: hand the hint back for when that lease would lapse.
            await releaseSpineDispatch(spineDispatch.db, {
              dispatchId: hint.dispatchId,
              workerId,
              ...(current.leaseExpiresAt
                ? { notBefore: new Date(current.leaseExpiresAt).toISOString() }
                : {}),
            });
            logger?.warn('spine hint claimed while its execution is leased elsewhere; released', {
              executionId: hint.executionId,
              dispatchId: hint.dispatchId,
              leaseOwner: current.leaseOwner,
            });
          }
          continue;
        }
        executionStores.set(hint.executionId, handle.db);
        claimedHints.set(hint.executionId, hint);
        claims.set(hint.executionId, token);
        rows.push({
          ...row,
          status: FlowStatus.Running,
          leaseOwner: workerId,
          leaseToken: token,
        });
      } catch (error) {
        logger?.error('spine claim failed closed for one dispatch', {
          dispatchId: hint.dispatchId,
          executionId: hint.executionId,
          attempt: hint.attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        if (hint.attempt >= maxClaimAttempts) {
          await deadLetterSpineDispatch(spineDispatch.db, hint.dispatchId, 'plane-unresolved');
          logger?.warn('spine hint dead-lettered after repeated claim failures', {
            dispatchId: hint.dispatchId,
            executionId: hint.executionId,
            tenantRouteId: hint.tenantRouteId,
            attempt: hint.attempt,
          });
        }
      }
    }
    return rows;
  }

  /**
   * Atomically claim up to `batchSize` runnable flow executions. Rows the engine claimed
   * carry their claim token (`leaseToken`).
   */
  async function claimNext(batchSize?: number): Promise<FlowExecutionRow[]> {
    if (spineDispatch) {
      const fromSpine = await claimNextFromSpine(batchSize);
      if (!untenantedOnControlPlane) return fromSpine;
      // Control-plane flows live on the spine's own `flow_executions`; claim what budget is
      // left there, after the tenant hints.
      const remaining = (batchSize ?? claimBatchSize) - fromSpine.length;
      if (remaining <= 0) return fromSpine;
      const fromControlPlane = await claimNextFromOwnDb(remaining);
      for (const row of fromControlPlane) executionStores.set(row.id, spineDispatch.db);
      return [...fromSpine, ...fromControlPlane];
    }
    return claimNextFromOwnDb(batchSize);
  }

  /**
   * Atomically claim up to `batchSize` runnable flow executions from the engine's own table.
   * Uses FOR UPDATE SKIP LOCKED so concurrent workers each get different rows.
   * Also reclaims rows whose lease has expired (crash recovery).
   */
  async function claimNextFromOwnDb(batchSize?: number): Promise<FlowExecutionRow[]> {
    const limit = batchSize ?? claimBatchSize;
    const leaseDurationInterval = `${leaseDurationMs} milliseconds`;
    const skipped = skippedExecutionIds();

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
        WHERE (
             status = ${FlowStatus.Created}
          OR (status = ${FlowStatus.Running} AND lease_expires_at < now())
          OR (status = ${FlowStatus.Waiting} AND waiting_for_event IS NULL AND wake_at <= now())
        )
        ${skipped.length > 0 ? sql`AND NOT (id::text = ANY(${skipped}::text[]))` : sql``}
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
   * Claims on the engine's own database only: a tenant-placed execution is claimed through
   * its spine hint, which keeps its durable state in step.
   */
  async function claimExecution(executionId: string): Promise<FlowExecutionRow | undefined> {
    if (skippedExecutionIds().includes(executionId)) return undefined;
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
    const hint = claimedHints.get(executionId);
    if (spineDispatch && hint) {
      const spineExtended = await extendSpineDispatchLease(spineDispatch.db, {
        dispatchId: hint.dispatchId,
        workerId,
        leaseDurationMs,
      });
      if (!spineExtended) {
        logger?.warn('extendSpineDispatchLease matched 0 rows', {
          executionId,
          dispatchId: hint.dispatchId,
          expectedWorkerId: workerId,
        });
        return false;
      }
    }
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
          eq(flowExecutionsTable.leaseToken, claimScope.getStore()?.token ?? NO_CLAIM_TOKEN),
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
   * The execution must have been claimed by this worker (via claimNext) first; pass the
   * claim's token, or the engine uses the claim it holds (or claims the row itself).
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
    const claim = { id: executionId, token };
    let result: FlowExecution;
    try {
      result = await claimScope.run(claim, () => runClaimedStep(executionId, ctx));
    } catch (error) {
      if (error instanceof FlowDefinitionUnavailableError) {
        // Not this worker's to run: hand the execution back runnable (lease expired now, the
        // spine hint ready) and skip it for a while, instead of failing it for good.
        await releaseClaim(executionId, token);
        rememberUnavailable(executionId);
        const pin = executionPins.get(executionId);
        reportUnavailable({
          executionId,
          flowName: String(error.metadata?.flowName ?? ''),
          reason: error.reason,
          ...(pin ? { definitionVersion: pin.definitionVersion } : {}),
        });
      }
      throw error;
    }
    await syncSpineAfterRun(executionId, result, token);
    return result;
  }

  async function runClaimedStep(
    executionId: string,
    ctx: ExecutionContext,
  ): Promise<FlowExecution> {
    const row = await loadRow(storeFor(executionId), executionId);
    if (!row) {
      throw new Error(`Flow execution "${executionId}" not found`);
    }

    if (isTerminal(row.status as FlowStatus)) {
      return { id: row.id, flowName: row.flowName, status: row.status };
    }

    // Ownership probe: fails with LeaseLostError unless this claim still owns the row.
    await guardedUpdate(executionId, {});

    restorePinFromRow(row);
    const flow = resolveRunnableFlow(executionId, row.flowName);

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
    if (!step && !compiledRegistry) {
      // A live definition without this step is another release's: a step a newer release
      // added, or one an older release still has. A pinned compiled definition cannot drift,
      // so there a missing step stays a failure.
      throw new FlowDefinitionUnavailableError(
        executionId,
        row.flowName,
        FlowDefinitionUnavailableReason.StepNotFound,
        { step: currentStepName },
      );
    }
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
          // The ledger cannot recover within this execution: no retries.
          return handleStepFailure(executionId, row, flow, history, BUDGET_EXHAUSTED, true);
        }
        await guardedUpdate(executionId, { state: charged.state });
      }
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
      ctx.ai.withContext?.({
        tenantId: flowAuth.tenantId,
        actor: flowAuth.userId,
        correlationId: row.correlationId ?? undefined,
      }) ?? ctx.ai;
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
        // Same reason: a wake from a step is scoped to the flow's own tenant, not the worker's.
        wake: (otherExecutionId: string) => wakeTimedWait(otherExecutionId, flowAuth),
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
        await guardedUpdate(executionId, {
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
        const wakeAt = new Date((await databaseTime(storeFor(executionId))).getTime() + delayMs);
        await guardedUpdate(executionId, {
          status: FlowStatus.Waiting,
          state: nextState,
          stepHistory: history,
          // `null` (not undefined) when the delay is the last step: the update must clear
          // the current step, or the delay would run again on every wake.
          currentStep: nextStep ?? null,
          retryCount: 0,
          waitingForEvent: null,
          waitKind: 'delay',
          wakeAt,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
        });
        if (spineDispatch) {
          scheduledRetries.set(executionId, {
            stepId: nextStep ?? currentStepName,
            notBefore: wakeAt.toISOString(),
          });
        }
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
      // Abort any stray detached tasks once the step settles so they observe
      // the abort promptly. If already aborted (lease loss), this is a no-op.
      if (!stepAc.signal.aborted) stepAc.abort();
      if (activeStepAborts.get(executionId) === stepAc) activeStepAborts.delete(executionId);
    }
  }

  /**
   * Resume a waiting flow (e.g., after an event arrives or approval granted).
   * `expectedWaitToken` fences the resume to one activation of the wait.
   */
  async function resume(
    executionId: string,
    signal?: unknown,
    expectedWaitToken?: string | null,
  ): Promise<void> {
    return resumeOn(await locateStore(executionId), executionId, signal, expectedWaitToken);
  }

  async function resumeOn(
    store: PostgresJsDatabase,
    executionId: string,
    signal?: unknown,
    expectedWaitToken?: string | null,
  ): Promise<void> {
    const row = await loadRow(store, executionId);
    if (!row) throw new Error(`Flow execution "${executionId}" not found`);

    if (expectedWaitToken !== undefined && row.leaseToken !== expectedWaitToken)
      throw new LeaseLostError('Flow wait changed before signal delivery', { executionId });
    if (row.status !== FlowStatus.Waiting) {
      throw new Error(`Cannot resume flow "${executionId}" — current status is "${row.status}"`);
    }

    restorePinFromRow(row);
    const flow = resolveExecutionFlow(executionId, row.flowName);

    if (!row.waitingForEvent && row.wakeAt && row.wakeAt.getTime() > Date.now()) {
      throw new LeaseLostError('Timed flow wait is not due', { executionId });
    }

    // Advance past an event wait; a delay or retry wait already points at the step to run.
    // Set to created so claimNext picks it up.
    const nextStep = row.waitingForEvent
      ? getNextStepName(flow.steps, row.currentStep ?? '')
      : row.currentStep;

    const resumed = await store
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
        ),
      );
    if (getRowsAffected(resumed) === 0)
      throw new LeaseLostError('Flow changed while resuming', { executionId });

    await maybeEnqueueFlowStep(executionId, row.correlationId);
  }

  /**
   * Resume all flows waiting on a specific event type.
   * Each resume is fenced by the wait's token, so concurrent workers resume a wait once.
   * Returns execution IDs resumed.
   */
  async function resumeWaitingByEvent(eventType: string, signal?: unknown): Promise<string[]> {
    const waiting = await db
      .select({ id: flowExecutionsTable.id, leaseToken: flowExecutionsTable.leaseToken })
      .from(flowExecutionsTable)
      .where(
        and(
          eq(flowExecutionsTable.status, FlowStatus.Waiting),
          eq(flowExecutionsTable.waitingForEvent, eventType),
        ),
      );
    const resumed: string[] = [];
    for (const row of waiting) {
      try {
        await resumeOn(db, row.id, signal, row.leaseToken);
        resumed.push(row.id);
      } catch (error) {
        if (!(error instanceof LeaseLostError)) throw error;
      }
    }
    return resumed;
  }

  /**
   * The database a caller's executions live on: where `start` places them for the same
   * identity. Under spine dispatch that is the caller's tenant plane (the spine's own table for
   * an untenanted caller, when untenanted flows are allowed); otherwise `db`. Wake looks nowhere
   * else, so a caller never reaches another tenant's plane. `undefined` when spine dispatch
   * refuses untenanted flows and the caller has no tenant: there is nothing it may wake.
   */
  async function storeForCaller(auth: AuthContext): Promise<PostgresJsDatabase | undefined> {
    if (!spineDispatch) return db;
    if (auth.tenantId) return (await spineDispatch.resolver.resolve(auth.tenantId)).db;
    return untenantedOnControlPlane ? spineDispatch.db : undefined;
  }

  /**
   * Records and logs a refused wake. `recordedId` is the id as the caller sent it only when it
   * is a well-formed execution id; a malformed one is never copied into the record.
   */
  async function denyWake(
    recordedId: string,
    auth: AuthContext,
    reason: 'flow-execution-not-found' | 'untenanted-flow-wake',
  ): Promise<void> {
    logger?.warn('flow wake refused', {
      executionId: recordedId,
      tenantId: auth.tenantId,
      actor: auth.userId,
      reason,
    });
    if (audit) {
      await audit.record('flow.wake.denied', {
        executionId: recordedId,
        actor: auth.userId,
        tenantId: auth.tenantId,
        outcome: 'denied',
        reason,
      });
    }
  }

  /**
   * Make an execution that sleeps in a delay step's wait due now (`ctx.flows.wake`), so the
   * next claim runs its next step instead of waiting for the scheduled time. Only the wake time
   * moves: status, current step, input, state, the stored identity and the wait's generation
   * token stay as they are, and the step is claimed and run the ordinary way (so it runs once,
   * under the identity that started the flow). A retry backoff is the engine's own pause before
   * a failed step runs again and is left alone (`retry-backoff`): waking it would spend the
   * step's remaining attempts at once. A timed wait without a recorded kind (written before
   * wait kinds were stored) counts as a delay, as `resume` treats it.
   *
   * Scoped to the caller's tenant: an execution of another tenant, one that does not exist and
   * a malformed id are refused with `notFound` (one answer for all), and an untenanted caller
   * under spine dispatch that refuses untenanted flows with `forbidden`; each refusal is
   * recorded (`flow.wake.denied`). Every other case is a result, never an error: not waiting,
   * waiting without a timer, a retry backoff, finished, already due, or a wait that ended or
   * changed between the read and the write (`woken: false`, `reason`). The write is fenced to
   * the wait that was read and to a wake time still ahead on the database clock, so of a wake
   * racing another wake, or the scheduled wake-up, exactly one changes the row.
   */
  async function wakeTimedWait(executionId: string, auth: AuthContext): Promise<FlowWakeResult> {
    const wellFormed = z.string().uuid().safeParse(executionId).success;
    const recordedId = wellFormed ? executionId : MALFORMED_EXECUTION_ID;
    const store = await storeForCaller(auth);
    if (!store) {
      await denyWake(recordedId, auth, 'untenanted-flow-wake');
      throw new PlumbusError(
        ErrorCode.Forbidden,
        'spine dispatch requires a tenant reference on flow wake',
        { reason: 'untenanted-flow-wake' },
      );
    }
    const row = wellFormed ? await loadWaitRow(store, executionId) : undefined;
    if (!row || (row.tenantId ?? null) !== (auth.tenantId ?? null)) {
      // A missing execution and another tenant's get the same answer: the caller learns
      // nothing about executions it may not reach.
      await denyWake(recordedId, auth, 'flow-execution-not-found');
      throw new PlumbusError(ErrorCode.NotFound, `Flow execution "${recordedId}" not found`, {
        executionId: recordedId,
        reason: 'flow-execution-not-found',
      });
    }

    const skip = (reason: FlowWakeSkipReason, status: string): FlowWakeResult => {
      logger?.info('flow wake left the execution as it was', {
        executionId,
        flowName: row.flowName,
        reason,
        status,
      });
      return { executionId, woken: false, reason, status };
    };
    if (isTerminal(row.status as FlowStatus)) return skip(FlowWakeSkipReason.Finished, row.status);
    if (row.status !== FlowStatus.Waiting) return skip(FlowWakeSkipReason.NotWaiting, row.status);
    if (row.waitingForEvent !== null || row.wakeAt === null) {
      return skip(FlowWakeSkipReason.NotTimedWait, row.status);
    }
    if (row.waitKind === RETRY_WAIT_KIND) return skip(FlowWakeSkipReason.RetryBackoff, row.status);
    const scheduledFor = row.wakeAt;

    if (spineDispatch) executionStores.set(executionId, store);
    // Placed as `start` places it: under spine dispatch a tenant's execution has a durable
    // acceptance and is claimed only through its spine hint, whichever handle the resolver
    // returned for the plane (it may be the spine's own). The row's tenant is the caller's.
    const tenantPlaced = spineDispatch !== undefined && Boolean(auth.tenantId);
    // The wait read above and nothing else: same generation token (as `resume` fences), still
    // timed, and not yet due. `clock_timestamp()`, not the statement's `now()`, so a wake that
    // queued behind another wake's row lock sees the due time that wake wrote.
    const moveWakeTime = async (target: PostgresJsDatabase): Promise<boolean> =>
      getRowsAffected(
        await target
          .update(flowExecutionsTable)
          .set({ wakeAt: sql`now()`, updatedAt: new Date() })
          .where(
            and(
              eq(flowExecutionsTable.id, executionId),
              eq(flowExecutionsTable.status, FlowStatus.Waiting),
              isNull(flowExecutionsTable.waitingForEvent),
              sql`${flowExecutionsTable.waitKind} IS DISTINCT FROM ${RETRY_WAIT_KIND}`,
              row.leaseToken
                ? eq(flowExecutionsTable.leaseToken, row.leaseToken)
                : isNull(flowExecutionsTable.leaseToken),
              sql`${flowExecutionsTable.wakeAt} > clock_timestamp()`,
            ),
          ),
      ) > 0;

    let moved: boolean;
    let durable: { revision: number; tenantRef: string } | undefined;
    if (tenantPlaced) {
      // The plane's durable wait (execution_state, wait_state, an unpublished outbox row)
      // moves with the row, in one transaction.
      const outcome = await store.transaction(async (transaction) => {
        const tx = transaction as unknown as PostgresJsDatabase;
        if (!(await moveWakeTime(tx))) return { moved: false as const };
        return {
          moved: true as const,
          durable: await advanceExecutionWakeOnDb(tx, executionId, durableSchema),
        };
      });
      moved = outcome.moved;
      durable = outcome.moved ? outcome.durable : undefined;
    } else {
      moved = await moveWakeTime(store);
    }

    if (!moved) {
      const current = await loadWaitRow(store, executionId);
      const sameWait =
        current !== undefined &&
        current.status === FlowStatus.Waiting &&
        current.waitingForEvent === null &&
        current.wakeAt !== null &&
        current.leaseToken === row.leaseToken;
      if (!sameWait) return skip(FlowWakeSkipReason.WaitChanged, current?.status ?? row.status);
      // Due already. Nothing to move on the row, but its wake-ups are made due again: a wake
      // whose spine hint update failed is completed by calling it once more.
      await publishWake(executionId, current, store, tenantPlaced);
      return skip(FlowWakeSkipReason.AlreadyDue, current.status);
    }

    logger?.info('flow wake made a timed wait due now', {
      executionId,
      flowName: row.flowName,
      step: row.currentStep,
      waitKind: row.waitKind,
      scheduledFor: scheduledFor.toISOString(),
      tenantId: auth.tenantId,
      actor: auth.userId,
    });
    try {
      await publishWake(executionId, row, store, tenantPlaced, durable);
    } finally {
      if (audit) {
        await audit.record(`flow.woken.${row.flowName}`, {
          executionId,
          flowName: row.flowName,
          actor: auth.userId,
          tenantId: auth.tenantId,
          step: row.currentStep,
          waitKind: row.waitKind,
          scheduledFor: scheduledFor.toISOString(),
          outcome: 'success',
        });
      }
    }
    return { executionId, woken: true, status: FlowStatus.Waiting };
  }

  /**
   * After a wake moved (or found) an execution's wake time at now: make every wake-up for it
   * due. A tenant-placed execution is claimed only through its spine hint, so the hint of the
   * plane's current revision moves to now (a failure here is thrown: the row is due, the hint
   * is not, and calling wake again completes it). The Redis delayed entry is rescheduled at now
   * and a flow-step wake is published; both are hints, recovered by database polling.
   */
  async function publishWake(
    executionId: string,
    row: FlowWaitRow,
    store: PostgresJsDatabase,
    tenantPlaced: boolean,
    durable?: { revision: number; tenantRef: string },
  ): Promise<void> {
    if (tenantPlaced && spineDispatch) {
      const target = durable ?? (await advanceExecutionWakeOnDb(store, executionId, durableSchema));
      if (target) {
        await advanceSpineDispatchNotBefore(spineDispatch.db, {
          executionId,
          tenantRouteId: target.tenantRef,
          expectedRevision: target.revision,
        });
      }
    }
    const correlationId = row.correlationId ?? executionId;
    if (onFlowDelayedSchedule) {
      try {
        await onFlowDelayedSchedule(executionId, new Date(), correlationId);
      } catch {
        logger?.error('Wake publication failed; database reconciliation will recover', {
          executionId,
        });
      }
    }
    await maybeEnqueueFlowStep(executionId, correlationId);
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
   * Cancel a running or waiting flow. The cancellation is committed first (fenced on a
   * non-terminal status, so it never overwrites a run that just finished), then the
   * in-flight step is aborted and completed steps with `compensate` run their compensation
   * capability (recovery CompensationState v1).
   */
  async function cancel(
    executionId: string,
    opts?: { actor?: string; skipCompensation?: boolean },
  ): Promise<void> {
    const store = await locateStore(executionId);
    const row = await loadRow(store, executionId);
    if (!row) throw new Error(`Flow execution "${executionId}" not found`);

    if (isTerminal(row.status as FlowStatus)) {
      throw new Error(
        `Cannot cancel flow "${executionId}" — already in terminal state "${row.status}"`,
      );
    }

    // Resolve the definition before any write, so a missing pin fails the cancel cleanly.
    let flow: FlowDefinition | undefined;
    if (!opts?.skipCompensation) {
      restorePinFromRow(row);
      flow = resolveExecutionFlow(executionId, row.flowName);
    }

    assertTransition(row.status as FlowStatus, FlowStatus.Cancelled);
    const cancelled = await store
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
    // heartbeat (which fails because status is no longer 'running'); either way the
    // step can no longer commit.
    const activeAc = activeStepAborts.get(executionId);
    if (activeAc && !activeAc.signal.aborted) {
      activeAc.abort(new FlowCancelledError(executionId));
    }

    let compensated = false;
    if (flow) {
      // Compensate what had committed when the cancellation took effect.
      const current = (await loadRow(store, executionId)) ?? row;
      const history = Array.isArray(current.stepHistory)
        ? ([...current.stepHistory] as StepHistoryEntry[])
        : [];
      const recorded = history.length;
      await runCompensations(executionId, current, flow, history);
      if (history.length > recorded) {
        await store
          .update(flowExecutionsTable)
          .set({ stepHistory: history, updatedAt: new Date() })
          .where(
            and(
              eq(flowExecutionsTable.id, executionId),
              eq(flowExecutionsTable.status, FlowStatus.Cancelled),
            ),
          );
      }
      compensated = history.some((entry) => entry.step.startsWith('compensate:'));
    }
    await closeSpineState(executionId, 'cancelled');

    if (audit) {
      await audit.record(`flow.cancelled.${row.flowName}`, {
        executionId,
        flowName: row.flowName,
        actor: opts?.actor ?? row.actor,
        compensated,
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
    const compensable = [...flow.steps]
      .reverse()
      .filter((step): step is CapabilityStep & { compensate: string } => {
        return (
          step.type === FlowStepType.Capability &&
          typeof step.compensate === 'string' &&
          step.compensate.length > 0 &&
          completed.has(step.name)
        );
      });
    if (compensable.length === 0) return;

    // Compensations run as the verified initiating identity, never as the
    // worker. A missing or invalid snapshot is recorded and left for operator
    // review, matching the step path above.
    const flowAuth = resolveFlowStepAuth(row);
    if (!flowAuth) {
      const at = new Date();
      history.push(
        buildHistoryEntry(
          'compensate',
          {
            status: StepStatus.Failed,
            error:
              'Missing or invalid flow auth snapshot; compensations require a verified caller context',
          },
          at,
          at,
        ),
      );
      if (audit) {
        await audit.record('flow.compensation_skipped', {
          executionId,
          flowName: row.flowName,
          reason: 'invalid-auth-snapshot',
          steps: compensable.map((step) => step.name),
        });
      }
      return;
    }
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
        // Bound to the flow's identity, as in a step: wakes only executions of its tenant.
        wake: (otherExecutionId: string) => wakeTimedWait(otherExecutionId, flowAuth),
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
      const result = await stepDeps.executeCapability(step.compensate, ctx, row.input);
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
    const row = await loadRow(await locateStore(executionId), executionId);
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
        (await databaseTime(storeFor(executionId))).getTime() + retryDelay(resolved, retryCount),
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
      if (spineDispatch && row.currentStep) {
        scheduledRetries.set(executionId, {
          stepId: row.currentStep,
          notBefore: wakeAt.toISOString(),
        });
      }
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
    await guardedUpdate(executionId, {
      status: FlowStatus.Completed,
      currentStep: null,
      completedAt: new Date(),
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });
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
    await guardedUpdate(executionId, {
      status: FlowStatus.Failed,
      lastError: error ?? 'Unknown error',
      completedAt: new Date(),
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    if (audit) {
      await audit.record(`flow.failed.${flowName}`, {
        executionId,
        flowName,
        error,
      });
    }
    try {
      // The dead-letter snapshot lives beside the execution, on its plane.
      await deadLetterFlow(storeFor(executionId), executionId);
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
          db: storeFor(executionId),
        });
      } catch {
        // Swallow — error logging must never break flow processing
      }
    }
  }

  /** Unguarded write; only the definition-strategy recovery path uses it. */
  async function updateExecution(id: string, updates: FlowExecutionUpdate): Promise<void> {
    await storeFor(id)
      .update(flowExecutionsTable)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(flowExecutionsTable.id, id));
  }

  /**
   * Finalize an execution as `failed` when the runner's `runNext` rejected with an
   * unhandled error, so a broken row is not re-claimed and retried on every poll.
   *
   * Only the claim that ran the step may finalize it: the write is fenced by the runner's
   * token (`leaseToken`). After lease loss or cancellation — or without a token — another
   * worker (or the operator) owns the row, so the runner only forgets its local claim and
   * hint and never acknowledges a hint another worker may hold. Returns whether the row was
   * finalized.
   */
  async function markFailedFromRunner(
    executionId: string,
    error: unknown,
    leaseToken?: string,
  ): Promise<boolean> {
    if (
      error instanceof LeaseLostError ||
      error instanceof FlowCancelledError ||
      // runNext already released the execution for a worker that has its definition.
      error instanceof FlowDefinitionUnavailableError ||
      !leaseToken
    ) {
      forgetClaim(executionId, leaseToken);
      return false;
    }
    const finalized = await claimScope.run({ id: executionId, token: leaseToken }, async () => {
      try {
        const row = await loadRow(storeFor(executionId), executionId);
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
    if (!finalized) return false;
    scheduledRetries.delete(executionId);
    await closeSpineState(executionId, 'failed');
    // The run never reached its sync: the hint this worker holds is dropped here.
    const hint = claimedHints.get(executionId);
    const tenantDb = executionStores.get(executionId);
    if (hint && tenantDb) {
      await dropSpineHint(tenantDb, hint.dispatchId);
      claimedHints.delete(executionId);
    }
    if (audit) {
      await audit.record('flow.runner.finalized', {
        executionId,
        workerId,
        error: error instanceof Error ? error.message : 'Runner failed',
      });
    }
    return true;
  }

  /**
   * Give up a claim this engine holds without finishing or failing the execution: the row
   * stays `running` with its lease expired now (claimable by any worker's next poll) and the
   * spine hint this engine holds for it, if any, is ready again. A worker that stops between
   * steps uses this so the execution continues elsewhere at once instead of after the lease
   * runs out. Fenced by the claim token; a claim already lost is only forgotten. Returns
   * whether the row was released.
   */
  async function releaseClaim(executionId: string, leaseToken?: string): Promise<boolean> {
    const token = leaseToken ?? claims.get(executionId);
    if (!token) {
      forgetClaim(executionId);
      return false;
    }
    const result = await storeFor(executionId)
      .update(flowExecutionsTable)
      .set({
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: sql`now()`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(flowExecutionsTable.id, executionId),
          eq(flowExecutionsTable.leaseOwner, workerId),
          eq(flowExecutionsTable.leaseToken, token),
          eq(flowExecutionsTable.status, FlowStatus.Running),
        ),
      );
    const hint = claimedHints.get(executionId);
    if (spineDispatch && hint) {
      await releaseSpineDispatch(spineDispatch.db, { dispatchId: hint.dispatchId, workerId });
    }
    forgetClaim(executionId, token);
    return getRowsAffected(result) > 0;
  }

  /** Drops this engine's local claim state for an execution it no longer owns. */
  function forgetClaim(executionId: string, leaseToken?: string): void {
    if (!leaseToken || claims.get(executionId) === leaseToken) claims.delete(executionId);
    claimedHints.delete(executionId);
    scheduledRetries.delete(executionId);
  }

  /**
   * Update execution under the current claim. The write is fenced by owner, claim token,
   * `status = 'running'` and an unexpired lease; when it matches nothing the claim is lost
   * and `LeaseLostError` is thrown. A transition into a wait keeps the claim token on the row
   * as the wait's generation (resumes are fenced by it).
   */
  async function guardedUpdate(id: string, updates: FlowExecutionUpdate): Promise<boolean> {
    const claim = claimScope.getStore();
    if (!claim || claim.id !== id)
      throw new LeaseLostError('Missing flow claim', { executionId: id });
    const result = await storeFor(id)
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

  /** Acknowledges a hint on the spine and closes the outbox row behind it on the plane. */
  async function dropSpineHint(tenantDb: PostgresJsDatabase, dispatchId: string): Promise<boolean> {
    if (!spineDispatch) return false;
    const acknowledged = await ackSpineDispatch(spineDispatch.db, dispatchId, workerId);
    if (!acknowledged) return false;
    try {
      await markOutboxAckedBySpineRow(
        tenantDb,
        dispatchId,
        new Date().toISOString(),
        durableSchema,
      );
    } catch (error) {
      logger?.warn('acknowledged spine hint left its outbox row open', {
        dispatchId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  /**
   * A terminal transition taken outside the run loop — an operator cancel, the runner
   * finalising a run that threw — leaves the tenant's durable state open and, possibly, a
   * hint on the spine. Close the state so the next claim drops the hint. Rows on the engine's
   * own database (classic placement, control-plane flows) carry no durable state.
   */
  async function closeSpineState(
    executionId: string,
    status: 'cancelled' | 'failed',
  ): Promise<void> {
    if (!spineDispatch) return;
    const store = await locateStore(executionId);
    if (store === spineDispatch.db) return;
    try {
      await markExecutionStateTerminal(
        store,
        { executionId, status, nowIso: new Date().toISOString() },
        durableSchema,
      );
    } catch (error) {
      logger?.warn('could not close the durable state of a finished execution', {
        executionId,
        status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * A wake (`ctx.flows.wake`) that lands between a run's wait and the retry schedule this run
   * then persists and publishes moves the row's wake time but finds no durable wait or hint of
   * the new revision to move yet, and the hint is then published with the original time. Read
   * the row after publishing: when it is still the wait this run wrote (its claim token is the
   * wait's generation) and its wake time is earlier than the one scheduled, make the durable
   * wait and hint of the revision this run scheduled due as the wake did. A later wait — the
   * execution woke, ran again and entered another one meanwhile — has another token and
   * revision, and is that run's to carry.
   */
  async function carryEarlierWake(
    tenantDb: PostgresJsDatabase,
    executionId: string,
    wait: { token: string; revision: number; scheduledFor: string },
  ): Promise<void> {
    if (!spineDispatch) return;
    const current = await loadWaitRow(tenantDb, executionId);
    if (
      !current ||
      current.status !== FlowStatus.Waiting ||
      current.waitingForEvent !== null ||
      current.leaseToken !== wait.token ||
      !current.wakeAt ||
      current.wakeAt.getTime() >= Date.parse(wait.scheduledFor)
    ) {
      return;
    }
    const target = await advanceExecutionWakeOnDb(tenantDb, executionId, durableSchema, {
      expectedRevision: wait.revision,
    });
    if (!target) return;
    await advanceSpineDispatchNotBefore(spineDispatch.db, {
      executionId,
      tenantRouteId: target.tenantRef,
      expectedRevision: target.revision,
    });
  }

  /** `claimToken`: the claim this run held, which a wait it entered carries as its generation. */
  async function syncSpineAfterRun(
    executionId: string,
    result: FlowExecution,
    claimToken: string,
  ): Promise<void> {
    if (!spineDispatch) return;
    const hint = claimedHints.get(executionId);
    const tenantDb = executionStores.get(executionId);
    if (!hint || !tenantDb) return;
    const nowIso = new Date().toISOString();
    const retry = scheduledRetries.get(executionId);
    if (retry) {
      try {
        const scheduled = await persistRetryScheduleOnDb(
          tenantDb,
          {
            executionId,
            expectedRevision: hint.expectedRevision,
            tenantEpoch: hint.tenantEpoch,
            stepId: retry.stepId,
            notBefore: retry.notBefore,
          },
          nowIso,
          durableSchema,
        );
        await dropSpineHint(tenantDb, hint.dispatchId);
        claimedHints.delete(executionId);
        if (scheduled.kind !== 'committed' || !scheduled.outbox) return;
        await publishOutboxToSpine(
          tenantDb,
          spineDispatch.db,
          scheduled.outbox,
          `disp:${executionId}:${scheduled.execution.revision}`,
          nowIso,
          durableSchema,
          { deliveryState: SpineDeliveryState.RetryScheduled },
        );
        try {
          await carryEarlierWake(tenantDb, executionId, {
            token: claimToken,
            revision: scheduled.execution.revision,
            scheduledFor: retry.notBefore,
          });
        } catch (error) {
          logger?.warn('could not carry a wake over to the hint just published', {
            executionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      } finally {
        scheduledRetries.delete(executionId);
      }
    }
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
    await dropSpineHint(tenantDb, hint.dispatchId);
    claimedHints.delete(executionId);
    if (cas !== 'ok' || terminal) return;
    const advanced = await loadExecutionState(tenantDb, executionId, durableSchema);
    if (!advanced || advanced.terminal || !flowRow?.currentStep) return;
    const nextStep = flowRow.currentStep;
    const outbox = await insertDispatchOutbox(tenantDb, advanced, nextStep, nowIso, durableSchema);
    // The worker that ran this step drains the next one without claiming again, so the hint
    // for it is born under this worker's lease; a worker that dies mid-drain lets it lapse
    // and another claims it. Keeping the hint lets the next sync advance the durable state.
    const next = await publishOutboxToSpine(
      tenantDb,
      spineDispatch.db,
      outbox,
      `disp:${executionId}:${advanced.revision}`,
      nowIso,
      durableSchema,
      { workerId, leaseExpiresAt: new Date(Date.now() + leaseDurationMs).toISOString() },
    );
    claimedHints.set(executionId, next);
  }

  async function applyDefinitionStrategy(
    executionId: string,
    strategy: string,
  ): Promise<{ strategy: DefinitionInFlightStrategyName; applied: true }> {
    assertSupportedDefinitionStrategy(strategy);

    const row = await loadRow(await locateStore(executionId), executionId);
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
    createExecution,
    announceExecution,
    wake: maybeEnqueueFlowStep,
    runNext,
    resume,
    resumeWaitingByEvent,
    wakeTimedWait,
    listRunnable,
    claimNext,
    claimExecution,
    cancel,
    terminate,
    status,
    markFailedFromRunner,
    releaseClaim,
    applyDefinitionStrategy,
    get workerId() {
      return workerId;
    },
    /**
     * True when tenant-authenticated executions are placed on the tenant's plane (spine
     * dispatch): their acceptance and hint let this engine claim them there. Without spine
     * dispatch every execution lives on, and is claimed from, `db`.
     */
    get placesTenantExecutions() {
      return Boolean(spineDispatch);
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
