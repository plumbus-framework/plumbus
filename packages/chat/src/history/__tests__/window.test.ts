import type { ExecutionContext } from '@plumbus/core';
import { createTestContext, describe, expect, it, mockAI } from '@plumbus/core/testing';
import { defineChat } from '../../define/defineChat.js';
import { runChatTurn } from '../../runtime/run-turn.js';
import { createInMemoryChatSessionStore } from '../../session/in-memory-session-store.js';
import { dbChatSessionStore } from '../../session/session-store.js';
import type { ChatSessionRow, ChatTurnRow } from '../../types/session.js';
import { loadHistoryWindow } from '../window.js';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const TURN_COUNT = 10;

function turn(ordinal: number): ChatTurnRow {
  return {
    id: `turn-${ordinal}`,
    sessionId: SESSION_ID,
    ordinal,
    role: ordinal % 2 === 0 ? 'user' : 'assistant',
    content: `message ${ordinal}`,
    inScope: true,
    sources: [],
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    model: 'test',
    latencyMs: 0,
    recordedAt: new Date(2026, 0, 1, 0, ordinal),
    userId: 'user-1',
  };
}

function session(userId: string): ChatSessionRow {
  const at = new Date(2026, 0, 1);
  return {
    id: SESSION_ID,
    chatName: 'help',
    userId,
    audience: 'user',
    locale: 'en',
    startedAt: at,
    lastTurnAt: at,
    status: 'active',
    behavioralState: {},
    summaryTurnCount: 0,
    revision: 0,
    leaseToken: null,
    leaseExpiresAt: null,
  } as ChatSessionRow;
}

/** Stored out of order so the stores' own ordering is what is tested. */
const TURNS = Array.from({ length: TURN_COUNT }, (_, i) => turn(i)).reverse();

/** A `ctx.data.ChatTurn` that honors `orderBy` / `orderDir` / `limit` like a repository. */
function contextWithTurnRepo(): ExecutionContext {
  const base = createTestContext();
  const ChatTurn = {
    async findMany(
      query: Partial<ChatTurnRow>,
      options?: { orderBy?: string; orderDir?: 'asc' | 'desc'; limit?: number },
    ): Promise<ChatTurnRow[]> {
      const rows = TURNS.filter((t) => t.sessionId === query.sessionId).sort((a, b) =>
        options?.orderDir === 'desc' ? b.ordinal - a.ordinal : a.ordinal - b.ordinal,
      );
      return options?.limit === undefined ? rows : rows.slice(0, options.limit);
    },
  };
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'data') return { ChatTurn };
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as ExecutionContext;
}

const LAST_FOUR = ['message 6', 'message 7', 'message 8', 'message 9'];

describe('history window — the newest includeLastTurns turns, oldest first', () => {
  it('in-memory store: listTurns with a limit returns the last turns in order', async () => {
    const store = createInMemoryChatSessionStore({ turns: TURNS });
    const rows = await store.listTurns(createTestContext(), SESSION_ID, { limit: 4 });
    expect(rows.map((r) => r.ordinal)).toEqual([6, 7, 8, 9]);

    const all = await store.listTurns(createTestContext(), SESSION_ID);
    expect(all.map((r) => r.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('DB-backed store: listTurns with a limit returns the last turns in order', async () => {
    const ctx = contextWithTurnRepo();
    const rows = await dbChatSessionStore.listTurns(ctx, SESSION_ID, { limit: 4 });
    expect(rows.map((r) => r.ordinal)).toEqual([6, 7, 8, 9]);

    const all = await dbChatSessionStore.listTurns(ctx, SESSION_ID);
    expect(all.map((r) => r.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('loadHistoryWindow returns the newest turns from both stores', async () => {
    const memory = createInMemoryChatSessionStore({ turns: TURNS });
    const fromMemory = await loadHistoryWindow(
      createTestContext(),
      SESSION_ID,
      4,
      'server',
      memory,
    );
    expect(fromMemory.map((m) => m.content)).toEqual(LAST_FOUR);
    expect(fromMemory.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);

    const fromDb = await loadHistoryWindow(contextWithTurnRepo(), SESSION_ID, 4, 'server');
    expect(fromDb.map((m) => m.content)).toEqual(LAST_FOUR);
  });

  it('a turn in a session longer than includeLastTurns sends the model the latest turns', async () => {
    const ctx = createTestContext({
      ai: mockAI({
        generate: {
          inScope: true,
          answer: 'ok',
          refusalReason: null,
          citedSources: [],
          requestedAction: null,
        },
      }),
    });
    const histories: unknown[] = [];
    const ai = ctx.ai as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const method of ['generateWithUsage', 'streamGenerate'] as const) {
      const original = ai[method];
      if (typeof original !== 'function') continue;
      ai[method] = (config: unknown, ...rest: unknown[]) => {
        const input = (config as { input?: { history?: unknown } }).input;
        if (input && 'history' in input) histories.push(input.history);
        return original.call(ai, config, ...rest);
      };
    }

    const store = createInMemoryChatSessionStore({
      sessions: [session(ctx.auth.userId ?? '')],
      turns: TURNS,
    });
    const chat = defineChat({
      name: 'help',
      access: {},
      instructions: ['x'],
      history: { includeLastTurns: 4 },
    });

    for await (const _ of runChatTurn(
      ctx,
      {
        chatDefinition: chat,
        sessionId: SESSION_ID,
        userMessage: 'message 10',
        audience: 'user',
        locale: 'en',
      },
      { sessionStore: store },
    )) {
      // drain
    }

    expect(histories).toHaveLength(1);
    expect((histories[0] as { content: string }[]).map((m) => m.content)).toEqual(LAST_FOUR);
  });
});
