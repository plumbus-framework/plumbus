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
  const { turns } = repos(ctx);
  const query: Partial<ChatTurnRow> = {};
  if (args.sessionId) query.sessionId = args.sessionId;
  if (args.userId) query.userId = args.userId;
  const rows = await turns.findMany(query);
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
