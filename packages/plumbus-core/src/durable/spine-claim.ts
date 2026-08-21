// Spine claim loop: the existing FOR UPDATE SKIP LOCKED pattern from
// flows/engine.ts, pointed at opaque_dispatch. Lease lives on the spine row only.

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createOpaqueDispatchRecord } from './opaque-dispatch.js';
import { SpineDeliveryState, type OpaqueDispatchRecord } from './types.js';

function getRowsAffected(result: unknown): number {
  const r = result as { rowCount?: unknown; count?: unknown; length?: unknown } | null | undefined;
  if (typeof r?.rowCount === 'number') return r.rowCount;
  if (typeof r?.count === 'number') return r.count;
  if (typeof r?.length === 'number') return r.length;
  return 0;
}

function asRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  return [];
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  throw new Error(`expected timestamptz, got ${typeof value}`);
}

export function spineRowFromSql(row: Record<string, unknown>): OpaqueDispatchRecord {
  return createOpaqueDispatchRecord({
    dispatchId: String(row.dispatch_id),
    tenantRouteId: String(row.tenant_route_id),
    executionId: String(row.execution_id),
    definitionId: String(row.definition_id),
    definitionVersion: String(row.definition_version),
    stepId: String(row.step_id),
    tenantExecutionStateRefId: String(row.tenant_execution_state_ref_id),
    expectedRevision: Number(row.expected_revision),
    tenantEpoch: Number(row.tenant_epoch),
    workClassId: String(row.work_class_id),
    priorityClassId: String(row.priority_class_id),
    deliveryState: row.delivery_state as OpaqueDispatchRecord['deliveryState'],
    attempt: Number(row.attempt),
    notBefore: toIso(row.not_before),
    leaseRefId: row.lease_ref_id == null ? undefined : String(row.lease_ref_id),
    leaseExpiresAt: row.lease_expires_at == null ? undefined : toIso(row.lease_expires_at),
    privacySafeFailureCategoryId:
      row.privacy_safe_failure_category_id == null
        ? undefined
        : String(row.privacy_safe_failure_category_id),
    correlationId: String(row.correlation_id),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

export interface SpineClaimOptions {
  workerId: string;
  leaseDurationMs: number;
  limit?: number;
}

/**
 * Claim ready (or lease-expired) spine rows. Concurrent callers each get
 * different rows because of FOR UPDATE SKIP LOCKED.
 */
export async function claimSpineDispatch(
  db: PostgresJsDatabase,
  options: SpineClaimOptions,
): Promise<OpaqueDispatchRecord[]> {
  const limit = options.limit ?? 50;
  const leaseDurationInterval = `${options.leaseDurationMs} milliseconds`;
  const result = await db.execute(sql`
    UPDATE opaque_dispatch
    SET delivery_state = ${SpineDeliveryState.Leased},
        lease_ref_id = ${options.workerId},
        lease_expires_at = now() + ${leaseDurationInterval}::interval,
        attempt = attempt + 1,
        updated_at = now()
    WHERE dispatch_id IN (
      SELECT dispatch_id
      FROM opaque_dispatch
      WHERE not_before <= now()
        AND (
          delivery_state = ${SpineDeliveryState.Ready}
          OR delivery_state = ${SpineDeliveryState.RetryScheduled}
          OR (delivery_state = ${SpineDeliveryState.Leased} AND lease_expires_at < now())
        )
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING *
  `);
  return asRows(result).map(spineRowFromSql);
}

export async function ackSpineDispatch(
  db: PostgresJsDatabase,
  dispatchId: string,
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE opaque_dispatch
    SET delivery_state = ${SpineDeliveryState.Acknowledged},
        lease_ref_id = NULL,
        lease_expires_at = NULL,
        updated_at = now()
    WHERE dispatch_id = ${dispatchId}
      AND delivery_state <> ${SpineDeliveryState.Acknowledged}
  `);
  return getRowsAffected(result) > 0;
}

export async function upsertSpineDispatch(
  db: PostgresJsDatabase,
  record: OpaqueDispatchRecord,
): Promise<OpaqueDispatchRecord> {
  const result = await db.execute(sql`
    INSERT INTO opaque_dispatch (
      dispatch_id, contract_version, tenant_route_id, execution_id,
      definition_id, definition_version, step_id, tenant_execution_state_ref_id,
      expected_revision, tenant_epoch, work_class_id, priority_class_id,
      delivery_state, attempt, not_before, lease_ref_id, lease_expires_at,
      privacy_safe_failure_category_id, correlation_id, created_at, updated_at
    ) VALUES (
      ${record.dispatchId}, ${record.contractVersion}, ${record.tenantRouteId},
      ${record.executionId}, ${record.definitionId}, ${record.definitionVersion},
      ${record.stepId}, ${record.tenantExecutionStateRefId},
      ${record.expectedRevision}, ${record.tenantEpoch}, ${record.workClassId},
      ${record.priorityClassId}, ${record.deliveryState}, ${record.attempt},
      ${record.notBefore}::timestamptz, ${record.leaseRefId ?? null},
      ${record.leaseExpiresAt ?? null}, ${record.privacySafeFailureCategoryId ?? null},
      ${record.correlationId}, ${record.createdAt}::timestamptz, ${record.updatedAt}::timestamptz
    )
    ON CONFLICT (tenant_route_id, execution_id, expected_revision)
    DO UPDATE SET
      delivery_state = EXCLUDED.delivery_state,
      step_id = EXCLUDED.step_id,
      tenant_epoch = EXCLUDED.tenant_epoch,
      not_before = EXCLUDED.not_before,
      updated_at = EXCLUDED.updated_at,
      lease_ref_id = NULL,
      lease_expires_at = NULL
    RETURNING *
  `);
  const row = asRows(result)[0];
  if (!row) throw new Error('spine upsert returned no row');
  return spineRowFromSql(row);
}
