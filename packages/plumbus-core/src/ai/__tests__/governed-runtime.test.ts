import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { ActionRiskTier } from '../../approvals/action-risk.js';
import { createMemoryApprovalStore } from '../../approvals/memory-store.js';
import { createApprovalService } from '../../approvals/service.js';
import { createMemoryCredentialCatalog } from '../../credentials/catalog.js';
import { defineCapability } from '../../define/defineCapability.js';
import { CapabilityRegistry } from '../../execution/capability-registry.js';
import type { AuthContext } from '../../types/security.js';
import { ConsumerRegistry } from '../../events/consumer-registry.js';
import { createOutboxDispatcher } from '../../events/dispatcher.js';
import { createEventEmitter } from '../../events/emitter.js';
import { createFlowScheduler } from '../../flows/scheduler.js';
import { createMemoryGovernedArtifactStore } from '../governed-artifacts.js';
import type { GovernedAiHost } from '../governed-host.js';
import { governedReviewSubject } from '../governed-invoke.js';
import {
  createPlumbusRuntime,
  type PlumbusRuntimeConfig,
} from '../governed-runtime.js';

function humanAuth(): AuthContext {
  return {
    userId: 'reviewer-1',
    roles: ['reviewer'],
    scopes: [],
    provider: 'oidc',
    tenantId: 'tenant-1',
  };
}

const getInvoice = defineCapability({
  name: 'getInvoice',
  kind: 'query',
  domain: 'billing',
  input: z.object({ invoiceId: z.string() }),
  output: z.object({ invoiceId: z.string(), total: z.number() }),
  access: { public: true },
  effects: { data: [], events: [], external: [], ai: false },
  handler: async (_ctx, input) => ({ invoiceId: input.invoiceId, total: 42 }),
});

