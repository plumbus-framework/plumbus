// Tenant-local Protocol A writes against real Postgres. Same CAS + outbox
// pairing as persist-before-ack.ts; used by the flow engine when spineDispatch
// is configured.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { FRAMEWORK_SCHEMA } from '../data/schema-generator.js';
import { PlumbusError } from '../errors/index.js';
import { qualifyTable } from './apply-ddl.js';
import { createOpaqueDispatchRecord } from './opaque-dispatch.js';
import type { PersistStepResult, RetryScheduleInput } from './persist-before-ack.js';
import { upsertSpineDispatch } from './spine-claim.js';
import {
  DEFAULT_PRIORITY_CLASS_ID,
  DEFAULT_WORK_CLASS_ID,
  type DispatchOutboxRow,
  DurableExecutionStatus,
  type OpaqueDispatchRecord,
  SpineDeliveryState,
  type TenantExecutionState,
} from './types.js';

function asRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  return [];
}

function toIso(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return String(value);
}

function requiredIso(value: unknown, field: string): string {
  const instant = toIso(value);
  if (instant === undefined)
    throw new PlumbusError('internal', 'Durable record is missing a required timestamp', { field });
  return instant;
}

function mapExecution(row: Record<string, unknown>): TenantExecutionState {
  return {
    executionId: String(row.execution_id),
    stateRefId: String(row.state_ref_id),
    tenantRef: String(row.tenant_ref),
    revision: Number(row.revision),
    tenantEpoch: Number(row.tenant_epoch),
    status: row.status as TenantExecutionState['status'],
    definitionId: String(row.definition_id),
    definitionVersion: String(row.definition_version),
    currentStepId: String(row.current_step_id),
    stepIndex: Number(row.step_index),
    attempt: Number(row.attempt),
    correlationId: String(row.correlation_id),
    createdAt: requiredIso(row.created_at, 'created_at'),
    updatedAt: requiredIso(row.updated_at, 'updated_at'),
    wakeAt: toIso(row.wake_at),
    terminal: Boolean(row.terminal),
  };
}

function mapOutbox(row: Record<string, unknown>): DispatchOutboxRow {
  return {
    outboxId: String(row.outbox_id),
    executionId: String(row.execution_id),
    stateRefId: String(row.state_ref_id),
    expectedRevision: Number(row.expected_revision),
    tenantEpoch: Number(row.tenant_epoch),
    tenantRef: String(row.tenant_ref),
    stepId: String(row.step_id),
    definitionId: String(row.definition_id),
    definitionVersion: String(row.definition_version),
    correlationId: String(row.correlation_id),
    workClassId: String(row.work_class_id),
    priorityClassId: String(row.priority_class_id),
    notBefore: requiredIso(row.not_before, 'not_before'),
    createdAt: requiredIso(row.created_at, 'created_at'),
    publishedAt: toIso(row.published_at),
    spineRowId: row.spine_row_id == null ? undefined : String(row.spine_row_id),
    spineAckedAt: toIso(row.spine_acked_at),
    superseded: Boolean(row.superseded),
  };
}

export async function loadExecutionState(
  db: PostgresJsDatabase,
  executionId: string,
  schemaName: string = FRAMEWORK_SCHEMA,
): Promise<TenantExecutionState | undefined> {
  const table = qualifyTable(schemaName, 'execution_state');
  const result = await db.execute(
    sql`SELECT * FROM ${sql.raw(table)} WHERE execution_id = ${executionId} LIMIT 1`,
  );
  const row = asRows(result)[0];
  return row ? mapExecution(row) : undefined;
}

