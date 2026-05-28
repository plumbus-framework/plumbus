import type { ExecutionContext } from '@plumbus/core';
import { chatPendingActionRepo } from '../internal/chat-repos.js';
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
  if (row.schemaHash !== expectedSchemaHash) {
    throw ctx.errors.conflict('Action schema changed since confirmation was requested', {
      code: 'chat.action_schema_mismatch',
      actionId,
    });
  }
  if (new Date(row.expiresAt) < new Date()) {
    await repo(ctx).update(actionId, { status: 'expired' });
    throw ctx.errors.conflict('Action expired', { code: 'chat.action_expired', actionId });
  }
  const result = await execute(row.capabilityName, row.input);
  await repo(ctx).update(actionId, { status: 'confirmed' });
  return result;
}
