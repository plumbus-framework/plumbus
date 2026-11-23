import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import {
  bindAuditServiceToTransaction,
  isTransactionBindableAuditService,
  recordAfterEffects,
  recordAuditBatch,
  type TransactionAuditBinding,
} from '../audit/index.js';
import type { EntityRegistry } from '../data/registry.js';
import { createErrorService } from '../errors/index.js';
import { createEventEmitter } from '../events/emitter.js';
import type { EventRegistry } from '../events/registry.js';
import type { AuditBatchEntry, AuditService } from '../types/audit.js';
import type { CapabilityContract } from '../types/capability.js';
import type {
  DataService,
  EventService,
  ExecutionContext,
  TransactionRunOptions,
  TransactionScope,
  WithTransactionFn,
} from '../types/context.js';
import { CapabilityKind } from '../types/enums.js';
import { createDeferredTransaction } from './deferred-transaction.js';
import { DEFAULT_TRANSACTION_ACQUIRE_TIMEOUT_MS } from './transaction-defaults.js';

export interface DurableDispatchRunnerConfig {
  /** Schema for Protocol A tables. Default `core_plumbus`. */
  schemaName?: string;
}

export interface TransactionRunnerConfig {
  db: PostgresJsDatabase;
  entities: EntityRegistry;
  events: EventRegistry;
  getAuth: () => import('../types/security.js').AuthContext;
  getAudit: () => AuditService;
  getCausationId?: () => string | undefined;
  correlationId?: string;
  bypassTenantScope?: boolean;
  encryptionKey?: Buffer;
  /**
   * When set, the transaction scope can write `dispatch_outbox` (and
   * persist-before-ack acceptance) in the same tenant transaction. Omitted,
   * the runner is unchanged: handler + `event_outbox` only.
   */
  durableDispatch?: DurableDispatchRunnerConfig;
  /**
   * The request's own pool-bound data service, reused for reads made before a lazily opened
   * transaction opens. Omitted, the runner builds one from `entities` when first needed.
   */
  getOuterData?: () => DataService;
}

/** Repository methods that only read: before the transaction opens they run on the pool. */
const READ_METHODS = new Set([
  'findById',
  'findMany',
  'findManyFields',
  'findPage',
  'count',
  'exists',
  'aggregate',
]);

/** Repository methods that write: the first one opens a lazily opened transaction. */
const WRITE_METHODS = [
  'create',
  'createMany',
  'update',
  'updateWhere',
  'delete',
  'deleteMany',
  'updateMany',
] as const;

const auditOutcomeSchema = z.enum(['success', 'failure', 'denied']);

/**
 * Build a `withTransaction` hook that runs work inside `db.transaction`,
 * providing tx-scoped data + events.
 *
 * When it opens: `withTransaction(fn)` (or `{ begin: 'eager' }`) opens the transaction before
 * `fn` runs, as it always did. `{ begin: 'lazy' }` opens it at the first use of the scope that
 * needs it — a data write, an event, a durable flow start or job (`scope.acquire()`), durable
 * dispatch — and not at all when `fn` needs none. Until then reads run on the pool, outside the
 * transaction; from then on everything, reads included, runs in it. Whatever was written in it
 * commits when `fn` returns and rolls back when `fn` throws, exactly as with an eager open.
 * `acquireTimeoutMs` bounds the wait for the pool connection BEGIN needs
 * (`DataPoolAcquireTimeoutError` past it).
 *
 * Audit: when the outer audit service is the default database-backed one, the scope gets an
 * audit service bound to the transaction (`scope.audit`), so audit rows use the transaction's
 * connection and commit with the data they describe — a second pool connection per
 * transaction deadlocks a saturated pool. `failure`/`denied` rows of a transaction that rolls
 * back are written again through the outer writer once the connection is released; `success`
 * rows roll back with the work. After the transaction ends, the bound service writes through
 * the outer writer (post-commit callbacks). A custom audit service stays on the outer path.
 * Before a lazy transaction opens, `success` rows are held: written into the transaction when
 * it opens, through the outer writer when `fn` returns without opening it, dropped when `fn`
 * throws — the outcome an eager transaction gives them. `failure`/`denied` rows are written at
 * once.
 */
