import { afterAll, describe, expect, it } from 'vitest';
import { FRAMEWORK_SCHEMA } from '../../data/schema-generator.js';
import { applyMigrations } from '../../data/migration.js';
import { PLAN02_DB_NAME_PATTERN } from '../../durable/apply-ddl.js';
import { createPlan02Database } from '../../durable/harness.js';
import { FRAMEWORK_DURABLE_TENANT_MIGRATIONS } from '../../durable/migrations-path.js';
import { ActionRiskTier } from '../action-risk.js';
import { digestApprovalInput } from '../digest.js';
import { createApprovalService } from '../service.js';
import { createSqlApprovalStore } from '../sql-store.js';
import { HumanTaskKind } from '../types.js';

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

  it('persists requests, decisions, and tasks on a dedicated plumbus_plan02_* plane', async () => {
    const tenant = await createPlan02Database({ kind: 'sqlappr', ddl: '' });
    closers.push(tenant.close);

    expect(tenant.name).toMatch(PLAN02_DB_NAME_PATTERN);
    expect(tenant.name).not.toMatch(/tenant_qv/);

    await applyMigrations({
      db: tenant.db,
      migrationsFolder: FRAMEWORK_DURABLE_TENANT_MIGRATIONS,
    });

    const service = createApprovalService({
      db: () => tenant.db,
      schemaName: FRAMEWORK_SCHEMA,
    });

    const request = await service.requestApproval({
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
    expect((await reloaded.listDecisions(request.approvalRequestId)).map((row) => row.decision)).toEqual([
      'approved',
    ]);
    expect((await reloaded.getTask(task.humanTaskId))?.state).toBe('completed');

    const match = await service.findMatchingApproval({
      capabilityId: 'billing.issueRefund',
      definitionVersion: '1.2.0',
      inputDigest: digestApprovalInput({ amount: 25 }),
    });
    expect(match?.approvalRequestId).toBe(request.approvalRequestId);
  });
});