export async function persistAcceptanceOnDb(
  db: PostgresJsDatabase,
  input: {
    executionId: string;
    tenantRef: string;
    definitionId: string;
    definitionVersion: string;
    firstStepId: string;
    correlationId: string;
    nowIso: string;
  },
  schemaName: string = FRAMEWORK_SCHEMA,
): Promise<{ execution: TenantExecutionState; outbox: DispatchOutboxRow }> {
  const executionTable = qualifyTable(schemaName, 'execution_state');
  const outboxTable = qualifyTable(schemaName, 'dispatch_outbox');
  const stateRefId = `state:${input.executionId}`;
  const outboxId = `outbox:${input.executionId}:1:${randomUUID()}`;

  await db.execute(sql`
    INSERT INTO ${sql.raw(executionTable)} (
      execution_id, state_ref_id, tenant_ref, revision, tenant_epoch, status,
      definition_id, definition_version, current_step_id, step_index, attempt,
      correlation_id, created_at, updated_at, terminal
    ) VALUES (
      ${input.executionId}, ${stateRefId}, ${input.tenantRef}, 1, 1, ${DurableExecutionStatus.Created},
      ${input.definitionId}, ${input.definitionVersion}, ${input.firstStepId}, 0, 0,
      ${input.correlationId}, ${input.nowIso}::timestamptz, ${input.nowIso}::timestamptz, false
    )
    ON CONFLICT (execution_id) DO NOTHING
  `);

  await db.execute(sql`
    INSERT INTO ${sql.raw(outboxTable)} (
      outbox_id, execution_id, state_ref_id, expected_revision, tenant_epoch,
      tenant_ref, step_id, definition_id, definition_version, correlation_id,
      work_class_id, priority_class_id, not_before, created_at, superseded
    ) VALUES (
      ${outboxId}, ${input.executionId}, ${stateRefId}, 1, 1,
      ${input.tenantRef}, ${input.firstStepId}, ${input.definitionId}, ${input.definitionVersion},
      ${input.correlationId}, ${DEFAULT_WORK_CLASS_ID}, ${DEFAULT_PRIORITY_CLASS_ID},
      ${input.nowIso}::timestamptz, ${input.nowIso}::timestamptz, false
    )
    ON CONFLICT (outbox_id) DO NOTHING
  `);

  const execution = await loadExecutionState(db, input.executionId, schemaName);
  if (!execution) throw new Error('persistAcceptanceOnDb wrote no execution_state');
  const outboxRows = asRows(
    await db.execute(
      sql`SELECT * FROM ${sql.raw(outboxTable)} WHERE execution_id = ${input.executionId} AND expected_revision = 1 LIMIT 1`,
    ),
  );
  const outbox = outboxRows[0] ? mapOutbox(outboxRows[0]) : undefined;
  if (!outbox) throw new Error('persistAcceptanceOnDb wrote no dispatch_outbox');
  return { execution, outbox };
}

export async function casAdvanceExecution(
  db: PostgresJsDatabase,
  input: {
    executionId: string;
    expectedRevision: number;
    nextStatus: TenantExecutionState['status'];
    nextStepId: string;
    terminal: boolean;
    nowIso: string;
    sideEffectKey?: string;
    sideEffectLabel?: string;
  },
  schemaName: string = FRAMEWORK_SCHEMA,
): Promise<'ok' | 'stale' | 'missing'> {
  const executionTable = qualifyTable(schemaName, 'execution_state');
  const result = await db.execute(sql`
    UPDATE ${sql.raw(executionTable)}
    SET revision = ${input.expectedRevision + 1},
        status = ${input.nextStatus},
        current_step_id = ${input.nextStepId},
        step_index = step_index + 1,
        terminal = ${input.terminal},
        updated_at = ${input.nowIso}::timestamptz,
        wake_at = NULL
    WHERE execution_id = ${input.executionId}
      AND revision = ${input.expectedRevision}
      AND terminal = false
    RETURNING execution_id
  `);
  if (asRows(result).length === 0) {
    const existing = await loadExecutionState(db, input.executionId, schemaName);
    return existing ? 'stale' : 'missing';
  }
  if (input.sideEffectKey && input.sideEffectLabel) {
    const effects = qualifyTable(schemaName, 'side_effect_log');
    await db.execute(sql`
      INSERT INTO ${sql.raw(effects)} (effect_key, label, applied_at)
      VALUES (${input.sideEffectKey}, ${input.sideEffectLabel}, ${input.nowIso}::timestamptz)
      ON CONFLICT (effect_key) DO NOTHING
    `);
  }
  return 'ok';
}

/**
 * Persist a retry delay on the tenant plane before the current spine hint is acknowledged.
 * The execution-state CAS, retry wait, and future-dated outbox row are one transaction.
 */
