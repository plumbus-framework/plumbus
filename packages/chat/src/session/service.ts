import type { ExecutionContext } from '@plumbus/core';
import { chatSessionRepo, chatTurnRepo } from '../internal/chat-repos.js';
import type { ChatSessionRow, ChatTurnRow } from '../types/session.js';

function repos(ctx: ExecutionContext) {
  return { sessions: chatSessionRepo(ctx), turns: chatTurnRepo(ctx) };
}

export async function createSession(
  ctx: ExecutionContext,
  args: { chatName: string; userId: string; audience: string; locale: string; tenantId?: string },
): Promise<ChatSessionRow> {
  const now = ctx.time.now();
  return repos(ctx).sessions.create({
    id: crypto.randomUUID(),
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
  });
}

export async function loadSession(
  ctx: ExecutionContext,
  sessionId: string,
): Promise<ChatSessionRow | null> {
  return repos(ctx).sessions.findById(sessionId);
}

/**
 * Look up a session by id; if it doesn't exist, create one with that exact id
 * using the caller-supplied identity. Used by `runChatTurn` when `saveToDb:
 * true` and the client generated the sessionId itself (no separate bootstrap
 * step). Concurrent first-turns racing the same sessionId resolve via the
 * primary-key constraint: the loser's create throws, and the catch re-loads
 * to return the winner's row.
 */
export async function getOrCreateSession(
  ctx: ExecutionContext,
  args: {
    sessionId: string;
    chatName: string;
    userId: string;
    audience: string;
    locale: string;
    tenantId?: string;
  },
): Promise<ChatSessionRow> {
  const existing = await loadSession(ctx, args.sessionId);
  if (existing) {
    if (existing.userId !== args.userId) {
      throw ctx.errors.notFound('Session not found', { sessionId: args.sessionId });
    }
    return existing;
  }
  const now = ctx.time.now();
  try {
    return await repos(ctx).sessions.create({
      id: args.sessionId,
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
    });
  } catch {
    // Concurrent insert won — re-load. Returning null here would mask the
    // race; throwing surfaces a real "DB unreachable" failure separately
    // because loadSession would also throw.
    const after = await loadSession(ctx, args.sessionId);
    if (after) {
      if (after.userId !== args.userId) {
        throw ctx.errors.notFound('Session not found', { sessionId: args.sessionId });
      }
      return after;
    }
    throw new Error('chat.session_create_race_unresolved');
  }
}

export async function appendTurn(
  ctx: ExecutionContext,
  turn: Omit<ChatTurnRow, 'id'>,
  opts: { persistContent: boolean },
): Promise<ChatTurnRow> {
  const { sessions, turns } = repos(ctx);
  const existing = await turns.findMany({ sessionId: turn.sessionId });
  const ordinal = existing.length;
  const content = opts.persistContent ? turn.content : '';
  const row = await turns.create({ ...turn, ordinal, content });
  await sessions.update(turn.sessionId, { lastTurnAt: turn.recordedAt });
  return row;
}

export async function aggregateForBudget(
  ctx: ExecutionContext,
  args: { sessionId?: string; userId?: string; tenantId?: string; since?: Date },
): Promise<{ turns: number; tokens: number; costUsd: number }> {
  const { sessions, turns } = repos(ctx);
  const query: Partial<ChatTurnRow> = {};
  if (args.sessionId) query.sessionId = args.sessionId;
  if (args.userId) query.userId = args.userId;
  let rows = await turns.findMany(Object.keys(query).length > 0 ? query : undefined);
  if (args.tenantId) {
    const tenantSessionIds = new Set(
      (await sessions.findMany({ tenantId: args.tenantId })).map((s) => s.id),
    );
    rows = rows.filter((r) => tenantSessionIds.has(r.sessionId));
  }
  const since = args.since;
  const filtered = since ? rows.filter((r) => new Date(r.recordedAt) >= since) : rows;
  return {
    turns: filtered.length,
    tokens: filtered.reduce((s, r) => s + r.tokensIn + r.tokensOut, 0),
    costUsd: filtered.reduce((s, r) => s + r.costUsd, 0),
  };
}

export async function updateSessionBehavioralState(
  ctx: ExecutionContext,
  sessionId: string,
  behavioralState: Record<string, unknown>,
): Promise<void> {
  await repos(ctx).sessions.update(sessionId, { behavioralState });
}

export async function updateSessionSummary(
  ctx: ExecutionContext,
  sessionId: string,
  summaryText: string,
  summaryTurnCount: number,
): Promise<void> {
  await repos(ctx).sessions.update(sessionId, { summaryText, summaryTurnCount });
}
