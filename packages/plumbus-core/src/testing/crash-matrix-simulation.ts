// Plan 02 Stage 1 executable model — Protocol A crash-matrix simulation.
// Two in-memory stores (tenant authoritative, spine reconstructible). Injected
// crash at every ordered write boundary; recovery via orphan sweeps + workers.
// This is not a second flow engine: it is the protocol proof the real engine
// will be evolved to obey.

import {
  createMemorySpineStore,
  createMemoryTenantStore,
  type MemorySpineStore,
  type MemoryTenantStore,
} from '../durable/memory-store.js';
import { createOpaqueDispatchRecord } from '../durable/opaque-dispatch.js';
import {
  persistAcceptance,
  persistRetrySchedule,
  persistStepCompletion,
  type AcceptInput,
} from '../durable/persist-before-ack.js';
import { runSpineSweep, runTenantSweep } from '../durable/reconciliation.js';
import {
  DEFAULT_PRIORITY_CLASS_ID,
  DEFAULT_WORK_CLASS_ID,
  DurableExecutionStatus,
  SpineDeliveryState,
  type DispatchOutboxRow,
  type OpaqueDispatchRecord,
  type TenantExecutionState,
} from '../durable/types.js';

export type CrashPoint =
  | 'before-tenant-commit'
  | 'after-tenant-commit-before-publish'
  | 'after-spine-upsert-before-outbox-mark'
  | 'after-claim-before-tenant-reread'
  | 'after-tenant-commit-before-spine-ack'
  | 'after-spine-ack-before-outbox-ack'
  | 'during-tenant-sweep-after-republish'
  | 'during-spine-sweep-after-ack';

export const CRASH_POINTS: readonly CrashPoint[] = [
  'before-tenant-commit',
  'after-tenant-commit-before-publish',
  'after-spine-upsert-before-outbox-mark',
  'after-claim-before-tenant-reread',
  'after-tenant-commit-before-spine-ack',
  'after-spine-ack-before-outbox-ack',
  'during-tenant-sweep-after-republish',
  'during-spine-sweep-after-ack',
];

export class CrashSignal extends Error {
  constructor(readonly point: CrashPoint) {
    super(`injected crash at ${point}`);
    this.name = 'CrashSignal';
  }
}

export interface ProtocolAOptions {
  crashAt?: CrashPoint;
  /** Default two capability steps then terminal. */
  steps?: string[];
  leaseMs?: number;
  retryBackoffMs?: number;
  definitionId?: string;
  definitionVersion?: string;
}

export interface AcceptAck {
  persisted: true;
  acked: true;
  kind: 'accepted' | 'duplicate';
  executionId: string;
  revision: number;
}

export interface WorldSnapshot {
  epoch: number;
  nowIso: string;
  executions: TenantExecutionState[];
  outbox: DispatchOutboxRow[];
  spine: OpaqueDispatchRecord[];
  sideEffects: readonly string[];
  lastCrash?: CrashPoint;
}

export interface ProtocolAWorld {
  accept(input: Omit<AcceptInput, 'definitionId' | 'definitionVersion' | 'firstStepId'> & { firstStepId?: string }): AcceptAck;
  pump(): void;
  workerTick(workerId?: string): boolean;
  recover(): void;
  restore(): number;
  loseTenantExecution(executionId: string): void;
  injectDuplicateDispatch(executionId: string, expectedRevision: number): void;
  advanceTime(ms: number): void;
  failNextExecute(): void;
  inspect(): WorldSnapshot;
}

