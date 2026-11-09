import { getCanonicalCapabilityName } from '../execution/canonical-name.js';
import type { ExecutionContext } from '../types/context.js';
import type { ActionRiskTier } from './action-risk.js';
import {
  capabilityDefinitionVersion,
  isProhibitedRiskTier,
  requiresApprovalForRiskTier,
} from './action-risk.js';
import { digestApprovalInput } from './digest.js';
import { ApprovalRequestState, type ApprovalGateResult } from './types.js';

function isPast(expiresAt: string, now: Date): boolean {
  return new Date(expiresAt).getTime() <= now.getTime();
}

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

  // A prohibited capability can never run, and an approval must not make it
  // permissible — refuse before any approval lookup with a stable reason code.
  if (isProhibitedRiskTier(capability.riskTier)) {
    return {
      blocked: true,
      code: 'prohibited-capability',
      reason: 'Prohibited capability cannot be invoked, proposed for approval, or made available',
      metadata: { capabilityId: getCanonicalCapabilityName(capability) },
    };
  }

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

  // Bind the lookup to the tenant and flow execution this gate runs for, so a
  // shared service never lets one tenant's (or execution's) approval satisfy
  // another's gate.
  const binding = {
    tenantId: ctx.auth?.tenantId ?? null,
    executionId: ctx.flowId ?? null,
    capabilityId,
    definitionVersion,
    inputDigest,
    now,
  };
  const match = await approvals.findMatchingApproval(binding);

  if (!match) {
    const conflict = await approvals.findConflictingApproval(binding);
    if (conflict) {
      await approvals.invalidateOnMaterialChange(binding);
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

  if (match.state !== ApprovalRequestState.Approved || isPast(match.expiresAt, now)) {
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