export async function persistRetryScheduleOnDb(
  db: PostgresJsDatabase,
  input: RetryScheduleInput,
  nowIso: string,
  schemaName: string = FRAMEWORK_SCHEMA,
): Promise<PersistStepResult> {
  const executionTable = qualifyTable(schemaName, 'execution_state');
  const waitTable = qualifyTable(schemaName, 'wait_state');
  const outboxTable = qualifyTable(schemaName, 'dispatch_outbox');

  return db.transaction(async (tx) => {
    const scoped = tx as unknown as PostgresJsDatabase;
    const current = await loadExecutionState(scoped, input.executionId, schemaName);
    if (!current) return { kind: 'missing' };
    if (current.tenantEpoch !== input.tenantEpoch) return { kind: 'epoch-mismatch' };
    if (current.revision !== input.expectedRevision || current.terminal) {
      return { kind: 'stale', execution: current };
    }

    const updated = asRows(
      await scoped.execute(sql`
        UPDATE ${sql.raw(executionTable)}
        SET revision = ${input.expectedRevision + 1},
            status = ${DurableExecutionStatus.RetryScheduled},
            current_step_id = ${input.stepId},
            attempt = attempt + 1,
            wake_at = ${input.notBefore}::timestamptz,
            updated_at = ${nowIso}::timestamptz,
            terminal = false
        WHERE execution_id = ${input.executionId}
          AND revision = ${input.expectedRevision}
          AND tenant_epoch = ${input.tenantEpoch}
          AND terminal = false
        RETURNING *
      `),
    );
    const nextRow = updated[0];
    if (!nextRow) {
      const latest = await loadExecutionState(scoped, input.executionId, schemaName);
      return latest ? { kind: 'stale', execution: latest } : { kind: 'missing' };
    }
    const next = mapExecution(nextRow);
    const waitStateId = `wait:${input.executionId}:${next.revision}`;
    await scoped.execute(sql`
      INSERT INTO ${sql.raw(waitTable)} (
        wait_state_id, execution_id, step_id, kind, state,
        created_at, updated_at, not_before
      ) VALUES (
        ${waitStateId}, ${input.executionId}, ${input.stepId}, 'retry', 'waiting',
        ${nowIso}::timestamptz, ${nowIso}::timestamptz, ${input.notBefore}::timestamptz
      )
      ON CONFLICT (wait_state_id) DO NOTHING
    `);

    const outboxId = `outbox:${input.executionId}:${next.revision}:${randomUUID()}`;
    const inserted = asRows(
      await scoped.execute(sql`
        INSERT INTO ${sql.raw(outboxTable)} (
          outbox_id, execution_id, state_ref_id, expected_revision, tenant_epoch,
          tenant_ref, step_id, definition_id, definition_version, correlation_id,
          work_class_id, priority_class_id, not_before, created_at, superseded
        ) VALUES (
          ${outboxId}, ${next.executionId}, ${next.stateRefId}, ${next.revision},
          ${next.tenantEpoch}, ${next.tenantRef}, ${input.stepId}, ${next.definitionId},
          ${next.definitionVersion}, ${next.correlationId}, ${DEFAULT_WORK_CLASS_ID},
          ${DEFAULT_PRIORITY_CLASS_ID}, ${input.notBefore}::timestamptz,
          ${nowIso}::timestamptz, false
        )
        RETURNING *
      `),
    );
    const outboxRow = inserted[0];
    if (!outboxRow) {
      throw new PlumbusError('internal', 'Retry schedule wrote no dispatch outbox row');
    }
    return {
      kind: 'committed',
      execution: next,
      outbox: mapOutbox(outboxRow),
      sideEffectApplied: false,
    };
  });
}

/**
 * Closes a tenant execution's durable state without a claimed hint — an operator cancel, or
 * any terminal transition taken outside the run loop. The spine hint, if one is still ready,
 * is dropped by the next claim that sees the state terminal. No-op when the state is already
 * terminal or absent.
 */
export async function markExecutionStateTerminal(
  db: PostgresJsDatabase,
  input: {
    executionId: string;
    status: Extract<DurableExecutionStatus, 'succeeded' | 'failed' | 'cancelled'>;
    nowIso: string;
  },
  schemaName: string = FRAMEWORK_SCHEMA,
): Promise<boolean> {
  const executionTable = qualifyTable(schemaName, 'execution_state');
  const result = await db.execute(sql`
    UPDATE ${sql.raw(executionTable)}
    SET revision = revision + 1,
        status = ${input.status},
        terminal = true,
        updated_at = ${input.nowIso}::timestamptz,
        wake_at = NULL
    WHERE execution_id = ${input.executionId}
      AND terminal = false
    RETURNING execution_id
  `);
  return asRows(result).length > 0;
}

