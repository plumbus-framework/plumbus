import type { ConditionalUpdateResult, ExecutionContext } from '@plumbus/core';
import type { ChatPendingActionV2 } from '../session/pending-action-v2.js';
import type { ChatSessionRow, ChatTurnRow } from '../types/session.js';

export type ChatSessionRepo = {
  findById(id: string): Promise<ChatSessionRow | null>;
  create(data: Omit<ChatSessionRow, 'id'> & { id?: string }): Promise<ChatSessionRow>;
  update(id: string, updates: Partial<ChatSessionRow>): Promise<ChatSessionRow>;
  updateWhere(
    id: string,
    predicate: Partial<ChatSessionRow>,
    updates: Partial<ChatSessionRow>,
  ): Promise<ConditionalUpdateResult<ChatSessionRow>>;
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
  create(data: ChatPendingActionV2): Promise<ChatPendingActionV2>;
  findById(id: string): Promise<ChatPendingActionV2 | null>;
  update(id: string, data: Partial<ChatPendingActionV2>): Promise<ChatPendingActionV2>;
  updateWhere(
    id: string,
    predicate: Partial<ChatPendingActionV2>,
    updates: Partial<ChatPendingActionV2>,
  ): Promise<ConditionalUpdateResult<ChatPendingActionV2>>;
  findMany(query?: Partial<ChatPendingActionV2>): Promise<ChatPendingActionV2[]>;
  count(query?: Partial<ChatPendingActionV2>): Promise<number>;
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