export function createTransactionRunner(config: TransactionRunnerConfig): WithTransactionFn {
  const {
    db,
    entities,
    events: eventRegistry,
    getAuth,
    getAudit,
    getCausationId,
    correlationId,
    bypassTenantScope,
    encryptionKey,
    durableDispatch,
  } = config;

  function durableWriters(
    acquire: () => Promise<PostgresJsDatabase>,
  ): Pick<TransactionScope, 'persistAcceptance' | 'enqueueDispatch'> {
    if (!durableDispatch) return {};
    const schemaName = durableDispatch.schemaName;
    return {
      persistAcceptance: async (input) => {
        const tx = await acquire();
        const { persistAcceptanceOnDb } = await import('../durable/postgres-persist.js');
        const result = await persistAcceptanceOnDb(
          tx,
          {
            executionId: input.executionId,
            tenantRef: input.tenantRef,
            definitionId: input.definitionId,
            definitionVersion: input.definitionVersion,
            firstStepId: input.firstStepId,
            correlationId: input.correlationId,
            nowIso: input.nowIso ?? new Date().toISOString(),
          },
          schemaName,
        );
        return { executionId: result.execution.executionId, outboxId: result.outbox.outboxId };
      },
      enqueueDispatch: async (input) => {
        const tx = await acquire();
        const { insertDispatchOutbox } = await import('../durable/postgres-persist.js');
        const nowIso = input.nowIso ?? new Date().toISOString();
        const outbox = await insertDispatchOutbox(
          tx,
          {
            executionId: input.executionId,
            stateRefId: input.stateRefId,
            tenantRef: input.tenantRef,
            revision: input.revision,
            tenantEpoch: input.tenantEpoch,
            status: 'running',
            definitionId: input.definitionId,
            definitionVersion: input.definitionVersion,
            currentStepId: input.stepId,
            stepIndex: 0,
            attempt: 0,
            correlationId: input.correlationId,
            createdAt: nowIso,
            updatedAt: nowIso,
            terminal: false,
          },
          input.stepId,
          nowIso,
          schemaName,
        );
        return { outboxId: outbox.outboxId };
      },
    };
  }

  /** One run's scope, the transaction behind it, and how the run ends. */
  function createRun(acquireTimeoutMs: number | undefined) {
    const auth = getAuth();
    const outerAudit = getAudit();
    const transaction = createDeferredTransaction(db, acquireTimeoutMs);
    const bindable = isTransactionBindableAuditService(outerAudit);
    const heldSuccess: AuditBatchEntry[] = [];
    const opened: {
      tx?: PostgresJsDatabase;
      binding?: TransactionAuditBinding;
      data?: DataService;
      events?: EventService;
    } = {};
    let bound: Promise<PostgresJsDatabase> | undefined;

    function acquire(): Promise<PostgresJsDatabase> {
      bound ??= (async () => {
        const tx = await transaction.open();
        const binding = bindAuditServiceToTransaction(outerAudit, tx);
        const audit = binding?.audit ?? outerAudit;
        opened.binding = binding;
        opened.data = entities.createDataService({
          db: tx,
          auth,
          audit,
          bypassTenantScope,
          encryptionKey,
        });
        opened.events = createEventEmitter({
          db: tx,
          auth,
          registry: eventRegistry,
          audit,
          correlationId,
          getCausationId,
        });
        opened.tx = tx;
        // Success records made before the open now commit or roll back with the work.
        await recordAuditBatch(audit, heldSuccess.splice(0));
        return tx;
      })();
      bound.catch(() => undefined);
      return bound;
    }
    const started = () => bound !== undefined && transaction.started();

    async function inTransaction(): Promise<{ data: DataService; events: EventService }> {
      await acquire();
      return { data: opened.data as DataService, events: opened.events as EventService };
    }

    // Reads before the open use a pool-bound data service; built only when one is needed.
    let poolData: DataService | undefined;
    const outerData = () => {
      poolData ??=
        config.getOuterData?.() ??
        entities.createDataService({
          db,
          auth,
          audit: outerAudit,
          bypassTenantScope,
          encryptionKey,
        });
      return poolData;
    };
    const data = routeDataService(entities, outerData, inTransaction, started);

    function events(traceparent?: string): EventService {
      const rebind = async () => {
        const base = (await inTransaction()).events;
        return traceparent === undefined ? base : (base.withTraceparent?.(traceparent) ?? base);
      };
      return {
        withTraceparent: (next) => events(next),
        async emit(eventName, payload) {
          await (await rebind()).emit(eventName, payload);
        },
        async emitMany(batch) {
          if (batch.length === 0) return;
          await (await rebind()).emitMany(batch);
        },
      };
    }

    /** Whether an entry is a `success` record (held until the transaction opens). */
    const isSuccess = (entry: AuditBatchEntry): boolean => {
      const outcome = auditOutcomeSchema.safeParse(entry.metadata?.outcome ?? 'success');
      if (!outcome.success) throw createErrorService().validation('Invalid audit outcome');
      return outcome.data === 'success';
    };

    const audit: AuditService = bindable
      ? {
          async record(eventType, metadata) {
            if (started()) {
              await acquire();
              const live = opened.binding?.audit ?? outerAudit;
              return live.record(eventType, metadata);
            }
            if (isSuccess({ eventType, metadata })) {
              heldSuccess.push({ eventType, metadata });
              return;
            }
            // A refusal or failure stands whatever happens to the work.
            return outerAudit.record(eventType, metadata);
          },
          async recordMany(entries) {
            if (started()) {
              await acquire();
              return recordAuditBatch(opened.binding?.audit ?? outerAudit, entries);
            }
            const others: AuditBatchEntry[] = [];
            for (const entry of entries) {
              if (isSuccess(entry)) heldSuccess.push(entry);
              else others.push(entry);
            }
            return recordAuditBatch(outerAudit, others);
          },
        }
      : outerAudit;

    const scope: TransactionScope = {
      data,
      events: events(),
      audit,
      planeDb: db,
      acquire,
      isOpen: started,
      ...durableWriters(acquire),
    };
    Object.defineProperty(scope, 'db', {
      enumerable: true,
      get: () => opened.tx,
    });

    return {
      scope,
      acquire,
      /**
       * Open now and hand out the transaction's own data, events and audit, as an eagerly
       * opened scope always did (no routing, nothing held back).
       */
      async openEagerly(): Promise<void> {
        await acquire();
        scope.data = opened.data as DataService;
        scope.events = opened.events as EventService;
        scope.audit = opened.binding?.audit ?? outerAudit;
      },
      /** `fn` returned: commit what was opened, or write the held success records. */
      async succeeded(): Promise<void> {
        if (!bound) {
          // Nothing was opened, so nothing commits with these records; the work they describe
          // (outside the framework's transaction) is done. Never fail the call for them: they
          // are retried in the background and reported if they cannot be written.
          await recordAfterEffects(outerAudit, heldSuccess.splice(0));
          return;
        }
        await bound;
        await transaction.commit();
        await opened.binding?.committed();
      },
      /** `fn` (or the commit) failed: roll back what was opened; held success records go. */
      async failed(): Promise<void> {
        heldSuccess.length = 0;
        if (!bound) return;
        await transaction.rollback();
        // Rolled back and the connection released: keep the failure/denied records.
        await opened.binding?.rolledBack();
      },
    };
  }

  return async <T>(
    fn: (scope: TransactionScope) => Promise<T>,
    options?: TransactionRunOptions,
  ): Promise<T> => {
    const deferred: Array<() => Promise<void>> = [];
    const run = createRun(options?.acquireTimeoutMs);
    run.scope.deferred = deferred;
    let result: T;
    try {
      if (options?.begin !== 'lazy') await run.openEagerly();
      result = await fn(run.scope);
      await run.succeeded();
    } catch (err) {
      await run.failed();
      throw err;
    }
    // Post-commit callbacks must not fail the already-committed capability or
    // skip remaining work (flows/jobs/audits). Isolate each callback.
    for (const callback of deferred) {
      try {
        await callback();
      } catch (err) {
        console.error('[plumbus] deferred post-commit callback failed', err);
      }
    }
    return result;
  };
}

