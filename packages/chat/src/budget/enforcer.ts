import type { ExecutionContext } from '@plumbus/core';
import type { ChatBudget } from '../types/budget.js';
import { aggregateForBudget } from '../session/service.js';

export async function checkBudgetPreflight(
  ctx: ExecutionContext,
  args: {
    chatName: string;
    userId: string;
    tenantId?: string;
    sessionId: string;
    budget?: ChatBudget;
  },
): Promise<void> {
  const budget = args.budget;
  if (!budget) return;

  const agg = await aggregateForBudget(ctx, {
    sessionId: args.sessionId,
    userId: args.userId,
    tenantId: args.tenantId,
  });

  if (budget.perSession?.turns !== undefined && agg.turns >= budget.perSession.turns) {
    throw ctx.errors.conflict('Session turn limit exceeded', {
      code: 'chat.budget_exceeded',
      chatName: args.chatName,
    });
  }
  if (budget.perSession?.costUsd !== undefined && agg.costUsd >= budget.perSession.costUsd) {
    throw ctx.errors.conflict('Session cost limit exceeded', {
      code: 'chat.budget_exceeded',
      chatName: args.chatName,
    });
  }
}
