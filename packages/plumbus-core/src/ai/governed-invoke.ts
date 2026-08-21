import { digestApprovalInput } from '../approvals/digest.js';
import { ApprovalRequestState, type ApprovalService } from '../approvals/types.js';
import { GovernedAiBlockedError, type GovernedAiBlockedCode } from '../errors/data-errors.js';
import type { GovernedArtifactStore, PublishedGovernedArtifact } from './governed-artifacts.js';
import type {
  GovernedAiHost,
  GovernedModelPin,
  GovernedModelResult,
} from './governed-host.js';

export interface GovernedInvokeInput {
  capabilityId: string;
  definitionVersion: string;
  input: unknown;
  pin: GovernedModelPin;
  prompt: string;
  estimatedTokens?: number;
  estimatedCostUsd?: number;
}

export interface GovernedInvokeDeps {
  host: GovernedAiHost;
  approvals: ApprovalService;
  artifacts: GovernedArtifactStore;
  now?: () => Date;
  tenantId?: string;
  recordSpend?: (entry: {
    pin: GovernedModelPin;
    result?: GovernedModelResult;
    error?: string;
  }) => void | Promise<void>;
}

export interface GovernedInvokeSuccess {
  text: string;
  usage?: GovernedModelResult['usage'];
  costUsd?: number | null;
  pin: GovernedModelPin;
  approvalRequestId: string;
  prompt: PublishedGovernedArtifact;
  policy: PublishedGovernedArtifact;
}

/** Input digest subject so review binds the call input and the exact pin. */
export function governedReviewSubject(input: unknown, pin: GovernedModelPin): unknown {
  return { input, pin };
}

function requirePinned(value: string | undefined, field: string, code: GovernedAiBlockedCode): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    throw new GovernedAiBlockedError(code, `Governed AI requires a pinned ${field}`, { field });
  }
  return trimmed;
}

function normalizePin(pin: GovernedModelPin): GovernedModelPin {
  return {
    providerId: requirePinned(pin.providerId, 'provider', 'unregistered-model'),
    modelId: requirePinned(pin.modelId, 'model', 'unregistered-model'),
    promptDigest: requirePinned(pin.promptDigest, 'prompt digest', 'unpinned-prompt'),
    policyDigest: requirePinned(pin.policyDigest, 'policy digest', 'unpinned-policy'),
  };
}

function requireArtifact(
  store: GovernedArtifactStore,
  digest: string,
  expectedKind: 'prompt' | 'policy',
  missingCode: GovernedAiBlockedCode,
): PublishedGovernedArtifact {
  const artifact = store.get(digest);
  if (!artifact) {
    throw new GovernedAiBlockedError(
      missingCode,
      `Governed AI requires a published ${expectedKind} artifact`,
      { digest, expectedKind },
    );
  }
  if (artifact.kind !== expectedKind) {
    throw new GovernedAiBlockedError(
      'artifact-kind-mismatch',
      `Artifact ${digest} is a ${artifact.kind}, not a ${expectedKind}`,
      { digest, expectedKind, actualKind: artifact.kind },
    );
  }
  return artifact;
}

/**
 * Call a host-provided model only after pin, human review, and budget all pass.
 * Any failure throws {@link GovernedAiBlockedError} and does not call the model.
 */
export async function invokeGovernedAi(
  deps: GovernedInvokeDeps,
  input: GovernedInvokeInput,
): Promise<GovernedInvokeSuccess> {
  const pin = normalizePin(input.pin);
  const promptArtifact = requireArtifact(deps.artifacts, pin.promptDigest, 'prompt', 'unpinned-prompt');
  const policyArtifact = requireArtifact(deps.artifacts, pin.policyDigest, 'policy', 'unpinned-policy');

  const model = await deps.host.resolveModel(pin);
  if (!model) {
    throw new GovernedAiBlockedError(
      'unregistered-model',
      'Host did not provide a model for this pin',
      { pin },
    );
  }
  if (model.providerId !== pin.providerId || model.modelId !== pin.modelId) {
    throw new GovernedAiBlockedError(
      'model-pin-mismatch',
      'Host model does not match the requested pin',
      {
        pin,
        resolved: { providerId: model.providerId, modelId: model.modelId },
      },
    );
  }

  const inputDigest = digestApprovalInput(governedReviewSubject(input.input, pin));
  const match = await deps.approvals.findMatchingApproval({
    capabilityId: input.capabilityId,
    definitionVersion: input.definitionVersion,
    inputDigest,
    now: deps.now?.(),
  });
  if (!match || match.state !== ApprovalRequestState.Approved) {
    const code: GovernedAiBlockedCode =
      match?.state === ApprovalRequestState.Expired ? 'expired-review' : 'missing-review';
    throw new GovernedAiBlockedError(
      code,
      'Governed AI requires a bound, unexpired human review before the model is called',
      {
        capabilityId: input.capabilityId,
        definitionVersion: input.definitionVersion,
        inputDigest,
        approvalState: match?.state,
      },
    );
  }

  const budget = await deps.host.checkBudget({
    tenantId: deps.tenantId,
    estimatedTokens: input.estimatedTokens,
    estimatedCostUsd: input.estimatedCostUsd,
    pin,
  });
  if (!budget.allowed) {
    const unknown = /unknown|unavailable|cannot be checked/i.test(budget.reason ?? '');
    throw new GovernedAiBlockedError(
      unknown ? 'budget-unknown' : 'budget-exceeded',
      budget.reason ?? 'Governed AI budget check failed',
      { pin },
    );
  }

  try {
    const result = await model.complete({
      prompt: input.prompt,
      system: promptArtifact.body,
      input: input.input,
    });
    await deps.recordSpend?.({ pin, result });
    return {
      text: result.text,
      usage: result.usage,
      costUsd: result.costUsd,
      pin,
      approvalRequestId: match.approvalRequestId,
      prompt: promptArtifact,
      policy: policyArtifact,
    };
  } catch (err) {
    await deps.recordSpend?.({
      pin,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
