import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { bindAuditServiceToTransaction, type TransactionAuditBinding } from '../audit/index.js';
import type { EntityRegistry } from '../data/registry.js';
import { createEventEmitter } from '../events/emitter.js';
import type { EventRegistry } from '../events/registry.js';
import type { AuditService } from '../types/audit.js';
import type { CapabilityContract } from '../types/capability.js';
import type { ExecutionContext, TransactionScope, WithTransactionFn } from '../types/context.js';
import { CapabilityKind } from '../types/enums.js';

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
}

/**
 * Build a `withTransaction` hook that runs work inside `db.transaction`,
 * providing tx-scoped data + events.
 *
 * Audit: when the outer audit service is the default database-backed one, the scope gets an
 * audit service bound to the transaction (`scope.audit`), so audit rows use the transaction's
 * connection and commit with the data they describe — a second pool connection per
 * transaction deadlocks a saturated pool. `failure`/`denied` rows of a transaction that rolls
 * back are written again through the outer writer once the connection is released; `success`
 * rows roll back with the work. After the transaction ends, the bound service writes through
 * the outer writer (post-commit callbacks). A custom audit service stays on the outer path.
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

  function createScope(tx: PostgresJsDatabase, audit: AuditService): TransactionScope {
    const auth = getAuth();
    const data = entities.createDataService({
      db: tx,
      auth,
      audit,
      bypassTenantScope,
      encryptionKey,
    });
    const events = createEventEmitter({
      db: tx,
      auth,
      registry: eventRegistry,
      audit,
      correlationId,
      getCausationId,
    });
    const scope: TransactionScope = { data, events, audit, db: tx, planeDb: db };
    if (durableDispatch) {
      const schemaName = durableDispatch.schemaName;
      scope.persistAcceptance = async (input) => {
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
      };
      scope.enqueueDispatch = async (input) => {
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
      };
    }
    return scope;
  }

  return async <T>(fn: (scope: TransactionScope) => Promise<T>): Promise<T> => {
    const deferred: Array<() => Promise<void>> = [];
    const auditState: { binding?: TransactionAuditBinding } = {};
    let result: T;
    try {
      result = await db.transaction(async (tx) => {
        const outerAudit = getAudit();
        const binding = bindAuditServiceToTransaction(outerAudit, tx);
        auditState.binding = binding;
        const scope = createScope(tx, binding?.audit ?? outerAudit);
        scope.deferred = deferred;
        return fn(scope);
      });
    } catch (err) {
      // Rolled back and the connection released: keep the failure/denied records.
      await auditState.binding?.rolledBack();
      throw err;
    }
    await auditState.binding?.committed();
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

function readTransactionalOutboxKillSwitch(ctx: ExecutionContext): boolean {
  const execution = (ctx.config as { execution?: { transactionalOutbox?: boolean } }).execution;
  return execution?.transactionalOutbox === false;
}

/**
 * Whether executeCapability should wrap handler + output validation in a transaction.
 * Default ON for action/eventHandler; auto-excludes AI effects and job kind.
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

/** Thrown inside a transaction to roll back on invalid handler output. */
export class CapabilityOutputValidationError extends Error {
  readonly issues: unknown;

  constructor(issues: unknown) {
    super('Invalid output from capability');
    this.name = 'CapabilityOutputValidationError';
    this.issues = issues;
  }
}
