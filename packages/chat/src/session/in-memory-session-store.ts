import type { ExecutionContext } from '@plumbus/core';
import type { ChatSessionRow, ChatTurnRow } from '../types/session.js';
import type {
  ChatBudgetAggregate,
  ChatBudgetAggregateQuery,
  ChatSessionStore,
  CreateChatSessionArgs,
  GetOrCreateChatSessionArgs,
} from './session-store.js';

/**
 * Map-backed {@link ChatSessionStore} that never touches `ctx.data`.
 *
 * Two uses:
 *
 * 1. **Tests** — drive `runChatTurn` with no database and no repositories wired,
 *    which is also the regression test that the injected path is genuinely free
 *    of `ctx.data`.
 * 2. **A reference implementation** — the smallest correct adapter, showing the
 *    invariants documented on {@link ChatSessionStore}: `appendTurn` assigns the
 *    ordinal and advances `lastTurnAt`, blanks content when `persistContent` is
 *    false, and `getOrCreateSession` refuses a session owned by another user.
 *
 * It is deliberately not concurrency-safe and holds everything in memory, so it
 * is not a production backend.
 */
export function createInMemoryChatSessionStore(seed?: {
  sessions?: ChatSessionRow[];
  turns?: ChatTurnRow[];
}): ChatSessionStore & {
  __sessions: Map<string, ChatSessionRow>;
  __turns: ChatTurnRow[];
} {
  const sessions = new Map<string, ChatSessionRow>();
  for (const s of seed?.sessions ?? []) sessions.set(s.id, { ...s });
  const turns: ChatTurnRow[] = [...(seed?.turns ?? [])];

  const turnsFor = (sessionId: string): ChatTurnRow[] =>
    turns.filter((t) => t.sessionId === sessionId).sort((a, b) => a.ordinal - b.ordinal);

  const newSession = (
    ctx: ExecutionContext,
    id: string,
    args: CreateChatSessionArgs,
  ): ChatSessionRow => {
    const now = ctx.time.now();
    return {
      id,
      chatName: args.chatName,
      userId: args.userId,
      tenantId: args.tenantId,
      audience: args.audience,
      locale: args.locale,
      startedAt: now,
      lastTurnAt: now,
      status: 'active',
      behavioralState: {},
      summaryTurnCount: 0,
      revision: 0,
      leaseToken: null,
      leaseExpiresAt: null,
    };
  };

  return {
    __sessions: sessions,
    __turns: turns,

    async getOrCreateSession(
      ctx: ExecutionContext,
      args: GetOrCreateChatSessionArgs,
    ): Promise<ChatSessionRow> {
      const existing = sessions.get(args.sessionId);
      if (existing) {
        // Ownership: a guessed session id must not read another user's conversation.
        if (existing.userId !== args.userId) {
          throw ctx.errors.notFound('Session not found', { sessionId: args.sessionId });
        }
        return existing;
      }
      const row = newSession(ctx, args.sessionId, args);
      sessions.set(row.id, row);
      return row;
    },

    async createSession(
      ctx: ExecutionContext,
      args: CreateChatSessionArgs,
    ): Promise<ChatSessionRow> {
      const row = newSession(ctx, crypto.randomUUID(), args);
      sessions.set(row.id, row);
      return row;
    },

    async loadSession(_ctx: ExecutionContext, sessionId: string): Promise<ChatSessionRow | null> {
      return sessions.get(sessionId) ?? null;
    },

    async appendTurn(
      _ctx: ExecutionContext,
      turn: Omit<ChatTurnRow, 'id'>,
      opts: { persistContent: boolean },
    ): Promise<ChatTurnRow> {
      // The store owns the ordinal; the caller's value is a placeholder.
      const row: ChatTurnRow = {
        ...turn,
        id: crypto.randomUUID(),
        ordinal: turnsFor(turn.sessionId).length,
        content: opts.persistContent ? turn.content : '',
      };
      turns.push(row);
      const session = sessions.get(turn.sessionId);
      if (session) session.lastTurnAt = turn.recordedAt;
      return row;
    },

    async countTurns(_ctx: ExecutionContext, sessionId: string): Promise<number> {
      return turnsFor(sessionId).length;
    },

    async listTurns(
      _ctx: ExecutionContext,
      sessionId: string,
      opts?: { limit?: number },
    ): Promise<ChatTurnRow[]> {
      const rows = turnsFor(sessionId);
      return opts?.limit === undefined ? rows : rows.slice(0, opts.limit);
    },

    async updateSessionBehavioralState(
      _ctx: ExecutionContext,
      sessionId: string,
      behavioralState: Record<string, unknown>,
    ): Promise<void> {
      const session = sessions.get(sessionId);
      if (session) session.behavioralState = behavioralState;
    },

    async updateSessionSummary(
      _ctx: ExecutionContext,
      sessionId: string,
      summaryText: string,
      summaryTurnCount: number,
    ): Promise<void> {
      const session = sessions.get(sessionId);
      if (session) {
        session.summaryText = summaryText;
        session.summaryTurnCount = summaryTurnCount;
      }
    },

    async loadMergedUserBehavioralState(
      _ctx: ExecutionContext,
      userId: string,
      limit = 50,
    ): Promise<Record<string, unknown>> {
      const recent = [...sessions.values()]
        .filter((s) => s.userId === userId)
        .sort((a, b) => new Date(b.lastTurnAt).getTime() - new Date(a.lastTurnAt).getTime())
        .slice(0, limit)
        // Oldest → newest so later sessions win on key collision.
        .reverse();
      const merged: Record<string, unknown> = {};
      for (const session of recent) Object.assign(merged, session.behavioralState);
      return merged;
    },

    async aggregateForBudget(
      _ctx: ExecutionContext,
      query: ChatBudgetAggregateQuery,
    ): Promise<ChatBudgetAggregate> {
      let rows = turns;
      if (query.sessionId) rows = rows.filter((t) => t.sessionId === query.sessionId);
      if (query.userId) rows = rows.filter((t) => t.userId === query.userId);
      if (query.tenantId) {
        const tenantSessionIds = new Set(
          [...sessions.values()].filter((s) => s.tenantId === query.tenantId).map((s) => s.id),
        );
        rows = rows.filter((t) => tenantSessionIds.has(t.sessionId));
      }
      const since = query.since;
      if (since) rows = rows.filter((t) => new Date(t.recordedAt) >= since);
      return {
        turns: rows.length,
        tokens: rows.reduce((sum, t) => sum + t.tokensIn + t.tokensOut, 0),
        costUsd: rows.reduce((sum, t) => sum + t.costUsd, 0),
        userMessages: rows.filter((t) => t.role === 'user').length,
      };
    },
  };
}
