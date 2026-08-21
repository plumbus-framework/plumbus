import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
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
 * providing tx-scoped data + events while audit stays on the outer db.
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

  function createScope(tx: PostgresJsDatabase): TransactionScope {
    const auth = getAuth();
    const audit = getAudit();
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
    const scope: TransactionScope = { data, events };
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
    const result = await db.transaction(async (tx) => {
      const scope = createScope(tx);
      scope.deferred = deferred;
      return fn(scope);
    });
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
