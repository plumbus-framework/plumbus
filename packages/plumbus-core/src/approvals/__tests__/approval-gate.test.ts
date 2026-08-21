import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { executeCapability } from '../../execution/capability-executor.js';
import { createExecutionContext } from '../../execution/context-factory.js';
import { executeStep } from '../../flows/step-executor.js';
import { FlowStepType } from '../../types/enums.js';
import type { CapabilityContract } from '../../types/capability.js';
import type { AuthContext } from '../../types/security.js';
import type { WaitStep } from '../../types/flow.js';
import { ActionRiskTier } from '../action-risk.js';
import { createAllowAllAuthorizationProvider } from '../authorization.js';
import { digestApprovalInput } from '../digest.js';
import { createMemoryApprovalStore } from '../memory-store.js';
import { createApprovalService } from '../service.js';
import { APPROVAL_PENDING_WAIT } from '../wait.js';

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'user-1',
    roles: ['admin'],
    scopes: ['write'],
    provider: 'oidc',
    tenantId: 'tenant-1',
    ...overrides,
  };
}

function makeConsequential(handler = vi.fn(async () => ({ ok: true }))) {
  const capability = {
    name: 'issueRefund',
    kind: 'action',
    domain: 'billing',
    version: '1.2.0',
    riskTier: ActionRiskTier.Consequential,
    input: z.object({ amount: z.number() }),
    output: z.object({ ok: z.boolean() }),
    effects: { data: ['Refund'], events: [], external: [], ai: false },
    access: { roles: ['admin'] },
    handler,
  } as CapabilityContract;
  return { capability, handler };
}

describe('approval gate in executeCapability', () => {
  it('does not run a consequential handler without a matching unexpired approval', async () => {
    const { capability, handler } = makeConsequential();
    const approvals = createApprovalService({ store: createMemoryApprovalStore() });
    const ctx = createExecutionContext({
      auth: makeAuth(),
      data: {},
      approvals,
    });

    const result = await executeCapability(capability, ctx, { amount: 25 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.metadata?.approvalGate).toBe('missing-approval');
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects an expired approval even when the digest still matches', async () => {
    const { capability, handler } = makeConsequential();
    let now = new Date('2026-08-20T10:00:00.000Z');
    const approvals = createApprovalService({
      store: createMemoryApprovalStore(),
      now: () => now,
    });
    const request = await approvals.requestApproval({
      capabilityId: 'billing.issueRefund',
      definitionVersion: '1.2.0',
      input: { amount: 25 },
      riskClass: ActionRiskTier.Consequential,
      expiresAt: new Date('2026-08-20T10:05:00.000Z'),
    });
    await approvals.decide({
      requestId: request.approvalRequestId,
      outcome: 'approved',
      auth: makeAuth({ userId: 'approver-1', roles: ['reviewer'] }),
    });

    now = new Date('2026-08-20T10:06:00.000Z');
    const ctx = createExecutionContext({
      auth: makeAuth(),
      data: {},
      approvals,
      time: { now: () => now },
    });

    const result = await executeCapability(capability, ctx, { amount: 25 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.metadata?.approvalGate).toBe('expired-approval');
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('invalidates the binding when the input digest changes', async () => {
    const { capability, handler } = makeConsequential();
    const approvals = createApprovalService({ store: createMemoryApprovalStore() });
    const request = await approvals.requestApproval({
      capabilityId: 'billing.issueRefund',
      definitionVersion: '1.2.0',
      input: { amount: 25 },
      riskClass: ActionRiskTier.Consequential,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await approvals.decide({
      requestId: request.approvalRequestId,
      outcome: 'approved',
      auth: makeAuth({ userId: 'approver-1', roles: ['reviewer'] }),
    });

    const ctx = createExecutionContext({
      auth: makeAuth(),
      data: {},
      approvals,
    });

    const result = await executeCapability(capability, ctx, { amount: 99 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.metadata?.approvalGate).toBe('input-digest-mismatch');
    }
    expect(handler).not.toHaveBeenCalled();
    expect(
      await approvals.findMatchingApproval({
        capabilityId: 'billing.issueRefund',
        definitionVersion: '1.2.0',
        inputDigest: digestApprovalInput({ amount: 25 }),
      }),
    ).toBeUndefined();
  });

  it('revalidates authorization after the approval wait before the handler runs', async () => {
    const { capability, handler } = makeConsequential();
    const approvals = createApprovalService({ store: createMemoryApprovalStore() });
    const request = await approvals.requestApproval({
      capabilityId: 'billing.issueRefund',
      definitionVersion: '1.2.0',
      input: { amount: 25 },
      riskClass: ActionRiskTier.Consequential,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await approvals.decide({
      requestId: request.approvalRequestId,
      outcome: 'approved',
      auth: makeAuth({ userId: 'approver-1', roles: ['reviewer'] }),
    });

    const waitStep: WaitStep = {
      name: 'awaitApproval',
      type: FlowStepType.Wait,
      event: APPROVAL_PENDING_WAIT,
    };
    const wait = await executeStep(
      waitStep,
      createExecutionContext({ auth: makeAuth(), data: {} }),
      {},
      {},
      {
        executeCapability: async () => ({ success: true, data: {} }),
        evaluateCondition: () => true,
      },
    );
    expect(wait.waitEvent).toBe(APPROVAL_PENDING_WAIT);

    const ctx = createExecutionContext({
      auth: makeAuth(),
      data: {},
      approvals,
      authorizationProvider: {
        async revalidate() {
          return { allowed: false, reason: 'grant withdrawn during wait' };
        },
      },
    });

    const result = await executeCapability(capability, ctx, { amount: 25 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.metadata?.approvalGate).toBe('authorization-revalidation-denied');
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs the handler when a matching unexpired approval is bound', async () => {
    const { capability, handler } = makeConsequential();
    const approvals = createApprovalService({ store: createMemoryApprovalStore() });
    const request = await approvals.requestApproval({
      capabilityId: 'billing.issueRefund',
      definitionVersion: '1.2.0',
      input: { amount: 25 },
      riskClass: ActionRiskTier.Consequential,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await approvals.decide({
      requestId: request.approvalRequestId,
      outcome: 'approved',
      auth: makeAuth({ userId: 'approver-1', roles: ['reviewer'] }),
    });

    const ctx = createExecutionContext({
      auth: makeAuth(),
      data: {},
      approvals,
      authorizationProvider: createAllowAllAuthorizationProvider(),
    });

    const result = await executeCapability(capability, ctx, { amount: 25 });

    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });
});
