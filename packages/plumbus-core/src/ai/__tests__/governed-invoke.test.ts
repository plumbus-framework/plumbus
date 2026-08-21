import { describe, expect, it, vi } from 'vitest';
import { ActionRiskTier } from '../../approvals/action-risk.js';
import { createMemoryApprovalStore } from '../../approvals/memory-store.js';
import { createApprovalService } from '../../approvals/service.js';
import type { AuthContext } from '../../types/security.js';
import { GovernedAiBlockedError } from '../../errors/data-errors.js';
import { checkGovernedBudget } from '../governed-budget.js';
import {
  createMemoryGovernedArtifactStore,
  type GovernedArtifactStore,
} from '../governed-artifacts.js';
import type { GovernedAiHost, GovernedModel, GovernedModelPin } from '../governed-host.js';
import { governedReviewSubject, invokeGovernedAi } from '../governed-invoke.js';
import { createCostTracker } from '../cost-tracker.js';

function humanAuth(): AuthContext {
  return {
    userId: 'reviewer-1',
    roles: ['reviewer'],
    scopes: [],
    provider: 'oidc',
    tenantId: 'tenant-1',
  };
}

function setupArtifacts(): { artifacts: GovernedArtifactStore; pin: GovernedModelPin } {
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
  return {
    artifacts,
    pin: {
      providerId: 'host-provider',
      modelId: 'host-model-a',
      promptDigest: prompt.digest,
      policyDigest: policy.digest,
    },
  };
}

function createHost(
  pin: GovernedModelPin,
  opts?: {
    model?: GovernedModel;
    allowed?: boolean;
    budgetReason?: string;
  },
): { host: GovernedAiHost; complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(async () => ({ text: 'ok', costUsd: 0.01 }));
  const model: GovernedModel = opts?.model ?? {
    providerId: pin.providerId,
    modelId: pin.modelId,
    complete,
  };
  return {
    complete,
    host: {
      async resolveModel(requested) {
        if (requested.providerId === pin.providerId && requested.modelId === pin.modelId) {
          return model;
        }
        return undefined;
      },
      async checkBudget() {
        return {
          allowed: opts?.allowed ?? true,
          reason: opts?.budgetReason,
        };
      },
    },
  };
}

