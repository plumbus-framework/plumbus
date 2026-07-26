import type { ExecutionContext } from '@plumbus/core';
import { resolveChatSessionStore, type ChatSessionStore } from '../session/session-store.js';
import type { ChatMessage } from '../types/session.js';

export async function loadHistoryWindow(
  ctx: ExecutionContext,
  sessionId: string,
  includeLastTurns: number,
  persistence: 'server' | 'client',
  sessionStore?: ChatSessionStore,
): Promise<ChatMessage[]> {
  if (persistence === 'client') return [];

  const rows = await resolveChatSessionStore(sessionStore).listTurns(ctx, sessionId, {
    limit: includeLastTurns,
  });
  return rows
    .filter((r: { content: string }) => r.content.length > 0)
    .map((r: { role: string; content: string }) => ({
      role: r.role as ChatMessage['role'],
      content: r.content,
    }));
}