export function createProtocolAWorld(options: ProtocolAOptions = {}): ProtocolAWorld {
  const steps = options.steps ?? ['step-a', 'step-b'];
  const leaseMs = options.leaseMs ?? 60_000;
  const retryBackoffMs = options.retryBackoffMs ?? 5_000;
  const definitionId = options.definitionId ?? 'flow:demo';
  const definitionVersion = options.definitionVersion ?? '1.0.0';

  const tenant: MemoryTenantStore = createMemoryTenantStore();
  const spine: MemorySpineStore = createMemorySpineStore();

  let nowMs = Date.parse('2026-08-20T00:00:00.000Z');
  let seq = 0;
  let crashArmed = options.crashAt !== undefined;
  let lastCrash: CrashPoint | undefined;
  let failNext = false;

  function nowIso(): string {
    return new Date(nowMs).toISOString();
  }

  function nextId(prefix: string): string {
    seq += 1;
    return `${prefix}-${String(seq).padStart(4, '0')}`;
  }

  function crash(point: CrashPoint): void {
    if (!crashArmed || options.crashAt !== point) return;
    crashArmed = false;
    lastCrash = point;
    throw new CrashSignal(point);
  }

  function nextStepId(current: string): string | undefined {
    const index = steps.indexOf(current);
    if (index < 0 || index >= steps.length - 1) return undefined;
    return steps[index + 1];
  }

  function publish(row: DispatchOutboxRow): void {
    const record = createOpaqueDispatchRecord({
      dispatchId: nextId('disp'),
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
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const upserted = spine.upsert(record);
    crash('after-spine-upsert-before-outbox-mark');
    tenant.runInTransaction((tx) => {
      tx.updateOutbox(row.outboxId, { publishedAt: nowIso(), spineRowId: upserted.dispatchId });
    });
  }

  function pump(): void {
    for (const row of tenant.listOutbox()) {
      if (row.superseded || row.spineAckedAt || row.publishedAt) continue;
      const execution = tenant.getExecution(row.executionId);
      if (!execution || execution.terminal) continue;
      publish(row);
    }
  }

  const world: ProtocolAWorld = {
    accept(input) {
      const firstStepId = input.firstStepId ?? steps[0]!;
      let persisted: ReturnType<typeof persistAcceptance> | undefined;
      tenant.runInTransaction((tx) => {
        persisted = persistAcceptance(
          tx,
          {
            ...input,
            firstStepId,
            definitionId,
            definitionVersion,
          },
          nowIso(),
        );
        crash('before-tenant-commit');
      });
      crash('after-tenant-commit-before-publish');
      if (persisted?.outbox) publish(persisted.outbox);
      return {
        persisted: true,
        acked: true,
        kind: persisted!.kind,
        executionId: persisted!.execution.executionId,
        revision: persisted!.execution.revision,
      };
    },
    pump,
    workerTick(workerId = 'worker-1') {
      const claimed = spine.claim(workerId, nowIso(), leaseMs);
      if (!claimed) return false;
      crash('after-claim-before-tenant-reread');

      const execution = tenant.getExecution(claimed.executionId);
      const stale =
        !execution ||
        execution.terminal ||
        execution.revision !== claimed.expectedRevision ||
        execution.tenantEpoch !== claimed.tenantEpoch;

      if (stale) {
        spine.ack(claimed.dispatchId, nowIso());
        const originating = execution
          ? tenant.listOutbox().find(
              (row) =>
                row.executionId === claimed.executionId &&
                row.expectedRevision === claimed.expectedRevision,
            )
          : undefined;
        if (originating) {
          tenant.runInTransaction((tx) => {
            tx.updateOutbox(originating.outboxId, { spineAckedAt: nowIso() });
          });
        }
        return true;
      }

      if (execution.status === DurableExecutionStatus.RetryScheduled && execution.wakeAt) {
        if (Date.parse(execution.wakeAt) > Date.parse(nowIso())) {
          return true;
        }
      }

      if (failNext) {
        failNext = false;
        tenant.runInTransaction((tx) => {
          persistRetrySchedule(
            tx,
            {
              executionId: claimed.executionId,
              expectedRevision: claimed.expectedRevision,
              tenantEpoch: claimed.tenantEpoch,
              stepId: claimed.stepId,
              notBefore: new Date(nowMs + retryBackoffMs).toISOString(),
            },
            nowIso(),
          );
          crash('before-tenant-commit');
        });
        crash('after-tenant-commit-before-publish');
        const retryOutbox = tenant
          .listOutbox()
          .find(
            (row) =>
              row.executionId === claimed.executionId &&
              row.expectedRevision === (tenant.getExecution(claimed.executionId)?.revision ?? -1),
          );
        if (retryOutbox && !retryOutbox.publishedAt) publish(retryOutbox);
        spine.ack(claimed.dispatchId, nowIso());
        return true;
      }

      const sideEffectKey = `${claimed.executionId}:${claimed.stepId}:${execution.attempt}`;
      const sideEffectLabel = `${claimed.executionId}:${claimed.stepId}`;
      tenant.runInTransaction((tx) => {
        persistStepCompletion(
          tx,
          {
            executionId: claimed.executionId,
            expectedRevision: claimed.expectedRevision,
            tenantEpoch: claimed.tenantEpoch,
            stepId: claimed.stepId,
            nextStepId: nextStepId(claimed.stepId),
            sideEffectKey,
            sideEffectLabel,
          },
          nowIso(),
        );
        crash('before-tenant-commit');
      });
      crash('after-tenant-commit-before-spine-ack');

      const followUp = tenant
        .listOutbox()
        .find(
          (row) =>
            row.executionId === claimed.executionId &&
            row.expectedRevision === (tenant.getExecution(claimed.executionId)?.revision ?? -1) &&
            !row.publishedAt,
        );
      if (followUp) publish(followUp);

      spine.ack(claimed.dispatchId, nowIso());
      crash('after-spine-ack-before-outbox-ack');
      const originating = tenant
        .listOutbox()
        .find(
          (row) =>
            row.executionId === claimed.executionId &&
            row.expectedRevision === claimed.expectedRevision,
        );
      if (originating) {
        tenant.runInTransaction((tx) => {
          tx.updateOutbox(originating.outboxId, { spineAckedAt: nowIso() });
        });
      }
      return true;
    },
    recover() {
      for (let i = 0; i < 40; i += 1) {
        runTenantSweep(tenant, spine, { nowIso, outboxAgeMs: 0, spineAgeMs: 0 }, {
          publish: (row) => {
            publish(row);
            const published = spine
              .list()
              .find(
                (item) =>
                  item.executionId === row.executionId &&
                  item.expectedRevision === row.expectedRevision,
              );
            if (!published) {
              throw new Error('tenant sweep published no spine row');
            }
            return published;
          },
          afterTenantRepublish: () => crash('during-tenant-sweep-after-republish'),
        });
        runSpineSweep(tenant, spine, { nowIso, outboxAgeMs: 0, spineAgeMs: 0 }, {
          afterSpineAck: () => crash('during-spine-sweep-after-ack'),
        });
        pump();
        const did = world.workerTick(`recover-${i}`);
        if (!hasPendingWork(tenant, spine, nowIso()) && !did) break;
        if (!did) {
          const futureWake = nextWakeMs(tenant, spine, nowMs);
          if (futureWake !== undefined) {
            nowMs = futureWake;
            continue;
          }
          const leased = spine.list().some(
            (row) =>
              row.deliveryState === SpineDeliveryState.Leased &&
              row.leaseExpiresAt &&
              Date.parse(row.leaseExpiresAt) > Date.parse(nowIso()),
          );
          if (leased) {
            nowMs += leaseMs + 1;
          }
        }
      }
    },
    restore() {
      return tenant.bumpEpoch();
    },
    loseTenantExecution(executionId) {
      tenant.dropExecution(executionId);
    },
    injectDuplicateDispatch(executionId, expectedRevision) {
      const execution = tenant.getExecution(executionId);
      if (!execution) throw new Error(`no execution ${executionId}`);
      const record = createOpaqueDispatchRecord({
        dispatchId: nextId('disp'),
        tenantRouteId: execution.tenantRef,
        executionId,
        definitionId: execution.definitionId,
        definitionVersion: execution.definitionVersion,
        stepId: execution.currentStepId,
        tenantExecutionStateRefId: execution.stateRefId,
        expectedRevision,
        tenantEpoch: execution.tenantEpoch,
        workClassId: DEFAULT_WORK_CLASS_ID,
        priorityClassId: DEFAULT_PRIORITY_CLASS_ID,
        deliveryState: SpineDeliveryState.Ready,
        attempt: 0,
        notBefore: nowIso(),
        correlationId: execution.correlationId,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      spine.upsert(record);
    },
    advanceTime(ms) {
      nowMs += ms;
    },
    failNextExecute() {
      failNext = true;
    },
    inspect() {
      return {
        epoch: tenant.epoch(),
        nowIso: nowIso(),
        executions: tenant.listExecutions(),
        outbox: tenant.listOutbox(),
        spine: spine.list(),
        sideEffects: tenant.listSideEffects(),
        lastCrash,
      };
    },
  };

  return world;
}

function nextWakeMs(
  tenant: MemoryTenantStore,
  spine: MemorySpineStore,
  nowMs: number,
): number | undefined {
  const candidates = [
    ...spine.list().map((row) => Date.parse(row.notBefore)),
    ...tenant
      .listExecutions()
      .filter((row) => row.wakeAt)
      .map((row) => Date.parse(row.wakeAt!)),
  ].filter((ms) => Number.isFinite(ms) && ms > nowMs);
  if (candidates.length === 0) return undefined;
  return Math.min(...candidates);
}

function hasPendingWork(tenant: MemoryTenantStore, spine: MemorySpineStore, _nowIso: string): boolean {
  const live = tenant.listExecutions().filter((row) => !row.terminal);
  const danglingSpine = spine.list().some(
    (row) =>
      row.deliveryState !== SpineDeliveryState.Acknowledged &&
      row.deliveryState !== SpineDeliveryState.DeadLettered,
  );
  if (live.length === 0) return danglingSpine;
  const unpublished = tenant
    .listOutbox()
    .some((row) => !row.superseded && !row.spineAckedAt && !row.publishedAt);
  return unpublished || danglingSpine || live.length > 0;
}

export function driveToIdle(world: ProtocolAWorld): void {
  try {
    world.recover();
  } catch (error) {
    if (!(error instanceof CrashSignal)) throw error;
  }
  world.recover();
}

export function assertProtocolProperties(snapshot: WorldSnapshot): void {
  const unique = new Set(snapshot.sideEffects);
  if (unique.size !== snapshot.sideEffects.length) {
    throw new Error(`protected side effects duplicated: ${snapshot.sideEffects.join(',')}`);
  }
  for (const row of snapshot.spine) {
    createOpaqueDispatchRecord(row);
  }
  for (const execution of snapshot.executions) {
    if (execution.revision < 1) {
      throw new Error(`execution ${execution.executionId} revision must be >= 1`);
    }
  }
}
