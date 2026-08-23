// In-memory tenant and spine stores for Protocol A.
// Tenant writes go through runInTransaction so persist-before-ack can roll back.

import type {
  CasResult,
  DispatchOutboxRow,
  OpaqueDispatchRecord,
  StepExecutionRecord,
  TenantExecutionState,
  TerminalStateRecord,
  WaitStateRecord,
} from './types.js';
import { SpineDeliveryState } from './types.js';

export interface TenantTx {
  readonly epoch: number;
  getExecution(executionId: string): TenantExecutionState | undefined;
  insertExecution(row: TenantExecutionState): void;
  casExecution(
    executionId: string,
    expectedRevision: number,
    next: TenantExecutionState,
  ): CasResult;
  putStep(row: StepExecutionRecord): void;
  listSteps(executionId: string): StepExecutionRecord[];
  putWait(row: WaitStateRecord): void;
  putTerminal(row: TerminalStateRecord): void;
  getTerminal(executionId: string): TerminalStateRecord | undefined;
  insertOutbox(row: DispatchOutboxRow): void;
  updateOutbox(outboxId: string, patch: Partial<DispatchOutboxRow>): void;
  getOutbox(outboxId: string): DispatchOutboxRow | undefined;
  listOutbox(): DispatchOutboxRow[];
  findOutbox(executionId: string, expectedRevision: number): DispatchOutboxRow | undefined;
  hasIdempotency(key: string): boolean;
  putIdempotency(key: string): void;
  applySideEffect(key: string, label: string): boolean;
  listSideEffects(): readonly string[];
}

interface TenantData {
  epoch: number;
  executions: Map<string, TenantExecutionState>;
  steps: Map<string, StepExecutionRecord>;
  waits: Map<string, WaitStateRecord>;
  terminals: Map<string, TerminalStateRecord>;
  outbox: Map<string, DispatchOutboxRow>;
  idempotency: Set<string>;
  sideEffectKeys: Set<string>;
  sideEffects: string[];
}

function cloneTenantData(data: TenantData): TenantData {
  return {
    epoch: data.epoch,
    executions: new Map(data.executions),
    steps: new Map(data.steps),
    waits: new Map(data.waits),
    terminals: new Map(data.terminals),
    outbox: new Map(data.outbox),
    idempotency: new Set(data.idempotency),
    sideEffectKeys: new Set(data.sideEffectKeys),
    sideEffects: [...data.sideEffects],
  };
}

function bindTx(data: TenantData): TenantTx {
  return {
    get epoch() {
      return data.epoch;
    },
    getExecution(executionId) {
      const row = data.executions.get(executionId);
      return row ? { ...row } : undefined;
    },
    insertExecution(row) {
      if (data.executions.has(row.executionId)) {
        throw new Error(`execution already exists: ${row.executionId}`);
      }
      data.executions.set(row.executionId, { ...row });
    },
    casExecution(executionId, expectedRevision, next) {
      const current = data.executions.get(executionId);
      if (!current) return 'missing';
      if (current.revision !== expectedRevision) return 'stale';
      if (next.revision !== expectedRevision + 1) {
        throw new Error(
          `CAS next revision must be expected+1 (expected ${expectedRevision + 1}, got ${next.revision})`,
        );
      }
      data.executions.set(executionId, { ...next });
      return 'ok';
    },
    putStep(row) {
      data.steps.set(row.stepExecutionId, { ...row });
    },
    listSteps(executionId) {
      return [...data.steps.values()].filter((step) => step.executionId === executionId);
    },
    putWait(row) {
      data.waits.set(row.waitStateId, { ...row });
    },
    putTerminal(row) {
      data.terminals.set(row.executionId, { ...row });
    },
    getTerminal(executionId) {
      const row = data.terminals.get(executionId);
      return row ? { ...row } : undefined;
    },
    insertOutbox(row) {
      data.outbox.set(row.outboxId, { ...row });
    },
    updateOutbox(outboxId, patch) {
      const current = data.outbox.get(outboxId);
      if (!current) throw new Error(`unknown outbox row: ${outboxId}`);
      data.outbox.set(outboxId, { ...current, ...patch });
    },
    getOutbox(outboxId) {
      const row = data.outbox.get(outboxId);
      return row ? { ...row } : undefined;
    },
    listOutbox() {
      return [...data.outbox.values()].map((row) => ({ ...row }));
    },
    findOutbox(executionId, expectedRevision) {
      for (const row of data.outbox.values()) {
        if (row.executionId === executionId && row.expectedRevision === expectedRevision) {
          return { ...row };
        }
      }
      return undefined;
    },
    hasIdempotency(key) {
      return data.idempotency.has(key);
    },
    putIdempotency(key) {
      data.idempotency.add(key);
    },
    applySideEffect(key, label) {
      if (data.sideEffectKeys.has(key)) return false;
      data.sideEffectKeys.add(key);
      data.sideEffects.push(label);
      return true;
    },
    listSideEffects() {
      return [...data.sideEffects];
    },
  };
}

export interface MemoryTenantStore {
  epoch(): number;
  /** Restore / generation bump. Live rows are stamped with the new epoch. */
  bumpEpoch(): number;
  getExecution(executionId: string): TenantExecutionState | undefined;
  listExecutions(): TenantExecutionState[];
  listOutbox(): DispatchOutboxRow[];
  listSideEffects(): readonly string[];
  listSteps(executionId: string): StepExecutionRecord[];
  getTerminal(executionId: string): TerminalStateRecord | undefined;
  dropExecution(executionId: string): void;
  runInTransaction<T>(fn: (tx: TenantTx) => T): T;
}