/**
 * Reopens a terminal tenant execution for an operator retry: a fresh revision, `created`,
 * pointed at the step to run again. The caller publishes the outbox row this makes
 * necessary. Undefined when the plane holds no durable state for the execution (a row
 * started before tenant placement, or a control-plane flow).
 */
export async function reopenExecutionState(
  db: PostgresJsDatabase,
  input: { executionId: string; stepId: string; nowIso: string },
  schemaName: string = FRAMEWORK_SCHEMA,
): Promise<TenantExecutionState | undefined> {
  const executionTable = qualifyTable(schemaName, 'execution_state');
  await db.execute(sql`
    UPDATE ${sql.raw(executionTable)}
    SET revision = revision + 1,
        status = ${DurableExecutionStatus.Created},
        current_step_id = ${input.stepId},
        attempt = 0,
        terminal = false,
        updated_at = ${input.nowIso}::timestamptz,
        wake_at = NULL
    WHERE execution_id = ${input.executionId}
  `);
  return loadExecutionState(db, input.executionId, schemaName);
}

export async function insertDispatchOutbox(
  db: PostgresJsDatabase,
  execution: TenantExecutionState,
  stepId: string,
  nowIso: string,
  schemaName: string = FRAMEWORK_SCHEMA,
): Promise<DispatchOutboxRow> {
  const outboxTable = qualifyTable(schemaName, 'dispatch_outbox');
  const outboxId = `outbox:${execution.executionId}:${execution.revision}:${randomUUID()}`;
  await db.execute(sql`
    INSERT INTO ${sql.raw(outboxTable)} (
      outbox_id, execution_id, state_ref_id, expected_revision, tenant_epoch,
      tenant_ref, step_id, definition_id, definition_version, correlation_id,
      work_class_id, priority_class_id, not_before, created_at, superseded
    ) VALUES (
      ${outboxId}, ${execution.executionId}, ${execution.stateRefId}, ${execution.revision},
      ${execution.tenantEpoch}, ${execution.tenantRef}, ${stepId}, ${execution.definitionId},
      ${execution.definitionVersion}, ${execution.correlationId}, ${DEFAULT_WORK_CLASS_ID},
      ${DEFAULT_PRIORITY_CLASS_ID}, ${nowIso}::timestamptz, ${nowIso}::timestamptz, false
    )
  `);
  const rows = asRows(
    await db.execute(sql`SELECT * FROM ${sql.raw(outboxTable)} WHERE outbox_id = ${outboxId}`),
  );
  const row = rows[0];
  if (!row) throw new PlumbusError('internal', 'Inserted dispatch outbox row could not be read');
  return mapOutbox(row);
}

/**
 * Outbox rows the spine has not been told about. A row that was published is the spine's
 * until it is acknowledged — republishing it would reset a hint another worker holds the
 * lease on; the reconciliation sweep, not the pump, is what re-examines published rows.
 */
export async function listUnpublishedOutbox(
  db: PostgresJsDatabase,
  schemaName: string = FRAMEWORK_SCHEMA,
): Promise<DispatchOutboxRow[]> {
  const outboxTable = qualifyTable(schemaName, 'dispatch_outbox');
  const result = await db.execute(
    sql`SELECT * FROM ${sql.raw(outboxTable)} WHERE superseded = false AND spine_acked_at IS NULL AND published_at IS NULL`,
  );
  return asRows(result).map(mapOutbox);
}

export async function markOutboxPublished(
  db: PostgresJsDatabase,
  outboxId: string,
  spineRowId: string,
  nowIso: string,
  schemaName: string = FRAMEWORK_SCHEMA,
): Promise<void> {
  const outboxTable = qualifyTable(schemaName, 'dispatch_outbox');
  await db.execute(sql`
    UPDATE ${sql.raw(outboxTable)}
    SET published_at = ${nowIso}::timestamptz, spine_row_id = ${spineRowId}
    WHERE outbox_id = ${outboxId}
  `);
}

