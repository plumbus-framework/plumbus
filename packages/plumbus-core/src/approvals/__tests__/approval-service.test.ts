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
  it('cancels a pending request and its open tasks without writing a decision', async () => {
    const store = createMemoryApprovalStore();
    const service = createApprovalService({ store });
    const request = await service.requestApproval({
      capabilityId: 'feedback.publish',
      definitionVersion: '1',
      input: { revision: 'r1' },
      riskClass: ActionRiskTier.Consequential,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const task = await service.createHumanTask({
      kind: HumanTaskKind.Approval,
      approvalRequestId: request.approvalRequestId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const claimedTask = await service.createHumanTask({
      kind: HumanTaskKind.Approval,
      approvalRequestId: request.approvalRequestId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await store.putTask({ ...claimedTask, state: 'claimed' });
    const completedTask = await service.createHumanTask({
      kind: HumanTaskKind.Approval,
      approvalRequestId: request.approvalRequestId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await service.completeHumanTask({ taskId: completedTask.humanTaskId, auth: humanAuth() });

    const cancelled = await service.cancel({
      requestId: request.approvalRequestId,
      auth: humanAuth({ userId: 'requester-1' }),
      reason: 'requester-withdrew',
    });

    expect(cancelled).toMatchObject({
      state: 'cancelled',
      cancelledByAccountId: 'requester-1',
      cancellationReason: 'requester-withdrew',
    });
    expect((await store.getTask(task.humanTaskId))?.state).toBe('cancelled');
    expect((await store.getTask(claimedTask.humanTaskId))?.state).toBe('cancelled');
    expect((await store.getTask(completedTask.humanTaskId))?.state).toBe('completed');
    expect(await store.listDecisions(request.approvalRequestId)).toEqual([]);
  });

  it('refuses unauthorized, expired, repeated, and malformed cancellations without mutation', async () => {
    const store = createMemoryApprovalStore();
    const denied = createApprovalService({
      store,
      authorization: createDenyAuthorizationProvider('not the requester'),
    });
    const request = await denied.requestApproval({
      capabilityId: 'feedback.publish',
      definitionVersion: '1',
      input: {},
      riskClass: ActionRiskTier.Consequential,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      denied.cancel({
        requestId: request.approvalRequestId,
        auth: humanAuth(),
        reason: 'withdraw',
      }),
    ).rejects.toThrow('not the requester');
    expect((await store.getRequest(request.approvalRequestId))?.state).toBe('pending');
    await expect(
      denied.cancel({ requestId: request.approvalRequestId, auth: humanAuth(), reason: ' ' }),
    ).rejects.toThrow(/1 to 500/);
    await expect(
      denied.cancel({ requestId: 'missing', auth: humanAuth(), reason: 'withdraw' }),
    ).rejects.toThrow(/not found/);

    const allowed = createApprovalService({ store });
    await allowed.cancel({
      requestId: request.approvalRequestId,
      auth: humanAuth(),
      reason: 'withdraw',
    });
    await expect(
      allowed.cancel({ requestId: request.approvalRequestId, auth: humanAuth(), reason: 'again' }),
    ).rejects.toThrow(/is cancelled/);

    const expiredStore = createMemoryApprovalStore();
    const instant = new Date('2026-09-17T12:00:00.000Z');
    const expiredService = createApprovalService({ store: expiredStore, now: () => instant });
    const expired = await expiredService.requestApproval({
      capabilityId: 'feedback.publish',
      definitionVersion: '1',
      input: {},
      riskClass: ActionRiskTier.Consequential,
      expiresAt: new Date(instant.getTime() - 1),
    });
    await expect(
      expiredService.cancel({
        requestId: expired.approvalRequestId,
        auth: humanAuth(),
        reason: 'late',
      }),
    ).rejects.toThrow(/is expired/);

    const actorRequest = await allowed.requestApproval({
      capabilityId: 'feedback.publish.other',
      definitionVersion: '1',
      input: {},
      riskClass: ActionRiskTier.Consequential,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      allowed.cancel({
        requestId: actorRequest.approvalRequestId,
        auth: humanAuth({ userId: undefined }),
        reason: 'withdraw',
      }),
    ).rejects.toThrow(/authenticated human actor/);
  });

  it('does not overwrite a settlement that wins the cancellation race', async () => {
    const store = createMemoryApprovalStore();
    const cancelRequest = store.cancelRequest.bind(store);
    store.cancelRequest = async (row) => {
      const current = await store.getRequest(row.approvalRequestId);
      if (current) await store.putRequest({ ...current, state: 'approved' });
      return cancelRequest(row);
    };
    const service = createApprovalService({ store });
    const request = await service.requestApproval({
      capabilityId: 'feedback.publish',
      definitionVersion: '1',
      input: {},
      riskClass: ActionRiskTier.Consequential,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      service.cancel({
        requestId: request.approvalRequestId,
        auth: humanAuth(),
        reason: 'withdraw',
      }),
    ).rejects.toThrow(/is approved/);
    expect((await store.getRequest(request.approvalRequestId))?.state).toBe('approved');
  });
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

  it('refuses to create an approval request for a prohibited risk class', async () => {
    const service = createApprovalService({ store: createMemoryApprovalStore() });
    await expect(
      service.requestApproval({
        capabilityId: 'billing.refund',
        definitionVersion: '1',
        input: { amount: 10 },
        riskClass: ActionRiskTier.Prohibited,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow(/prohibited/);
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
