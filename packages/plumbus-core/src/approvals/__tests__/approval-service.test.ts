import { describe, expect, it } from 'vitest';
import type { AuthContext } from '../../types/security.js';
import { ActionRiskTier } from '../action-risk.js';
import {
  createAllowAllAuthorizationProvider,
  createDenyAuthorizationProvider,
} from '../authorization.js';
import { digestApprovalInput } from '../digest.js';
import { createMemoryApprovalStore } from '../memory-store.js';
import { createApprovalService } from '../service.js';
import { ApprovalDecisionConflictError, HumanTaskKind } from '../types.js';

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
    const service = createApprovalService({
      authorization: createAllowAllAuthorizationProvider(),
      store,
    });
    const request = await service.requestApproval({
      tenantId: 'tenant-1',
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
      tenantId: 'tenant-1',
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

    const allowed = createApprovalService({
      authorization: createAllowAllAuthorizationProvider(),
      store,
    });
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
    const expiredService = createApprovalService({
      authorization: createAllowAllAuthorizationProvider(),
      store: expiredStore,
      now: () => instant,
    });
    const expired = await expiredService.requestApproval({
      tenantId: 'tenant-1',
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
      tenantId: 'tenant-1',
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
    const service = createApprovalService({
      authorization: createAllowAllAuthorizationProvider(),
      store,
    });
    const request = await service.requestApproval({
      tenantId: 'tenant-1',
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
    const service = createApprovalService({
      authorization: createAllowAllAuthorizationProvider(),
      store: createMemoryApprovalStore(),
    });
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
      tenantId: 'tenant-1',
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
        tenantId: 'tenant-1',
        capabilityId: 'billing.refund',
        definitionVersion: '1',
        inputDigest: digestApprovalInput({ amount: 10 }),
      }),
    ).toBeUndefined();
  });

  it('refuses to create an approval request for a prohibited risk class', async () => {
    const service = createApprovalService({
      authorization: createAllowAllAuthorizationProvider(),
      store: createMemoryApprovalStore(),
    });
    await expect(
      service.requestApproval({
        tenantId: 'tenant-1',
        capabilityId: 'billing.refund',
        definitionVersion: '1',
        input: { amount: 10 },
        riskClass: ActionRiskTier.Prohibited,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow(/prohibited/);
  });

  it('finds an approval request by flow execution id', async () => {
    const service = createApprovalService({
      authorization: createAllowAllAuthorizationProvider(),
      store: createMemoryApprovalStore(),
    });
    await service.requestApproval({
      tenantId: 'tenant-1',
      capabilityId: 'billing.refund',
      definitionVersion: '1',
      input: { amount: 10 },
      riskClass: ActionRiskTier.Consequential,
      expiresAt: new Date(Date.now() + 60_000),
      executionId: 'exec-1',
    });
    const found = await service.findByExecutionId({ tenantId: 'tenant-1', executionId: 'exec-1' });
    expect(found?.executionId).toBe('exec-1');
    expect(
      await service.findByExecutionId({ tenantId: 'tenant-1', executionId: 'missing' }),
    ).toBeUndefined();
  });

  it('invalidates a prior binding when a material input change requests a new approval', async () => {
    const store = createMemoryApprovalStore();
    const service = createApprovalService({
      authorization: createAllowAllAuthorizationProvider(),
      store,
    });
    const first = await service.requestApproval({
      tenantId: 'tenant-1',
      capabilityId: 'billing.refund',
      definitionVersion: '1',
      input: { amount: 10 },
      riskClass: ActionRiskTier.Consequential,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const second = await service.requestApproval({
      tenantId: 'tenant-1',
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

  describe('authorization fails closed', () => {
    async function pendingRequest(service: ReturnType<typeof createApprovalService>) {
      return service.requestApproval({
        tenantId: 'tenant-1',
        capabilityId: 'billing.refund',
        definitionVersion: '1',
        input: { amount: 10 },
        riskClass: ActionRiskTier.Consequential,
        expiresAt: new Date(Date.now() + 60_000),
      });
    }

    it('refuses every decision type and cancellation when no authorization provider is configured', async () => {
      const store = createMemoryApprovalStore();
      const service = createApprovalService({ store });
      const request = await pendingRequest(service);
      for (const outcome of ['approved', 'rejected', 'changes-requested'] as const) {
        await expect(
          service.decide({ requestId: request.approvalRequestId, outcome, auth: humanAuth() }),
        ).rejects.toThrow(/no authorization provider/);
      }
      await expect(
        service.cancel({ requestId: request.approvalRequestId, auth: humanAuth(), reason: 'x' }),
      ).rejects.toThrow(/no authorization provider/);
      expect((await store.getRequest(request.approvalRequestId))?.state).toBe('pending');
      expect(await store.listDecisions(request.approvalRequestId)).toEqual([]);
    });

    it('runs the authorization provider for reject and changes-requested, not only approve', async () => {
      const store = createMemoryApprovalStore();
      const seen: string[] = [];
      const service = createApprovalService({
        store,
        authorization: {
          async revalidate({ auth }) {
            seen.push(auth.userId as string);
            return { allowed: false, reason: 'not an approver' };
          },
        },
      });
      const request = await pendingRequest(service);
      for (const outcome of ['rejected', 'changes-requested', 'approved'] as const) {
        await expect(
          service.decide({ requestId: request.approvalRequestId, outcome, auth: humanAuth() }),
        ).rejects.toThrow('not an approver');
      }
      expect(seen).toHaveLength(3);
      expect((await store.getRequest(request.approvalRequestId))?.state).toBe('pending');
      expect(await store.listDecisions(request.approvalRequestId)).toEqual([]);
    });

    it('refuses an outcome outside the decision set', async () => {
      const service = createApprovalService({
        store: createMemoryApprovalStore(),
        authorization: createAllowAllAuthorizationProvider(),
      });
      const request = await pendingRequest(service);
      await expect(
        service.decide({
          requestId: request.approvalRequestId,
          outcome: 'expired' as 'approved',
          auth: humanAuth(),
        }),
      ).rejects.toThrow(/Unknown approval decision outcome/);
    });
  });

  describe('tenant and execution binding', () => {
    const binding = {
      capabilityId: 'billing.refund',
      definitionVersion: '1',
      inputDigest: digestApprovalInput({ amount: 10 }),
    };

    async function approvedFor(
      service: ReturnType<typeof createApprovalService>,
      tenantId: string | null,
      executionId?: string,
    ) {
      const request = await service.requestApproval({
        tenantId,
        executionId,
        capabilityId: 'billing.refund',
        definitionVersion: '1',
        input: { amount: 10 },
        riskClass: ActionRiskTier.Consequential,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await service.decide({
        requestId: request.approvalRequestId,
        outcome: 'approved',
        auth: humanAuth(),
      });
      return request;
    }

    it('requires tenantId when requesting an approval', async () => {
      const service = createApprovalService({ store: createMemoryApprovalStore() });
      await expect(
        service.requestApproval({
          capabilityId: 'billing.refund',
          definitionVersion: '1',
          input: {},
          riskClass: ActionRiskTier.Consequential,
          expiresAt: new Date(Date.now() + 60_000),
        } as unknown as Parameters<typeof service.requestApproval>[0]),
      ).rejects.toThrow(/requires tenantId/);
    });

    it('never lets a tenant-A approval satisfy a tenant-B lookup on a shared service', async () => {
      const service = createApprovalService({
        store: createMemoryApprovalStore(),
        authorization: createAllowAllAuthorizationProvider(),
      });
      const request = await approvedFor(service, 'tenant-a');
      expect(
        (await service.findMatchingApproval({ ...binding, tenantId: 'tenant-a' }))
          ?.approvalRequestId,
      ).toBe(request.approvalRequestId);
      expect(await service.findMatchingApproval({ ...binding, tenantId: 'tenant-b' })).toBe(
        undefined,
      );
      expect(await service.findMatchingApproval({ ...binding, tenantId: null })).toBeUndefined();
    });

    it('never lets one execution consume an approval requested for another', async () => {
      const service = createApprovalService({
        store: createMemoryApprovalStore(),
        authorization: createAllowAllAuthorizationProvider(),
      });
      const request = await approvedFor(service, 'tenant-a', 'exec-1');
      expect(
        (
          await service.findMatchingApproval({
            ...binding,
            tenantId: 'tenant-a',
            executionId: 'exec-1',
          })
        )?.approvalRequestId,
      ).toBe(request.approvalRequestId);
      expect(
        await service.findMatchingApproval({
          ...binding,
          tenantId: 'tenant-a',
          executionId: 'exec-2',
        }),
      ).toBeUndefined();
      expect(await service.findMatchingApproval({ ...binding, tenantId: 'tenant-a' })).toBe(
        undefined,
      );
      expect(
        await service.findByExecutionId({ tenantId: 'tenant-b', executionId: 'exec-1' }),
      ).toBeUndefined();
      expect(
        (await service.findByExecutionId({ tenantId: 'tenant-a', executionId: 'exec-1' }))
          ?.approvalRequestId,
      ).toBe(request.approvalRequestId);
    });

    it("does not let another tenant's request invalidate this tenant's approval", async () => {
      const store = createMemoryApprovalStore();
      const service = createApprovalService({
        store,
        authorization: createAllowAllAuthorizationProvider(),
      });
      const request = await approvedFor(service, 'tenant-a');
      await service.requestApproval({
        tenantId: 'tenant-b',
        capabilityId: 'billing.refund',
        definitionVersion: '1',
        input: { amount: 999 },
        riskClass: ActionRiskTier.Consequential,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await service.invalidateOnMaterialChange({
        ...binding,
        tenantId: 'tenant-b',
        inputDigest: digestApprovalInput({ amount: 1 }),
      });
      expect((await store.getRequest(request.approvalRequestId))?.state).toBe('approved');
    });
  });

  describe('expiry at consumption', () => {
    it('reports an approved request as expired once expiresAt passes, even if the expiry write loses', async () => {
      const store = createMemoryApprovalStore();
      store.transitionRequest = async () => false;
      let now = new Date('2026-11-09T12:00:00.000Z');
      const service = createApprovalService({
        store,
        authorization: createAllowAllAuthorizationProvider(),
        now: () => now,
      });
      const request = await service.requestApproval({
        tenantId: 'tenant-1',
        executionId: 'exec-1',
        capabilityId: 'billing.refund',
        definitionVersion: '1',
        input: { amount: 10 },
        riskClass: ActionRiskTier.Consequential,
        expiresAt: new Date('2026-11-09T12:05:00.000Z'),
      });
      await service.decide({
        requestId: request.approvalRequestId,
        outcome: 'approved',
        auth: humanAuth(),
      });
      now = new Date('2026-11-09T12:05:00.000Z');
      expect(
        (await service.findByExecutionId({ tenantId: 'tenant-1', executionId: 'exec-1' }))?.state,
      ).toBe('expired');
      expect(
        (
          await service.findMatchingApproval({
            tenantId: 'tenant-1',
            executionId: 'exec-1',
            capabilityId: 'billing.refund',
            definitionVersion: '1',
            inputDigest: digestApprovalInput({ amount: 10 }),
          })
        )?.state,
      ).toBe('expired');
    });

    it('persists the expiry of an approved request when it is looked up after expiresAt', async () => {
      const store = createMemoryApprovalStore();
      let now = new Date('2026-11-09T12:00:00.000Z');
      const service = createApprovalService({
        store,
        authorization: createAllowAllAuthorizationProvider(),
        now: () => now,
      });
      const request = await service.requestApproval({
        tenantId: 'tenant-1',
        executionId: 'exec-1',
        capabilityId: 'billing.refund',
        definitionVersion: '1',
        input: { amount: 10 },
        riskClass: ActionRiskTier.Consequential,
        expiresAt: new Date('2026-11-09T12:05:00.000Z'),
      });
      await service.decide({
        requestId: request.approvalRequestId,
        outcome: 'approved',
        auth: humanAuth(),
      });
      now = new Date('2026-11-09T12:06:00.000Z');
      await service.findByExecutionId({ tenantId: 'tenant-1', executionId: 'exec-1' });
      expect((await store.getRequest(request.approvalRequestId))?.state).toBe('expired');
    });
  });

  describe('concurrent decisions', () => {
    it('applies exactly one of two racing decisions; the loser gets a conflict error', async () => {
      const store = createMemoryApprovalStore();
      const service = createApprovalService({
        store,
        authorization: createAllowAllAuthorizationProvider(),
      });
      const request = await service.requestApproval({
        tenantId: 'tenant-1',
        capabilityId: 'billing.refund',
        definitionVersion: '1',
        input: { amount: 10 },
        riskClass: ActionRiskTier.Consequential,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const results = await Promise.allSettled([
        service.decide({
          requestId: request.approvalRequestId,
          outcome: 'approved',
          auth: humanAuth({ userId: 'approver-a' }),
        }),
        service.decide({
          requestId: request.approvalRequestId,
          outcome: 'rejected',
          auth: humanAuth({ userId: 'approver-b' }),
        }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        ApprovalDecisionConflictError,
      );
      const winner = (fulfilled[0] as PromiseFulfilledResult<{ state: string }>).value.state;
      expect((await store.getRequest(request.approvalRequestId))?.state).toBe(winner);
      const decisions = await store.listDecisions(request.approvalRequestId);
      expect(decisions.map((d) => d.decision)).toEqual([winner]);
    });

    it('does not overwrite a cancellation that lands between the read and the decision write', async () => {
      const store = createMemoryApprovalStore();
      const decideRequest = store.decideRequest.bind(store);
      store.decideRequest = async (row, decision) => {
        const current = await store.getRequest(row.approvalRequestId);
        if (current) await store.putRequest({ ...current, state: 'cancelled' });
        return decideRequest(row, decision);
      };
      const service = createApprovalService({
        store,
        authorization: createAllowAllAuthorizationProvider(),
      });
      const request = await service.requestApproval({
        tenantId: 'tenant-1',
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
      ).rejects.toThrow(/already settled \(cancelled\)/);
      expect((await store.getRequest(request.approvalRequestId))?.state).toBe('cancelled');
      expect(await store.listDecisions(request.approvalRequestId)).toEqual([]);
    });
  });
});