export async function markOutboxAcked(
  db: PostgresJsDatabase,
  outboxId: string,
  nowIso: string,
  schemaName: string = FRAMEWORK_SCHEMA,
): Promise<void> {
  const outboxTable = qualifyTable(schemaName, 'dispatch_outbox');
  await db.execute(sql`
    UPDATE ${sql.raw(outboxTable)}
    SET spine_acked_at = ${nowIso}::timestamptz
    WHERE outbox_id = ${outboxId}
  `);
}

/** Closes the outbox row behind an acknowledged spine hint, by the spine row it was published as. */
export async function markOutboxAckedBySpineRow(
  db: PostgresJsDatabase,
  spineRowId: string,
  nowIso: string,
  schemaName: string = FRAMEWORK_SCHEMA,
): Promise<void> {
  const outboxTable = qualifyTable(schemaName, 'dispatch_outbox');
  await db.execute(sql`
    UPDATE ${sql.raw(outboxTable)}
    SET spine_acked_at = ${nowIso}::timestamptz
    WHERE spine_row_id = ${spineRowId}
      AND spine_acked_at IS NULL
  `);
}

/**
 * Publishes an outbox row as a spine hint. With `lease`, the hint is born leased by that
 * worker — the one that will run the step in the same drain without a claim in between —
 * so no other worker claims it meanwhile; the lease lapses like any other if the worker dies.
 */
export async function publishOutboxToSpine(
  tenantDb: PostgresJsDatabase,
  spineDb: PostgresJsDatabase,
  outbox: DispatchOutboxRow,
  dispatchId: string,
  nowIso: string,
  schemaName: string = FRAMEWORK_SCHEMA,
  options?:
    | { workerId: string; leaseExpiresAt: string }
    | { deliveryState: typeof SpineDeliveryState.RetryScheduled },
): Promise<OpaqueDispatchRecord> {
  const leased = options !== undefined && 'workerId' in options;
  const deliveryState =
    options !== undefined && 'deliveryState' in options
      ? options.deliveryState
      : leased
        ? SpineDeliveryState.Leased
        : SpineDeliveryState.Ready;
  const record = createOpaqueDispatchRecord({
    dispatchId,
    tenantRouteId: outbox.tenantRef,
    executionId: outbox.executionId,
    definitionId: outbox.definitionId,
    definitionVersion: outbox.definitionVersion,
    stepId: outbox.stepId,
    tenantExecutionStateRefId: outbox.stateRefId,
    expectedRevision: outbox.expectedRevision,
    tenantEpoch: outbox.tenantEpoch,
    workClassId: outbox.workClassId,
    priorityClassId: outbox.priorityClassId,
    deliveryState,
    attempt: leased ? 1 : 0,
    notBefore: outbox.notBefore,
    ...(leased ? { leaseRefId: options.workerId, leaseExpiresAt: options.leaseExpiresAt } : {}),
    correlationId: outbox.correlationId,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  const upserted = await upsertSpineDispatch(spineDb, record);
  await markOutboxPublished(tenantDb, outbox.outboxId, upserted.dispatchId, nowIso, schemaName);
  return upserted;
}

export async function bumpTenantEpochOnDb(
  db: PostgresJsDatabase,
  schemaName: string = FRAMEWORK_SCHEMA,
): Promise<number> {
  const executionTable = qualifyTable(schemaName, 'execution_state');
  const outboxTable = qualifyTable(schemaName, 'dispatch_outbox');
  const result = await db.execute(sql`
    UPDATE ${sql.raw(executionTable)}
    SET tenant_epoch = tenant_epoch + 1, updated_at = now()
    RETURNING tenant_epoch
  `);
  const rows = asRows(result);
  const nextEpoch = rows[0] ? Number(rows[0].tenant_epoch) : 2;
  await db.execute(sql`
    UPDATE ${sql.raw(outboxTable)}
    SET tenant_epoch = ${nextEpoch},
        published_at = NULL,
        spine_row_id = NULL
    WHERE spine_acked_at IS NULL
  `);
  return nextEpoch;
}

export async function listSideEffects(
  db: PostgresJsDatabase,
  schemaName: string = FRAMEWORK_SCHEMA,
): Promise<string[]> {
  const table = qualifyTable(schemaName, 'side_effect_log');
  const result = await db.execute(sql`SELECT label FROM ${sql.raw(table)} ORDER BY applied_at`);
  return asRows(result).map((row) => String(row.label));
}