async function approve(
  approvals: ReturnType<typeof createApprovalService>,
  input: unknown,
  pin: GovernedModelPin,
) {
  const request = await approvals.requestApproval({
    capabilityId: 'example.summarize',
    definitionVersion: '1',
    input: governedReviewSubject(input, pin),
    riskClass: ActionRiskTier.Consequential,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await approvals.decide({
    requestId: request.approvalRequestId,
    outcome: 'approved',
    auth: humanAuth(),
  });
  return request;
}

describe('invokeGovernedAi', () => {
  it('calls the host model only after review, artifacts, and budget pass', async () => {
    const { artifacts, pin } = setupArtifacts();
    const approvals = createApprovalService({ store: createMemoryApprovalStore() });
    const { host, complete } = createHost(pin);
    const input = { documentId: 'doc-1' };
    await approve(approvals, input, pin);

    const result = await invokeGovernedAi(
      { host, approvals, artifacts },
      {
        capabilityId: 'example.summarize',
        definitionVersion: '1',
        input,
        pin,
        prompt: 'Summarize this document.',
        estimatedCostUsd: 0.01,
      },
    );

    expect(result.text).toBe('ok');
    expect(result.prompt.body).toBe('Summarize clearly.');
    expect(result.policy.body).toBe('Do not invent facts.');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ system: 'Summarize clearly.' }),
    );
  });

  it('does not call the model without a human review', async () => {
    const { artifacts, pin } = setupArtifacts();
    const approvals = createApprovalService({ store: createMemoryApprovalStore() });
    const { host, complete } = createHost(pin);

    await expect(
      invokeGovernedAi(
        { host, approvals, artifacts },
        {
          capabilityId: 'example.summarize',
          definitionVersion: '1',
          input: { documentId: 'doc-1' },
          pin,
          prompt: 'Summarize this document.',
        },
      ),
    ).rejects.toMatchObject({ name: 'GovernedAiBlockedError', blockedCode: 'missing-review' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not call the model when review binds a different pin', async () => {
    const { artifacts, pin } = setupArtifacts();
    const other = artifacts.publish({
      kind: 'prompt',
      id: 'example.summarize.other',
      body: 'Older prompt.',
    });
    const approvals = createApprovalService({ store: createMemoryApprovalStore() });
    const { host, complete } = createHost(pin);
    const input = { documentId: 'doc-1' };
    await approve(approvals, input, { ...pin, promptDigest: other.digest });

    await expect(
      invokeGovernedAi(
        { host, approvals, artifacts },
        {
          capabilityId: 'example.summarize',
          definitionVersion: '1',
          input,
          pin,
          prompt: 'Summarize this document.',
        },
      ),
    ).rejects.toMatchObject({ blockedCode: 'missing-review' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not call the model for an unpublished prompt digest', async () => {
    const { artifacts, pin } = setupArtifacts();
    const approvals = createApprovalService({ store: createMemoryApprovalStore() });
    const { host, complete } = createHost(pin);

    await expect(
      invokeGovernedAi(
        { host, approvals, artifacts },
        {
          capabilityId: 'example.summarize',
          definitionVersion: '1',
          input: { documentId: 'doc-1' },
          pin: { ...pin, promptDigest: 'a'.repeat(64) },
          prompt: 'Summarize this document.',
        },
      ),
    ).rejects.toMatchObject({ blockedCode: 'unpinned-prompt' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not call the model when the prompt digest is empty', async () => {
    const { artifacts, pin } = setupArtifacts();
    const approvals = createApprovalService({ store: createMemoryApprovalStore() });
    const { host, complete } = createHost(pin);

    await expect(
      invokeGovernedAi(
        { host, approvals, artifacts },
        {
          capabilityId: 'example.summarize',
          definitionVersion: '1',
          input: { documentId: 'doc-1' },
          pin: { ...pin, promptDigest: '  ' },
          prompt: 'Summarize this document.',
        },
      ),
    ).rejects.toMatchObject({ blockedCode: 'unpinned-prompt' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not call the model for an unregistered pin', async () => {
    const { artifacts, pin } = setupArtifacts();
    const approvals = createApprovalService({ store: createMemoryApprovalStore() });
    const { host, complete } = createHost(pin);

    await expect(
      invokeGovernedAi(
        { host, approvals, artifacts },
        {
          capabilityId: 'example.summarize',
          definitionVersion: '1',
          input: { documentId: 'doc-1' },
          pin: { ...pin, modelId: 'unknown-model' },
          prompt: 'Summarize this document.',
        },
      ),
    ).rejects.toMatchObject({ blockedCode: 'unregistered-model' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not call the model when the host substitutes a different model', async () => {
    const { artifacts, pin } = setupArtifacts();
    const approvals = createApprovalService({ store: createMemoryApprovalStore() });
    const complete = vi.fn(async () => ({ text: 'ok' }));
    const { host } = createHost(pin, {
      model: {
        providerId: 'other-provider',
        modelId: 'other-model',
        complete,
      },
    });

    await expect(
      invokeGovernedAi(
        { host, approvals, artifacts },
        {
          capabilityId: 'example.summarize',
          definitionVersion: '1',
          input: { documentId: 'doc-1' },
          pin,
          prompt: 'Summarize this document.',
        },
      ),
    ).rejects.toMatchObject({ blockedCode: 'model-pin-mismatch' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not call the model when the budget check refuses', async () => {
    const { artifacts, pin } = setupArtifacts();
    const approvals = createApprovalService({ store: createMemoryApprovalStore() });
    const { host, complete } = createHost(pin, {
      allowed: false,
      budgetReason: 'Daily cost limit reached',
    });
    const input = { documentId: 'doc-1' };
    await approve(approvals, input, pin);

    await expect(
      invokeGovernedAi(
        { host, approvals, artifacts },
        {
          capabilityId: 'example.summarize',
          definitionVersion: '1',
          input,
          pin,
          prompt: 'Summarize this document.',
          estimatedCostUsd: 9,
        },
      ),
    ).rejects.toMatchObject({ blockedCode: 'budget-exceeded' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not call the model when budget cost is unknown', async () => {
    const { artifacts, pin } = setupArtifacts();
    const approvals = createApprovalService({ store: createMemoryApprovalStore() });
    const { host, complete } = createHost(pin, {
      allowed: false,
      budgetReason: 'Cost data unavailable — usage API not configured.',
    });
    const input = { documentId: 'doc-1' };
    await approve(approvals, input, pin);

    await expect(
      invokeGovernedAi(
        { host, approvals, artifacts },
        {
          capabilityId: 'example.summarize',
          definitionVersion: '1',
          input,
          pin,
          prompt: 'Summarize this document.',
        },
      ),
    ).rejects.toMatchObject({ blockedCode: 'budget-unknown' });
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('checkGovernedBudget', () => {
  it('refuses when no budget limit is declared', () => {
    expect(checkGovernedBudget({})).toEqual({
      allowed: false,
      reason: 'Governed AI requires a declared budget limit',
    });
  });

  it('refuses unknown dollar cost even when the tracker would allow it', () => {
    const tracker = createCostTracker({ dailyCostLimit: 1 });
    tracker.record({
      model: 'host-model-a',
      provider: 'host-provider',
      operation: 'generate',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      cost: null,
      latencyMs: 10,
    });

    expect(tracker.checkBudget({}).allowed).toBe(true);
    expect(checkGovernedBudget({ tracker, budget: { dailyCostLimit: 1 } }).allowed).toBe(false);
  });

  it('allows a call that stays under a declared dollar cap', () => {
    const tracker = createCostTracker({ dailyCostLimit: 1 });
    expect(
      checkGovernedBudget({
        tracker,
        budget: { dailyCostLimit: 1 },
        estimatedCostUsd: 0.05,
      }).allowed,
    ).toBe(true);
  });
});

describe('GovernedAiBlockedError', () => {
  it('is a forbidden Plumbus error', () => {
    const error = new GovernedAiBlockedError('missing-review', 'needs review');
    expect(error.name).toBe('GovernedAiBlockedError');
    expect(error.blockedCode).toBe('missing-review');
  });
});
