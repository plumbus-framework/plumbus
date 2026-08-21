// Bounded-time orphan recovery for Protocol A.
// Sweep 1 (tenant): republish unacked outbox. Sweep 2 (spine): ack dangling hints.

import type { MemorySpineStore, MemoryTenantStore } from './memory-store.js';
import { spineDispatchKey } from './memory-store.js';
import { createOpaqueDispatchRecord } from './opaque-dispatch.js';
import { SpineDeliveryState, type DispatchOutboxRow, type OpaqueDispatchRecord } from './types.js';

export interface SweepClock {
  nowIso(): string;
  /** Outbox older than this many ms is eligible. 0 = any unacked row. */
  outboxAgeMs: number;
  /** Spine row older than this many ms is eligible. 0 = any expired/unacked row. */
  spineAgeMs: number;
}

export interface SweepHooks {
  publish(row: DispatchOutboxRow): OpaqueDispatchRecord;
  afterTenantRepublish?(): void;
  afterSpineAck?(): void;
}

function ageMs(iso: string, nowIso: string): number {
  return Date.parse(nowIso) - Date.parse(iso);
}

export function runTenantSweep(
  tenant: MemoryTenantStore,
  _spine: MemorySpineStore,
  clock: SweepClock,
  hooks: SweepHooks,
): number {
  const nowIso = clock.nowIso();
  const epoch = tenant.epoch();
  let repaired = 0;

  for (const row of tenant.listOutbox()) {
    if (row.superseded || row.spineAckedAt) continue;
    if (ageMs(row.createdAt, nowIso) < clock.outboxAgeMs) continue;

    const execution = tenant.getExecution(row.executionId);
    if (!execution || execution.terminal) {
      tenant.runInTransaction((tx) => {
        tx.updateOutbox(row.outboxId, { spineAckedAt: nowIso, superseded: !execution });
      });
      repaired += 1;
      continue;
    }
    if (row.tenantEpoch !== epoch) {
      tenant.runInTransaction((tx) => {
        tx.updateOutbox(row.outboxId, { superseded: true });
      });
      repaired += 1;
      continue;
    }

    hooks.publish(row);
    repaired += 1;
    hooks.afterTenantRepublish?.();
  }

  return repaired;
}

export function runSpineSweep(
  tenant: MemoryTenantStore,
  spine: MemorySpineStore,
  clock: SweepClock,
  hooks?: Pick<SweepHooks, 'afterSpineAck'>,
): number {
  const nowIso = clock.nowIso();
  let swept = 0;

  for (const row of spine.list()) {
    if (row.deliveryState === SpineDeliveryState.Acknowledged) continue;
    if (row.deliveryState === SpineDeliveryState.DeadLettered) continue;
    if (
      row.deliveryState === SpineDeliveryState.Leased &&
      row.leaseExpiresAt &&
      Date.parse(row.leaseExpiresAt) > Date.parse(nowIso)
    ) {
      continue;
    }
    if (ageMs(row.updatedAt, nowIso) < clock.spineAgeMs) continue;

    const execution = tenant.getExecution(row.executionId);
    const dangling =
      !execution ||
      execution.terminal ||
      execution.tenantEpoch !== row.tenantEpoch;

    if (dangling) {
      spine.ack(row.dispatchId, nowIso);
      swept += 1;
      hooks?.afterSpineAck?.();
    }
  }

  return swept;
}

export function publishOutboxRow(
  tenant: MemoryTenantStore,
  spine: MemorySpineStore,
  row: DispatchOutboxRow,
  nowIso: string,
  idFactory: () => string,
): OpaqueDispatchRecord {
  const record = createOpaqueDispatchRecord({
    dispatchId: idFactory(),
    tenantRouteId: row.tenantRef,
    executionId: row.executionId,
    definitionId: row.definitionId,
    definitionVersion: row.definitionVersion,
    stepId: row.stepId,
    tenantExecutionStateRefId: row.stateRefId,
    expectedRevision: row.expectedRevision,
    tenantEpoch: row.tenantEpoch,
    workClassId: row.workClassId,
    priorityClassId: row.priorityClassId,
    deliveryState: SpineDeliveryState.Ready,
    attempt: 0,
    notBefore: row.notBefore,
    correlationId: row.correlationId,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  const upserted = spine.upsert(record);
  tenant.runInTransaction((tx) => {
    tx.updateOutbox(row.outboxId, { publishedAt: nowIso, spineRowId: upserted.dispatchId });
  });
  return upserted;
}

export { spineDispatchKey };