export function createMemoryTenantStore(opts?: { epoch?: number }): MemoryTenantStore {
  let data: TenantData = {
    epoch: opts?.epoch ?? 1,
    executions: new Map(),
    steps: new Map(),
    waits: new Map(),
    terminals: new Map(),
    outbox: new Map(),
    idempotency: new Set(),
    sideEffectKeys: new Set(),
    sideEffects: [],
  };

  return {
    epoch() {
      return data.epoch;
    },
    bumpEpoch() {
      const nextEpoch = data.epoch + 1;
      const next = cloneTenantData(data);
      next.epoch = nextEpoch;
      for (const [id, row] of next.executions) {
        next.executions.set(id, { ...row, tenantEpoch: nextEpoch });
      }
      for (const [id, row] of next.outbox) {
        if (!row.spineAckedAt) {
          next.outbox.set(id, {
            ...row,
            tenantEpoch: nextEpoch,
            publishedAt: undefined,
            spineRowId: undefined,
          });
        }
      }
      data = next;
      return nextEpoch;
    },
    getExecution(executionId) {
      const row = data.executions.get(executionId);
      return row ? { ...row } : undefined;
    },
    listExecutions() {
      return [...data.executions.values()].map((row) => ({ ...row }));
    },
    listOutbox() {
      return [...data.outbox.values()].map((row) => ({ ...row }));
    },
    listSideEffects() {
      return [...data.sideEffects];
    },
    listSteps(executionId) {
      return [...data.steps.values()]
        .filter((step) => step.executionId === executionId)
        .map((step) => ({ ...step }));
    },
    getTerminal(executionId) {
      const row = data.terminals.get(executionId);
      return row ? { ...row } : undefined;
    },
    dropExecution(executionId) {
      data.executions.delete(executionId);
      data.terminals.delete(executionId);
    },
    runInTransaction(fn) {
      const draft = cloneTenantData(data);
      const tx = bindTx(draft);
      const result = fn(tx);
      data = draft;
      return result;
    },
  };
}

export function spineDispatchKey(
  record: Pick<OpaqueDispatchRecord, 'tenantRouteId' | 'executionId' | 'expectedRevision'>,
): string {
  return `${record.tenantRouteId}:${record.executionId}:${record.expectedRevision}`;
}

export interface MemorySpineStore {
  upsert(record: OpaqueDispatchRecord): OpaqueDispatchRecord;
  claim(workerId: string, nowIso: string, leaseMs: number): OpaqueDispatchRecord | undefined;
  ack(dispatchId: string, nowIso: string): void;
  get(dispatchId: string): OpaqueDispatchRecord | undefined;
  getByKey(key: string): OpaqueDispatchRecord | undefined;
  list(): OpaqueDispatchRecord[];
}

export function createMemorySpineStore(): MemorySpineStore {
  const byId = new Map<string, OpaqueDispatchRecord>();
  const byKey = new Map<string, string>();

  function put(record: OpaqueDispatchRecord): void {
    byId.set(record.dispatchId, { ...record });
    byKey.set(spineDispatchKey(record), record.dispatchId);
  }

  return {
    upsert(record) {
      const key = spineDispatchKey(record);
      const existingId = byKey.get(key);
      if (existingId) {
        const existing = byId.get(existingId);
        if (!existing) throw new Error(`spine index broken for ${key}`);
        const merged: OpaqueDispatchRecord = {
          ...existing,
          ...record,
          dispatchId: existing.dispatchId,
          createdAt: existing.createdAt,
        };
        put(merged);
        return { ...merged };
      }
      put(record);
      return { ...record };
    },
    claim(workerId, nowIso, leaseMs) {
      const now = Date.parse(nowIso);
      const candidates = [...byId.values()]
        .filter((row) => {
          if (row.deliveryState === SpineDeliveryState.Acknowledged) return false;
          if (row.deliveryState === SpineDeliveryState.DeadLettered) return false;
          if (Date.parse(row.notBefore) > now) return false;
          if (
            row.deliveryState === SpineDeliveryState.Leased &&
            row.leaseExpiresAt &&
            Date.parse(row.leaseExpiresAt) > now
          ) {
            return false;
          }
          return true;
        })
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.dispatchId.localeCompare(b.dispatchId),
        );

      const next = candidates[0];
      if (!next) return undefined;

      const leased: OpaqueDispatchRecord = {
        ...next,
        deliveryState: SpineDeliveryState.Leased,
        leaseRefId: workerId,
        leaseExpiresAt: new Date(now + leaseMs).toISOString(),
        attempt: next.attempt + 1,
        updatedAt: nowIso,
      };
      put(leased);
      return { ...leased };
    },
    ack(dispatchId, nowIso) {
      const current = byId.get(dispatchId);
      if (!current) return;
      put({
        ...current,
        deliveryState: SpineDeliveryState.Acknowledged,
        leaseRefId: undefined,
        leaseExpiresAt: undefined,
        updatedAt: nowIso,
      });
    },
    get(dispatchId) {
      const row = byId.get(dispatchId);
      return row ? { ...row } : undefined;
    },
    getByKey(key) {
      const id = byKey.get(key);
      return id ? this.get(id) : undefined;
    },
    list() {
      return [...byId.values()].map((row) => ({ ...row }));
    },
  };
}