/**
 * A data service whose reads run on the pool until the transaction has started and whose
 * writes start it. Built over the entity names of `entities` (or of the pool data service,
 * for a registry stand-in that cannot list them).
 */
function routeDataService(
  entities: EntityRegistry,
  outerData: () => DataService,
  inTransaction: () => Promise<{ data: DataService }>,
  started: () => boolean,
): DataService {
  const names =
    typeof entities.getAllEntities === 'function'
      ? entities.getAllEntities().map((entity) => entity.name)
      : Object.keys(outerData());
  const call = (service: DataService, name: string, method: string, args: unknown[]) => {
    const repo = (service as unknown as Record<string, Record<string, unknown>>)[name];
    return (repo?.[method] as (...a: unknown[]) => unknown)(...args);
  };
  const routed: Record<string, Record<string, unknown>> = {};
  for (const name of names) {
    const repo: Record<string, unknown> = {};
    for (const method of READ_METHODS) {
      repo[method] = (...args: unknown[]) =>
        started()
          ? inTransaction().then(({ data }) => call(data, name, method, args))
          : call(outerData(), name, method, args);
    }
    for (const method of WRITE_METHODS) {
      repo[method] = (...args: unknown[]) =>
        inTransaction().then(({ data }) => call(data, name, method, args));
    }
    routed[name] = repo;
  }
  return routed as unknown as DataService;
}

