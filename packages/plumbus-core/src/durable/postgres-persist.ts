// Tenant-local Protocol A writes against real Postgres. Same CAS + outbox
// pairing as persist-before-ack.ts; used by the flow engine when spineDispatch
// is configured.

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { randomUUID } from 'node:crypto';
import { FRAMEWORK_SCHEMA } from '../data/schema-generator.js';
import { qualifyTable } from './apply-ddl.js';
import { createOpaqueDispatchRecord } from './opaque-dispatch.js';
import { upsertSpineDispatch } from './spine-claim.js';
import {
  DEFAULT_PRIORITY_CLASS_ID,
  DEFAULT_WORK_CLASS_ID,
  DurableExecutionStatus,
  SpineDeliveryState,
  type DispatchOutboxRow,
  type OpaqueDispatchRecord,
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
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
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
    notBefore: toIso(row.not_before)!,
    createdAt: toIso(row.created_at)!,
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
  return mapOutbox(rows[0]!);
}

export async function listUnpublishedOutbox(
  db: PostgresJsDatabase,
  schemaName: string = FRAMEWORK_SCHEMA,
): Promise<DispatchOutboxRow[]> {
  const outboxTable = qualifyTable(schemaName, 'dispatch_outbox');
  const result = await db.execute(
    sql`SELECT * FROM ${sql.raw(outboxTable)} WHERE superseded = false AND spine_acked_at IS NULL`,
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

export async function publishOutboxToSpine(
  tenantDb: PostgresJsDatabase,
  spineDb: PostgresJsDatabase,
  outbox: DispatchOutboxRow,
  dispatchId: string,
  nowIso: string,
  schemaName: string = FRAMEWORK_SCHEMA,
): Promise<OpaqueDispatchRecord> {
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
    deliveryState: SpineDeliveryState.Ready,
    attempt: 0,
    notBefore: outbox.notBefore,
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
