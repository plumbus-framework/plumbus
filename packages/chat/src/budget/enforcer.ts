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
  if (budget.perSession?.tokens !== undefined && agg.tokens >= budget.perSession.tokens) {
    throw ctx.errors.conflict('Session token limit exceeded', {
      code: 'chat.budget_exceeded',
      chatName: args.chatName,
    });
  }
  if (
    budget.perSession?.userMessages !== undefined &&
    agg.userMessages >= budget.perSession.userMessages
  ) {
    throw ctx.errors.conflict('Session user message limit exceeded', {
      code: 'chat.budget_exceeded',
      chatName: args.chatName,
    });
  }

  const now = ctx.time.now();
  if (budget.perUser) {
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    if (budget.perUser.turnsPerHour !== undefined) {
      const hourly = await aggregateForBudget(ctx, { userId: args.userId, since: hourAgo });
      if (hourly.turns >= budget.perUser.turnsPerHour) {
        throw ctx.errors.conflict('User hourly turn limit exceeded', {
          code: 'chat.budget_exceeded',
          chatName: args.chatName,
        });
      }
    }
    if (budget.perUser.turnsPerDay !== undefined) {
      const daily = await aggregateForBudget(ctx, { userId: args.userId, since: dayAgo });
      if (daily.turns >= budget.perUser.turnsPerDay) {
        throw ctx.errors.conflict('User daily turn limit exceeded', {
          code: 'chat.budget_exceeded',
          chatName: args.chatName,
        });
      }
    }
    if (budget.perUser.costUsdPerDay !== undefined) {
      const daily = await aggregateForBudget(ctx, { userId: args.userId, since: dayAgo });
      if (daily.costUsd >= budget.perUser.costUsdPerDay) {
        throw ctx.errors.conflict('User daily cost limit exceeded', {
          code: 'chat.budget_exceeded',
          chatName: args.chatName,
        });
      }
    }
  }

  if (budget.perTenant?.costUsdPerDay !== undefined && args.tenantId) {
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const tenantDaily = await aggregateForBudget(ctx, {
      tenantId: args.tenantId,
      since: dayAgo,
    });
    if (tenantDaily.costUsd >= budget.perTenant.costUsdPerDay) {
      throw ctx.errors.conflict('Tenant daily cost limit exceeded', {
        code: 'chat.budget_exceeded',
        chatName: args.chatName,
      });
    }
  }
}
