import type { ExecutionContext } from '@plumbus/core';
import { chatPendingActionRepo } from '../internal/chat-repos.js';
import { loadSession } from '../session/service.js';
import { currentCapabilityActionHash } from '../policy/action-guard.js';
import { isV2SchemaHash } from '../policy/action-schema-hash.js';
import type { PendingAction } from '../types/action.js';

function repo(ctx: ExecutionContext) {
  return chatPendingActionRepo(ctx);
}

export async function storePending(ctx: ExecutionContext, action: PendingAction): Promise<void> {
  await repo(ctx).create(action);
}

export async function confirmPending(
  ctx: ExecutionContext,
  actionId: string,
  execute: (capabilityName: string, input: unknown) => Promise<unknown>,
  expectedSchemaHash: string,
): Promise<unknown> {
  const row = await repo(ctx).findById(actionId);
  if (!row || row.status !== 'pending') {
    throw ctx.errors.notFound('Pending action not found', { actionId });
  }
  // Ownership before hash/expiry mutations so non-owners cannot probe existence
  // or expire another user's pending action.
  const session = await loadSession(ctx, row.sessionId);
  if (!session || session.userId !== ctx.auth.userId) {
    throw ctx.errors.notFound('Pending action not found', { actionId });
  }
  if (row.schemaHash !== expectedSchemaHash) {
    throw ctx.errors.conflict('Action schema changed since confirmation was requested', {
      code: 'chat.action_schema_mismatch',
      actionId,
    });
  }
  if (isV2SchemaHash(row.schemaHash)) {
    const current = currentCapabilityActionHash(ctx, row.capabilityName, row.input);
    if (current && current !== row.schemaHash) {
      throw ctx.errors.conflict(
        'Capability input schema or payload changed since action was proposed',
        {
          code: 'chat.action_schema_changed',
          actionId,
        },
      );
    }
    const cap = ctx.__runtime?.resolveCapability?.(row.capabilityName);
    if (cap) {
      const parsed = cap.input.safeParse(row.input);
      if (!parsed.success) {
        throw ctx.errors.validation('Stored action input is invalid for the current schema', {
          code: 'chat.action_input_invalid',
          actionId,
        });
      }
    }
  }
  if (new Date(row.expiresAt) < new Date()) {
    await repo(ctx).update(actionId, { status: 'expired' });
    throw ctx.errors.conflict('Action expired', { code: 'chat.action_expired', actionId });
  }
  const result = await execute(row.capabilityName, row.input);
  await repo(ctx).update(actionId, { status: 'confirmed' });
  return result;
}

export async function rejectPending(
  ctx: ExecutionContext,
  actionId: string,
  expectedSchemaHash: string,
): Promise<{ rejected: boolean; capabilityName?: string }> {
  const row = await repo(ctx).findById(actionId);
  if (!row) {
    return { rejected: false };
  }
  if (row.status === 'rejected' || row.status === 'expired') {
    return { rejected: false };
  }
  if (row.status !== 'pending') {
    throw ctx.errors.notFound('Pending action not found', { actionId });
  }
  // Ownership before hash mismatch so non-owners cannot probe existence.
  const session = await loadSession(ctx, row.sessionId);
  if (!session || session.userId !== ctx.auth.userId) {
    throw ctx.errors.notFound('Pending action not found', { actionId });
  }
  if (row.schemaHash !== expectedSchemaHash) {
    throw ctx.errors.conflict('Action schema changed since confirmation was requested', {
      code: 'chat.action_schema_mismatch',
      actionId,
    });
  }
  await repo(ctx).update(actionId, { status: 'rejected' });
  return { rejected: true, capabilityName: row.capabilityName };
}
