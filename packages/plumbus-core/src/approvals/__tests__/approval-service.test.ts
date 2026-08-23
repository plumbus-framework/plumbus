import { describe, expect, it } from 'vitest';
import type { AuthContext } from '../../types/security.js';
import { ActionRiskTier } from '../action-risk.js';
import { createDenyAuthorizationProvider } from '../authorization.js';
import { digestApprovalInput } from '../digest.js';
import { HumanTaskKind } from '../types.js';
import { createMemoryApprovalStore } from '../memory-store.js';
import { createApprovalService } from '../service.js';

function humanAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'approver-1',
    roles: ['reviewer'],
    scopes: [],
    provider: 'oidc',
    tenantId: 'tenant-1',
    ...overrides,
  };
}

describe('createApprovalService', () => {
  it('refuses human-task completion by a service principal or unauthenticated callback', async () => {
    const service = createApprovalService({ store: createMemoryApprovalStore() });
    const task = await service.createHumanTask({
      kind: HumanTaskKind.Approval,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      service.completeHumanTask({
        taskId: task.humanTaskId,
        auth: humanAuth({ userId: undefined }),
      }),
    ).rejects.toThrow(/authenticated human actor/);
    await expect(
      service.completeHumanTask({
        taskId: task.humanTaskId,
        auth: humanAuth({ roles: ['system'] }),
      }),
    ).rejects.toThrow(/authenticated human actor/);
    await expect(
      service.completeHumanTask({
        taskId: task.humanTaskId,
        auth: humanAuth({ provider: 'worker' }),
      }),
    ).rejects.toThrow(/authenticated human actor/);

    const completed = await service.completeHumanTask({
      taskId: task.humanTaskId,
      auth: humanAuth(),
    });
    expect(completed.state).toBe('completed');
  });

  it('revalidates authorization on approved decisions and leaves the request pending on deny', async () => {
    const service = createApprovalService({
      store: createMemoryApprovalStore(),
      authorization: createDenyAuthorizationProvider('stale grant'),
    });
    const request = await service.requestApproval({
      capabilityId: 'billing.refund',
      definitionVersion: '1',
      input: { amount: 10 },
      riskClass: ActionRiskTier.Consequential,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      service.decide({
        requestId: request.approvalRequestId,
        outcome: 'approved',
        auth: humanAuth(),
      }),
    ).rejects.toThrow('stale grant');
    expect(
      await service.findMatchingApproval({
        capabilityId: 'billing.refund',
        definitionVersion: '1',
        inputDigest: digestApprovalInput({ amount: 10 }),
      }),
    ).toBeUndefined();
  });

  it('finds an approval request by flow execution id', async () => {
    const service = createApprovalService({ store: createMemoryApprovalStore() });
    await service.requestApproval({
      capabilityId: 'billing.refund',
      definitionVersion: '1',
      input: { amount: 10 },
      riskClass: ActionRiskTier.Consequential,
      expiresAt: new Date(Date.now() + 60_000),
      executionId: 'exec-1',
    });
    const found = await service.findByExecutionId('exec-1');
    expect(found?.executionId).toBe('exec-1');
    expect(await service.findByExecutionId('missing')).toBeUndefined();
  });

  it('invalidates a prior binding when a material input change requests a new approval', async () => {
    const store = createMemoryApprovalStore();
    const service = createApprovalService({ store });
    const first = await service.requestApproval({
      capabilityId: 'billing.refund',
      definitionVersion: '1',
      input: { amount: 10 },
      riskClass: ActionRiskTier.Consequential,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const second = await service.requestApproval({
      capabilityId: 'billing.refund',
      definitionVersion: '1',
      input: { amount: 99 },
      riskClass: ActionRiskTier.Consequential,
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(first.approvalRequestId).not.toBe(second.approvalRequestId);
    expect((await store.getRequest(first.approvalRequestId))?.state).toBe('invalidated');
    expect((await store.getRequest(second.approvalRequestId))?.state).toBe('pending');
  });
});
