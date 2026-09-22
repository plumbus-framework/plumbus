import type { ExecutionContext } from '@plumbus/core';
import { resolveChatSessionStore } from '../session/session-store.js';
import type { Guard } from '../types/policy.js';
import type { PendingAction } from '../types/action.js';
import {
  capabilityActionHashV2,
  isV2SchemaHash,
  legacyActionSchemaHash,
} from './action-schema-hash.js';

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

  const perSessionActions = state.budgetActionsPerSession;
  if (perSessionActions !== undefined) {
    const store = resolveChatSessionStore(state.sessionStore);
    const countActive = store.countActivePendingActions;
    if (!countActive) {
      // Reaching ctx.data here would defeat the injected store. registerChatRoutes
      // refuses this combination at startup; this covers direct runChatTurn callers.
      throw state.ctx.errors.internal(
        'Pending action budget requires a session store that implements countActivePendingActions',
        { code: 'chat.budget_unsupported', chatName: state.chatName },
      );
    }
    const activeCount = await countActive.call(store, state.ctx, {
      sessionId: turnCtx.sessionId,
      now: new Date(),
    });
    if (activeCount >= perSessionActions) {
      return {
        decision: 'block',
        reason: 'action_budget_exceeded',
        emit: {
          type: 'notice',
          code: 'chat.budget_exceeded',
          message: 'Pending action cap reached for this session',
        },
      };
    }
  }

  const cap = state.ctx.__runtime?.resolveCapability?.(req.capabilityName);
  if (cap) {
    const parsed = cap.input.safeParse(req.input);
    if (!parsed.success) {
      return {
        decision: 'block',
        reason: 'action_input_invalid',
        emit: {
          type: 'notice',
          code: 'chat.action_input_invalid',
          message: 'Requested action input failed schema validation',
        },
      };
    }
  }

  const described = state.ctx.capabilities.describe?.(
    req.capabilityName as import('@plumbus/core').RegisteredCapabilityName,
  );
  const hash = described
    ? capabilityActionHashV2(described.inputSchema, req.input)
    : legacyActionSchemaHash(req.input);

  if (!described && !isV2SchemaHash(hash)) {
    console.warn(
      `[@plumbus/chat] action-guard: ctx.capabilities.describe unavailable for "${req.capabilityName}" — using legacy payload hash`,
    );
  }

  const pending: PendingAction = {
    id: crypto.randomUUID(),
    sessionId: turnCtx.sessionId,
    capabilityName: req.capabilityName,
    input: req.input, // RAW — run-turn's buildNormalizedPending applies C3 normalization
    schemaHash: hash,
    confirmationMessage: req.confirmationMessage,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    status: 'pending',
  };

  return { decision: 'require_confirmation', pendingAction: pending };
};

export function currentCapabilityActionHash(
  ctx: ExecutionContext,
  capabilityName: string,
  input: unknown,
): string | undefined {
  const described = ctx.capabilities.describe?.(
    capabilityName as import('@plumbus/core').RegisteredCapabilityName,
  );
  if (!described) return undefined;
  return capabilityActionHashV2(described.inputSchema, input);
}
