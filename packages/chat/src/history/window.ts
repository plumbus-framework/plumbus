import type { ExecutionContext } from '@plumbus/core';
import { chatTurnRepo } from '../internal/chat-repos.js';
import type { ChatMessage } from '../types/session.js';

export async function loadHistoryWindow(
  ctx: ExecutionContext,
  sessionId: string,
  includeLastTurns: number,
  persistence: 'server' | 'client',
): Promise<ChatMessage[]> {
  if (persistence === 'client') return [];

  const rows = await chatTurnRepo(ctx).findMany(
    { sessionId },
    { orderBy: 'ordinal', orderDir: 'asc', limit: includeLastTurns },
  );
  return rows
    .filter((r: { content: string }) => r.content.length > 0)
    .map((r: { role: string; content: string }) => ({
      role: r.role as ChatMessage['role'],
      content: r.content,
    }));
}