describe('createPlumbusRuntime', () => {
  it('invokes governed AI without the caller assembling deps', async () => {
    const artifacts = createMemoryGovernedArtifactStore();
    const prompt = artifacts.publish({
      kind: 'prompt',
      id: 'example.summarize',
      body: 'Summarize clearly.',
    });
    const policy = artifacts.publish({
      kind: 'policy',
      id: 'example.summarize.policy',
      body: 'Do not invent facts.',
    });
    const pin = {
      providerId: 'host-provider',
      modelId: 'host-model-a',
      promptDigest: prompt.digest,
      policyDigest: policy.digest,
    };
    const complete = vi.fn(async () => ({ text: 'ok', costUsd: 0.01 }));
    const host: GovernedAiHost = {
      async resolveModel() {
        return { providerId: pin.providerId, modelId: pin.modelId, complete };
      },
      async checkBudget() {
        return { allowed: true };
      },
    };
    const approvals = createApprovalService({ store: createMemoryApprovalStore() });
    const runtime = createPlumbusRuntime({ host, approvals, artifacts });
    const input = { documentId: 'doc-1' };

    const request = await runtime.approvals!.requestApproval({
      capabilityId: 'example.summarize',
      definitionVersion: '1',
      input: governedReviewSubject(input, pin),
      riskClass: ActionRiskTier.Consequential,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await runtime.approvals!.decide({
      requestId: request.approvalRequestId,
      outcome: 'approved',
      auth: humanAuth(),
    });

    const result = await runtime.invokeGovernedAi({
      capabilityId: 'example.summarize',
      definitionVersion: '1',
      input,
      pin,
      prompt: 'Summarize this document.',
      estimatedCostUsd: 0.01,
    });

    expect(result.text).toBe('ok');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('invokes a registered capability without the host minting ctx', async () => {
    const capabilities = new CapabilityRegistry();
    capabilities.register(getInvoice);
    const runtime = createPlumbusRuntime({
      capabilities,
      auth: humanAuth(),
    });

    const result = await runtime.invokeCapability('billing.getInvoice', {
      invoiceId: 'inv-1',
    });

    expect(result).toEqual({
      success: true,
      data: { invoiceId: 'inv-1', total: 42 },
    });
  });

  it('returns not-found when the capability is unregistered', async () => {
    const runtime = createPlumbusRuntime({ auth: humanAuth() });
    const result = await runtime.invokeCapability('billing.missing', {});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('notFound');
    }
  });

  it('starts a flow and inspects execution through the wired engine', async () => {
    const start = vi.fn().mockResolvedValue({
      id: 'exec-1',
      flowName: 'example.flow-a',
      status: 'running',
    });
    const status = vi.fn().mockResolvedValue({
      id: 'exec-1',
      flowName: 'example.flow-a',
      status: 'completed',
    });
    const runtime = createPlumbusRuntime({
      auth: humanAuth(),
      flows: { start, status },
    });

    const started = await runtime.startFlow('example.flow-a', { orderId: 'ord-1' });
    expect(started.id).toBe('exec-1');
    expect(start).toHaveBeenCalledWith(
      'example.flow-a',
      { orderId: 'ord-1' },
      humanAuth(),
      { executionId: undefined },
    );

    const inspected = await runtime.inspectExecution('exec-1');
    expect(inspected.status).toBe('completed');
    expect(status).toHaveBeenCalledWith('exec-1');
  });

  it('refuses flow calls when no engine was wired', async () => {
    const runtime = createPlumbusRuntime({ auth: humanAuth() });
    await expect(runtime.startFlow('example.flow-a', {})).rejects.toThrow(
      'not configured with a flow engine',
    );
    await expect(runtime.inspectExecution('exec-1')).rejects.toThrow(
      'not configured with a flow engine',
    );
  });

  it('publishes events and registers a consumer through the wired pieces', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const emitMany = vi.fn().mockResolvedValue(undefined);
    const register = vi.fn();
    const poll = vi.fn().mockResolvedValue(2);
    const runtime = createPlumbusRuntime({
      events: { emit, emitMany },
      subscriptions: { register },
      eventPump: { poll, start: vi.fn(), stop: vi.fn() },
    });

    await runtime.publishEvent('example.accepted', { orderId: 'ord-1' });
    expect(emit).toHaveBeenCalledWith('example.accepted', { orderId: 'ord-1' });

    await runtime.publishEvents([{ eventName: 'example.queued', payload: { orderId: 'ord-1' } }]);
    expect(emitMany).toHaveBeenCalledTimes(1);

    runtime.subscribe({
      id: 'example.record',
      eventTypes: ['example.accepted'],
      handler: async () => {},
    });
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ id: 'example.record' }));

    expect(await runtime.pumpEvents()).toBe(2);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('syncs and polls timers through the wired scheduler', async () => {
    const syncSchedules = vi.fn().mockResolvedValue(1);
    const poll = vi.fn().mockResolvedValue(3);
    const runtime = createPlumbusRuntime({
      timers: { syncSchedules, poll, start: vi.fn(), stop: vi.fn() },
    });

    expect(await runtime.syncTimers()).toBe(1);
    expect(await runtime.pollTimers()).toBe(3);
    expect(syncSchedules).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('accepts the existing emitter, dispatcher, registry, and scheduler', () => {
    expectTypeOf<ReturnType<typeof createEventEmitter>>().toMatchTypeOf<
      NonNullable<PlumbusRuntimeConfig['events']>
    >();
    expectTypeOf<ReturnType<typeof createOutboxDispatcher>>().toMatchTypeOf<
      NonNullable<PlumbusRuntimeConfig['eventPump']>
    >();
    expectTypeOf<ConsumerRegistry>().toMatchTypeOf<
      NonNullable<PlumbusRuntimeConfig['subscriptions']>
    >();
    expectTypeOf<ReturnType<typeof createFlowScheduler>>().toMatchTypeOf<
      NonNullable<PlumbusRuntimeConfig['timers']>
    >();
  });

  it('refuses event and timer calls when those pieces were not wired', async () => {
    const runtime = createPlumbusRuntime({});
    await expect(runtime.publishEvent('example.accepted', {})).rejects.toThrow(
      'not configured with an event emitter',
    );
    await expect(runtime.pumpEvents()).rejects.toThrow('not configured with an event pump');
    expect(() =>
      runtime.subscribe({ id: 'x', eventTypes: ['example.accepted'], handler: async () => {} }),
    ).toThrow('not configured with a consumer registry');
    await expect(runtime.syncTimers()).rejects.toThrow('not configured with a scheduler');
  });

  it('exposes a host credential catalog when one is wired', () => {
    const credentials = createMemoryCredentialCatalog({
      types: [{ id: 'smtp', fields: [{ name: 'password', secret: true }] }],
    });
    const runtime = createPlumbusRuntime({ credentials });
    expect(runtime.credentials).toBe(credentials);
    expect(runtime.credentials?.listTypes().map((type) => type.id)).toEqual(['smtp']);
  });
});
