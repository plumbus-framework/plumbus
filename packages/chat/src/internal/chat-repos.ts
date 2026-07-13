import type { ExecutionContext } from '@plumbus/core';
import type { PendingAction } from '../types/action.js';
import type { ChatSessionRow, ChatTurnRow } from '../types/session.js';

export type ChatSessionRepo = {
  findById(id: string): Promise<ChatSessionRow | null>;
  create(data: Omit<ChatSessionRow, 'id'> & { id?: string }): Promise<ChatSessionRow>;
  update(id: string, updates: Partial<ChatSessionRow>): Promise<ChatSessionRow>;
  findMany(query?: Partial<ChatSessionRow>): Promise<ChatSessionRow[]>;
};

export type ChatTurnRepo = {
  create(data: Omit<ChatTurnRow, 'id'> & { id?: string }): Promise<ChatTurnRow>;
  findMany(
    query?: Partial<ChatTurnRow>,
    options?: { orderBy?: string; orderDir?: 'asc' | 'desc'; limit?: number },
  ): Promise<ChatTurnRow[]>;
  count(query?: Partial<ChatTurnRow>): Promise<number>;
};

export type ChatPendingActionRepo = {
  create(data: PendingAction): Promise<PendingAction>;
  findById(id: string): Promise<PendingAction | null>;
  update(id: string, data: Partial<PendingAction>): Promise<PendingAction>;
  findMany(query?: Partial<PendingAction>): Promise<PendingAction[]>;
  count(query?: Partial<PendingAction>): Promise<number>;
};

function dataMap(ctx: ExecutionContext): Record<string, unknown> {
  return ctx.data as Record<string, unknown>;
}

export function chatSessionRepo(ctx: ExecutionContext): ChatSessionRepo {
  return dataMap(ctx).ChatSession as ChatSessionRepo;
}

export function chatTurnRepo(ctx: ExecutionContext): ChatTurnRepo {
  return dataMap(ctx).ChatTurn as ChatTurnRepo;
}

export function chatPendingActionRepo(ctx: ExecutionContext): ChatPendingActionRepo {
  return dataMap(ctx).ChatPendingAction as ChatPendingActionRepo;
}
