import { describe, expect, it } from 'vitest';
import { rewriteFrameworkDriftMigration } from '../../data/framework-migration-rewriter.js';
import { collectSchemas } from '../../data/migration.js';
import { ActionRiskTier, ReviewMandateReason } from '../action-risk.js';
import { createAllowAllAuthorizationProvider } from '../authorization.js';
import { digestApprovalInput } from '../digest.js';
import { createMemoryApprovalStore } from '../memory-store.js';
import { createApprovalService } from '../service.js';
import {
  type ApprovalRequestRecord,
  ApprovalRequestState,
  type ApprovalStore,
  HUMAN_TASK_CONTRACT_VERSION,
} from '../types.js';

function row(overrides: Partial<ApprovalRequestRecord>): ApprovalRequestRecord {
  return {
    contractVersion: HUMAN_TASK_CONTRACT_VERSION,
    approvalRequestId: 'r',
    capabilityId: 'feedback.publish',
    definitionVersion: '1',
    inputDigest: 'd',
    riskClass: ActionRiskTier.Consequential,
    reviewReason: ReviewMandateReason.RiskTier,
    state: ApprovalRequestState.Pending,
    tenantId: 'tenant-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A store as a host wrote it before the indexed reads existed: no optional methods. */
function legacyStore(): { store: ApprovalStore; fullReads: () => number } {
  const inner = createMemoryApprovalStore();
  let fullReads = 0;
  return {
    store: {
      putRequest: inner.putRequest,
      getRequest: inner.getRequest,
      async listRequests() {
        fullReads += 1;
        return inner.listRequests();
      },
      putDecision: inner.putDecision,
      listDecisions: inner.listDecisions,
      putTask: inner.putTask,
      getTask: inner.getTask,
      listTasksForApprovalRequest: inner.listTasksForApprovalRequest,
      cancelRequest: inner.cancelRequest,
      decideRequest: inner.decideRequest,
      transitionRequest: inner.transitionRequest,
    },
    fullReads: () => fullReads,
  };
}

describe('memory approval store queries', () => {
  it('filters by subject with null meaning "stored without one", newest first, with a limit', async () => {
    const store = createMemoryApprovalStore();
    await store.putRequest(row({ approvalRequestId: 'old', executionId: 'e-1' }));
    await store.putRequest(
      row({ approvalRequestId: 'new', executionId: 'e-1', createdAt: '2026-02-01T00:00:00.000Z' }),
    );
    await store.putRequest(row({ approvalRequestId: 'no-exec' }));
    await store.putRequest(row({ approvalRequestId: 'other-tenant', tenantId: 't-2' }));
    await store.putRequest(row({ approvalRequestId: 'untenanted', tenantId: null }));

    const ids = async (query: Parameters<NonNullable<ApprovalStore['findRequests']>>[0]) =>
      (await store.findRequests?.(query))?.map((r) => r.approvalRequestId);
    expect(await ids({ tenantId: 'tenant-1', executionId: 'e-1' })).toEqual(['new', 'old']);
    expect(await ids({ tenantId: 'tenant-1', executionId: 'e-1', limit: 1 })).toEqual(['new']);
    expect(await ids({ tenantId: 'tenant-1', executionId: null })).toEqual(['no-exec']);
    expect(await ids({ tenantId: null })).toEqual(['untenanted']);
    expect(await ids({ states: [] })).toEqual([]);
    await expect(store.findRequests?.({ limit: 1001 })).rejects.toThrow(
      'limit must be a whole number from 1 to 1000',
    );
  });

  it('pages through everything by id and expires only due live rows', async () => {
    const store = createMemoryApprovalStore();
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      await store.putRequest(row({ approvalRequestId: id }));
    }
    const first = await store.listAllRequests?.({ limit: 2 });
    expect(first?.requests.map((r) => r.approvalRequestId)).toEqual(['a', 'b']);
    const second = await store.listAllRequests?.({ limit: 2, after: first?.next });
    expect(second?.requests.map((r) => r.approvalRequestId)).toEqual(['c', 'd']);
    const last = await store.listAllRequests?.({ limit: 2, after: second?.next });
    expect(last).toEqual({ requests: [expect.objectContaining({ approvalRequestId: 'e' })] });

    await store.putRequest(
      row({ approvalRequestId: 'due', expiresAt: '2026-01-02T00:00:00.000Z' }),
    );
    await store.putRequest(
      row({
        approvalRequestId: 'settled',
        state: ApprovalRequestState.Rejected,
        expiresAt: '2026-01-02T00:00:00.000Z',
      }),
    );
    expect(
      await store.expireRequests?.({
        approvalRequestIds: ['due', 'settled', 'a', 'missing'],
        now: '2026-03-01T00:00:00.000Z',
      }),
    ).toEqual(['due']);
    expect((await store.getRequest('due'))?.state).toBe('expired');
    expect((await store.getRequest('settled'))?.state).toBe('rejected');
  });
});

describe('approval service store reads', () => {
  it('uses indexed reads and never lists the whole store when the store can query', async () => {
    const inner = createMemoryApprovalStore();
    let fullReads = 0;
    const store: ApprovalStore = {
      ...inner,
      async listRequests() {
        fullReads += 1;
        return inner.listRequests();
      },
    };
    const service = createApprovalService({
      authorization: createAllowAllAuthorizationProvider(),
      store,
    });
    const binding = {
      tenantId: 'tenant-1',
      executionId: 'e-1',
      capabilityId: 'feedback.publish',
      definitionVersion: '1',
    };
    await service.requestApproval({
      ...binding,
      input: { v: 1 },
      riskClass: ActionRiskTier.Consequential,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await service.findMatchingApproval({ ...binding, inputDigest: digestApprovalInput({ v: 1 }) });
    await service.findConflictingApproval({ ...binding, inputDigest: 'x' });
    await service.findByExecutionId({ tenantId: 'tenant-1', executionId: 'e-1' });
    await service.invalidateOnMaterialChange({ ...binding, inputDigest: 'x' });
    expect(fullReads).toBe(0);
  });

  it('a store without the indexed reads keeps working, by filtering a full read', async () => {
    const { store, fullReads } = legacyStore();
    let now = new Date('2026-06-01T00:00:00.000Z');
    const service = createApprovalService({
      authorization: createAllowAllAuthorizationProvider(),
      store,
      now: () => now,
    });
    const base = {
      tenantId: 'tenant-1',
      executionId: 'e-1',
      capabilityId: 'feedback.publish',
      definitionVersion: '1',
      riskClass: ActionRiskTier.Consequential,
      expiresAt: new Date('2026-06-10T00:00:00.000Z'),
    };
    const first = await service.requestApproval({ ...base, input: { v: 1 } });
    const second = await service.requestApproval({ ...base, input: { v: 2 } });
    expect((await store.getRequest(first.approvalRequestId))?.state).toBe('invalidated');
    await service.decide({
      requestId: second.approvalRequestId,
      outcome: 'approved',
      auth: { userId: 'u', roles: [], scopes: [], provider: 'oidc' },
    });
    const binding = { ...base, inputDigest: digestApprovalInput({ v: 2 }) };
    expect((await service.findMatchingApproval(binding))?.state).toBe('approved');

    now = new Date('2026-07-01T00:00:00.000Z');
    expect((await service.findMatchingApproval(binding))?.state).toBe('expired');
    expect((await store.getRequest(second.approvalRequestId))?.state).toBe('expired');
    expect(
      (await service.findByExecutionId({ tenantId: 'tenant-1', executionId: 'e-1' }))?.state,
    ).toBe('expired');
    expect(fullReads()).toBeGreaterThan(0);
  });

  it('another writer settling a due approval first wins over the batch expiry', async () => {
    const inner = createMemoryApprovalStore();
    await inner.putRequest(
      row({
        approvalRequestId: 'raced',
        executionId: 'e-1',
        state: ApprovalRequestState.Approved,
        expiresAt: '2026-01-02T00:00:00.000Z',
      }),
    );
    const store: ApprovalStore = {
      ...inner,
      // The row is cancelled between the read and the expiry statement.
      async expireRequests() {
        const current = await inner.getRequest('raced');
        if (current) await inner.putRequest({ ...current, state: ApprovalRequestState.Cancelled });
        return [];
      },
    };
    const service = createApprovalService({
      authorization: createAllowAllAuthorizationProvider(),
      store,
      now: () => new Date('2026-03-01T00:00:00.000Z'),
    });
    const found = await service.findConflictingApproval({
      tenantId: 'tenant-1',
      executionId: 'e-1',
      capabilityId: 'feedback.publish',
      definitionVersion: '2',
      inputDigest: 'd',
    });
    expect(found).toBeUndefined();
  });
});

describe('approval_request_live_idx in app migrations', () => {
  it('an app on the previous snapshot gets one idempotent partial CREATE INDEX', async () => {
    type Snapshot = { tables: Record<string, { indexes: Record<string, unknown> }> };
    const { generateDrizzleJson, generateMigration } = await import('drizzle-kit/api');
    const current = generateDrizzleJson(collectSchemas([])) as unknown as Snapshot;
    const previous = JSON.parse(JSON.stringify(current)) as Snapshot;
    let removed = 0;
    for (const table of Object.values(previous.tables)) {
      if ('approval_request_live_idx' in table.indexes) {
        delete table.indexes.approval_request_live_idx;
        removed += 1;
      }
    }
    expect(removed).toBe(1);
    const statements = await generateMigration(previous as never, current as never);
    const { statements: rewritten } = rewriteFrameworkDriftMigration(statements, {
      hasDrift: false,
      existingFrameworkTables: [],
      missingFrameworkTables: [],
      tables: [],
    });
    expect(rewritten).toHaveLength(1);
    expect(rewritten[0]).toContain('CREATE INDEX IF NOT EXISTS "approval_request_live_idx"');
    expect(rewritten[0]).toContain(`WHERE state IN ('pending', 'approved')`);
  });
});

describe('getRequests (memory store)', () => {
  it('returns the stored requests among the ids, once each, and nothing for an empty list', async () => {
    const { createMemoryApprovalStore } = await import('../memory-store.js');
    const store = createMemoryApprovalStore();
    for (const id of ['a', 'b', 'c']) {
      await store.putRequest({
        approvalRequestId: id,
        capabilityId: 'x.y',
        definitionVersion: '1',
        inputDigest: 'd',
        riskClass: 'consequential',
        reviewReason: 'risk-tier',
        state: 'pending',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      } as never);
    }
    const rows = await store.getRequests?.(['c', 'a', 'zz', 'a']);
    expect(rows?.map((row) => row.approvalRequestId).sort()).toEqual(['a', 'c']);
    expect(await store.getRequests?.([])).toEqual([]);
  });
});
