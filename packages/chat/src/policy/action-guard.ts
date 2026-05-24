import { createHash } from 'node:crypto';
import type { Guard } from '../types/policy.js';
import type { PendingAction } from '../types/action.js';

export function schemaHash(input: unknown): string {
  return createHash('sha1').update(JSON.stringify(input)).digest('hex');
}

export const actionGuard: Guard = async (turnCtx, state) => {
  const output = state.modelOutput;
  if (!output?.requestedAction) return { decision: 'allow' };

  const req = output.requestedAction as {
    capabilityName: string;
    input: unknown;
    confirmationMessage: string;
  };

  const allowed = state.policy.action?.allowedCapabilities;
  if (allowed && !allowed.includes(req.capabilityName)) {
    return { decision: 'block', reason: 'action_not_allowed' };
  }

  const pending: PendingAction = {
    id: crypto.randomUUID(),
    sessionId: turnCtx.sessionId,
    capabilityName: req.capabilityName,
    input: req.input,
    schemaHash: schemaHash(req.input),
    confirmationMessage: req.confirmationMessage,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    status: 'pending',
  };

  return { decision: 'require_confirmation', pendingAction: pending };
};
