import { getCanonicalCapabilityName } from '../execution/canonical-name.js';
import type { ExecutionContext } from '../types/context.js';
import type { ActionRiskTier } from './action-risk.js';
import { capabilityDefinitionVersion, requiresApprovalForRiskTier } from './action-risk.js';
import { digestApprovalInput } from './digest.js';
import { ApprovalRequestState, type ApprovalGateResult } from './types.js';

export interface ApprovalGateCapability {
  name: string;
  domain: string;
  version?: string;
  riskTier?: ActionRiskTier;
}

export async function evaluateApprovalGate(opts: {
  capability: ApprovalGateCapability;
  ctx: ExecutionContext;
  input: unknown;
}): Promise<ApprovalGateResult> {
  const { capability, ctx, input } = opts;
  if (!requiresApprovalForRiskTier(capability.riskTier)) {
    return { blocked: false };
  }

  const capabilityId = getCanonicalCapabilityName(capability);
  const definitionVersion = capabilityDefinitionVersion(capability);
  const inputDigest = digestApprovalInput(input);
  const now = ctx.time.now();
  const approvals = ctx.__runtime?.approvals;

  if (!approvals) {
    return {
      blocked: true,
      code: 'missing-approval-service',
      reason: 'Consequential capability requires a bound, unexpired approval',
      metadata: { capabilityId, definitionVersion, inputDigest },
    };
  }

  const match = await approvals.findMatchingApproval({
    capabilityId,
    definitionVersion,
    inputDigest,
    now,
  });

  if (!match) {
    const conflict = await approvals.findConflictingApproval({
      capabilityId,
      definitionVersion,
      inputDigest,
      now,
    });
    if (conflict) {
      await approvals.invalidateOnMaterialChange({
        capabilityId,
        definitionVersion,
        inputDigest,
        now,
      });
      const code =
        conflict.definitionVersion !== definitionVersion
          ? 'definition-mismatch'
          : 'input-digest-mismatch';
      return {
        blocked: true,
        code,
        reason: 'Approval binding no longer matches this definition version and input digest',
        metadata: {
          capabilityId,
          definitionVersion,
          inputDigest,
          existingDefinitionVersion: conflict.definitionVersion,
          existingInputDigest: conflict.inputDigest,
        },
      };
    }
    return {
      blocked: true,
      code: 'missing-approval',
      reason: 'Consequential capability requires a bound, unexpired approval',
      metadata: { capabilityId, definitionVersion, inputDigest },
    };
  }

  if (match.state === ApprovalRequestState.Expired) {
    return {
      blocked: true,
      code: 'expired-approval',
      reason: 'Approval has expired',
      metadata: { capabilityId, approvalRequestId: match.approvalRequestId },
    };
  }

  const provider = ctx.__runtime?.authorizationProvider;
  if (provider) {
    const check = await provider.revalidate({
      auth: ctx.auth,
      capabilityId,
      request: match,
    });
    if (!check.allowed) {
      return {
        blocked: true,
        code: 'authorization-revalidation-denied',
        reason: check.reason ?? 'Authorization revalidation denied after wait',
        metadata: { capabilityId, approvalRequestId: match.approvalRequestId },
      };
    }
  }

  return { blocked: false, request: match };
}