function readTransactionalOutboxKillSwitch(ctx: ExecutionContext): boolean {
  const execution = (ctx.config as { execution?: { transactionalOutbox?: boolean } }).execution;
  return execution?.transactionalOutbox === false;
}

/**
 * Whether executeCapability should wrap handler + output validation in a transaction.
 * Default ON for action/eventHandler; auto-excludes AI effects and job kind. `transactional:
 * 'lazy' | 'eager'` changes only when that transaction opens, never whether there is one.
 */
export function shouldUseTransactionalOutbox(
  capability: CapabilityContract,
  ctx: ExecutionContext,
): boolean {
  if (capability.transactional === false) {
    return false;
  }
  if (readTransactionalOutboxKillSwitch(ctx)) {
    return false;
  }
  if (capability.kind === CapabilityKind.Job) {
    return false;
  }
  if (capability.effects.ai === true) {
    return false;
  }
  if ((capability.effects.external ?? []).length > 0) {
    return false;
  }
  return (
    capability.kind === CapabilityKind.Action || capability.kind === CapabilityKind.EventHandler
  );
}

/**
 * How `executeCapability` opens a capability's transaction: the capability's own
 * `transactional: 'lazy' | 'eager'`, else `execution.transactionBegin`, else `'lazy'`; and the
 * wait for a pool connection from `execution.transactionAcquireTimeoutMs` (default 10 000 ms,
 * `0` for no limit).
 */
export function resolveTransactionRunOptions(
  capability: CapabilityContract,
  ctx: ExecutionContext,
): TransactionRunOptions {
  const execution = (
    ctx.config as
      | { execution?: { transactionBegin?: unknown; transactionAcquireTimeoutMs?: unknown } }
      | undefined
  )?.execution;
  const begin =
    capability.transactional === 'lazy' || capability.transactional === 'eager'
      ? capability.transactional
      : execution?.transactionBegin === 'eager'
        ? 'eager'
        : 'lazy';
  const configured = execution?.transactionAcquireTimeoutMs;
  const acquireTimeoutMs =
    typeof configured === 'number' && Number.isInteger(configured) && configured >= 0
      ? configured
      : DEFAULT_TRANSACTION_ACQUIRE_TIMEOUT_MS;
  return { begin, acquireTimeoutMs };
}

/** Thrown inside a transaction to roll back on invalid handler output. */
export class CapabilityOutputValidationError extends Error {
  readonly issues: unknown;

  constructor(issues: unknown) {
    super('Invalid output from capability');
    this.name = 'CapabilityOutputValidationError';
    this.issues = issues;
  }
}
