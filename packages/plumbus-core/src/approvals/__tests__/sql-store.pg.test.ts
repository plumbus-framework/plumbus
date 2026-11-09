import { afterAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../data/migration.js';
import { FRAMEWORK_SCHEMA } from '../../data/schema-generator.js';
import { DURABLE_TEST_DB_PATTERN } from '../../durable/apply-ddl.js';
import { createDurableTestDatabase } from '../../durable/harness.js';
import { FRAMEWORK_DURABLE_TENANT_MIGRATIONS } from '../../durable/migrations-path.js';
import { ActionRiskTier } from '../action-risk.js';
import { createAllowAllAuthorizationProvider } from '../authorization.js';
import { digestApprovalInput } from '../digest.js';
import { createApprovalService } from '../service.js';
import { createSqlApprovalStore } from '../sql-store.js';
import { ApprovalDecisionConflictError, HumanTaskKind } from '../types.js';

function humanAuth() {
  return {
    userId: 'approver-1',
    roles: ['reviewer'],
    scopes: [],
    provider: 'oidc',
    tenantId: 'tenant-1',
  };
}

describe('SQL approval store', () => {
  const closers: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const close of closers.reverse()) {
      await close();
    }
  });

  it('persists requests, decisions, and tasks on a dedicated plumbus_durable_test_* plane', async () => {
    const tenant = await createDurableTestDatabase({ kind: 'sqlappr', ddl: '' });
    closers.push(tenant.close);

    expect(tenant.name).toMatch(DURABLE_TEST_DB_PATTERN);

    await applyMigrations({
      db: tenant.db,
      migrationsFolder: FRAMEWORK_DURABLE_TENANT_MIGRATIONS,
    });

    const service = createApprovalService({
      authorization: createAllowAllAuthorizationProvider(),
      db: () => tenant.db,
      schemaName: FRAMEWORK_SCHEMA,
    });

    const request = await service.requestApproval({
      tenantId: 'tenant-1',
      capabilityId: 'billing.issueRefund',
      definitionVersion: '1.2.0',
      input: { amount: 25 },
      riskClass: ActionRiskTier.Consequential,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(request.state).toBe('pending');

    const decided = await service.decide({
      requestId: request.approvalRequestId,
      outcome: 'approved',
      auth: humanAuth(),
    });
    expect(decided.state).toBe('approved');

    const task = await service.createHumanTask({
      kind: HumanTaskKind.Approval,
      approvalRequestId: request.approvalRequestId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const completed = await service.completeHumanTask({
      taskId: task.humanTaskId,
      auth: humanAuth(),
    });
    expect(completed.state).toBe('completed');

    const reloaded = createSqlApprovalStore({
      db: tenant.db,
      schemaName: FRAMEWORK_SCHEMA,
    });
    const persisted = await reloaded.getRequest(request.approvalRequestId);
    expect(persisted?.state).toBe('approved');
    expect(persisted?.inputDigest).toBe(digestApprovalInput({ amount: 25 }));
    expect(
      (await reloaded.listDecisions(request.approvalRequestId)).map((row) => row.decision),
    ).toEqual(['approved']);
    expect((await reloaded.getTask(task.humanTaskId))?.state).toBe('completed');

    const match = await service.findMatchingApproval({
      tenantId: 'tenant-1',
      capabilityId: 'billing.issueRefund',
      definitionVersion: '1.2.0',
      inputDigest: digestApprovalInput({ amount: 25 }),
    });
    expect(match?.approvalRequestId).toBe(request.approvalRequestId);

    const cancellable = await service.requestApproval({
      tenantId: 'tenant-1',
      capabilityId: 'feedback.publish',
      definitionVersion: '1.0.0',
      input: { revision: 'r1' },
      riskClass: ActionRiskTier.Consequential,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const cancellationTask = await service.createHumanTask({
      kind: HumanTaskKind.Approval,
      approvalRequestId: cancellable.approvalRequestId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await service.cancel({
      requestId: cancellable.approvalRequestId,
      auth: humanAuth(),
      reason: 'requester-withdrew',
    });
    expect(await reloaded.getRequest(cancellable.approvalRequestId)).toMatchObject({
      state: 'cancelled',
      cancelledByAccountId: 'approver-1',
      cancellationReason: 'requester-withdrew',
    });
    expect((await reloaded.getTask(cancellationTask.humanTaskId))?.state).toBe('cancelled');
    expect(await reloaded.listDecisions(cancellable.approvalRequestId)).toEqual([]);
  });

  it('binds tenant, applies exactly one of two racing decisions, and expires approvals at lookup', async () => {
    const tenant = await createDurableTestDatabase({ kind: 'sqlcas', ddl: '' });
    closers.push(tenant.close);
    await applyMigrations({ db: tenant.db, migrationsFolder: FRAMEWORK_DURABLE_TENANT_MIGRATIONS });

    let now = new Date();
    const service = createApprovalService({
      authorization: createAllowAllAuthorizationProvider(),
      db: () => tenant.db,
      schemaName: FRAMEWORK_SCHEMA,
      now: () => now,
    });
    const store = createSqlApprovalStore({ db: tenant.db, schemaName: FRAMEWORK_SCHEMA });

    const request = await service.requestApproval({
      tenantId: 'tenant-a',
      executionId: 'exec-1',
      capabilityId: 'billing.issueRefund',
      definitionVersion: '1',
      input: { amount: 5 },
      riskClass: ActionRiskTier.Consequential,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    expect((await store.getRequest(request.approvalRequestId))?.tenantId).toBe('tenant-a');

    const results = await Promise.allSettled(
      (['approved', 'rejected', 'changes-requested'] as const).map((outcome, i) =>
        service.decide({
          requestId: request.approvalRequestId,
          outcome,
          auth: { ...humanAuth(), userId: `approver-${i}` },
        }),
      ),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(2);
    for (const loser of lost) {
      expect(String((loser as PromiseRejectedResult).reason)).toMatch(
        /already settled|is (approved|rejected|changes-requested)/,
      );
    }
    const state = (won[0] as PromiseFulfilledResult<{ state: string }>).value.state;
    expect((await store.getRequest(request.approvalRequestId))?.state).toBe(state);
    expect((await store.listDecisions(request.approvalRequestId)).map((d) => d.decision)).toEqual([
      state,
    ]);

    const binding = {
      capabilityId: 'billing.issueRefund',
      definitionVersion: '1',
      inputDigest: digestApprovalInput({ amount: 5 }),
    };
    expect(
      await service.findMatchingApproval({
        ...binding,
        tenantId: 'tenant-b',
        executionId: 'exec-1',
      }),
    ).toBeUndefined();
    expect(
      await service.findByExecutionId({ tenantId: 'tenant-b', executionId: 'exec-1' }),
    ).toBeUndefined();

    const expiring = await service.requestApproval({
      tenantId: 'tenant-a',
      executionId: 'exec-2',
      capabilityId: 'billing.issueRefund',
      definitionVersion: '1',
      input: { amount: 5 },
      riskClass: ActionRiskTier.Consequential,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    await service.decide({
      requestId: expiring.approvalRequestId,
      outcome: 'approved',
      auth: humanAuth(),
    });
    now = new Date(now.getTime() + 120_000);
    expect(
      (await service.findByExecutionId({ tenantId: 'tenant-a', executionId: 'exec-2' }))?.state,
    ).toBe('expired');
    expect((await store.getRequest(expiring.approvalRequestId))?.state).toBe('expired');
  });

  it('refuses a decision whose CAS loses to a concurrent writer', async () => {
    const tenant = await createDurableTestDatabase({ kind: 'sqlcas2', ddl: '' });
    closers.push(tenant.close);
    await applyMigrations({ db: tenant.db, migrationsFolder: FRAMEWORK_DURABLE_TENANT_MIGRATIONS });
    const store = createSqlApprovalStore({ db: tenant.db, schemaName: FRAMEWORK_SCHEMA });
    const decideRequest = store.decideRequest.bind(store);
    store.decideRequest = async (row, decision) => {
      // Another approver settles the request between our read and our write.
      const current = await store.getRequest(row.approvalRequestId);
      if (current) {
        await store.transitionRequest({ ...current, state: 'rejected' }, ['pending']);
      }
      return decideRequest(row, decision);
    };
    const service = createApprovalService({
      authorization: createAllowAllAuthorizationProvider(),
      store,
    });
    const request = await service.requestApproval({
      tenantId: 'tenant-a',
      capabilityId: 'billing.issueRefund',
      definitionVersion: '1',
      input: { amount: 7 },
      riskClass: ActionRiskTier.Consequential,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      service.decide({
        requestId: request.approvalRequestId,
        outcome: 'approved',
        auth: humanAuth(),
      }),
    ).rejects.toBeInstanceOf(ApprovalDecisionConflictError);
    expect((await store.getRequest(request.approvalRequestId))?.state).toBe('rejected');
    expect(await store.listDecisions(request.approvalRequestId)).toEqual([]);
  });
});
