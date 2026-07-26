import { describe, expect, it, createTestContext, mockAI } from '@plumbus/core/testing';
import type { ExecutionContext } from '@plumbus/core';
import { defineChat } from '../../define/defineChat.js';
import { runChatTurn } from '../../runtime/run-turn.js';
import { createInMemoryChatSessionStore } from '../in-memory-session-store.js';
import {
  assertChatStoresSupportChats,
  ChatStoreUnsupportedError,
  type ChatSessionStore,
} from '../session-store.js';
import type { ChatEvent } from '../../types/event.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

const inScopeResponse = {
  inScope: true,
  answer: 'Here is the answer.',
  refusalReason: null,
  citedSources: [],
  requestedAction: null,
};

const refusalResponse = {
  inScope: false,
  answer: '',
  refusalReason: 'off_topic' as const,
  citedSources: [],
  requestedAction: null,
};

/**
 * A context whose `data` throws on any property access.
 *
 * This is the actual acceptance bar for issue #39: a deployment with no local
 * database must complete a turn. Asserting on events alone would pass even if
 * the pipeline quietly fell back to repositories, so the trap makes any `ctx.data`
 * reach a hard test failure instead.
 */
function contextWithoutData(options?: Parameters<typeof createTestContext>[0]): ExecutionContext {
  const base = createTestContext(options);
  const trap = new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(
          `ctx.data was accessed (property "${String(prop)}") — the injected session store path must not touch ctx.data`,
        );
      },
    },
  );
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'data') return trap;
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as ExecutionContext;
}

async function runTurn(
  ctx: ExecutionContext,
  chat: ReturnType<typeof defineChat>,
  userMessage: string,
  sessionStore: ChatSessionStore,
): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const evt of runChatTurn(
    ctx,
    {
      chatDefinition: chat,
      sessionId: SESSION_ID,
      userMessage,
      audience: 'user',
      locale: 'en',
    },
    { sessionStore },
  )) {
    events.push(evt);
  }
  return events;
}

describe('runChatTurn — injected session store', () => {
  it('completes a full turn without ever reading ctx.data', async () => {
    const ctx = contextWithoutData({ ai: mockAI({ generate: inScopeResponse }) });
    const store = createInMemoryChatSessionStore();
    const chat = defineChat({ name: 'help', access: {}, instructions: ['You are helpful'] });

    const events = await runTurn(ctx, chat, 'hi', store);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('turn.started');
    expect(types).toContain('message.delta');
    expect(types[types.length - 1]).toBe('turn.completed');
    expect(types).not.toContain('turn.failed');
  });

  it('bootstraps the session and persists both turn rows through the store', async () => {
    const ctx = contextWithoutData({ ai: mockAI({ generate: inScopeResponse }) });
    const store = createInMemoryChatSessionStore();
    const chat = defineChat({ name: 'help', access: {}, instructions: ['x'] });

    await runTurn(ctx, chat, 'hi', store);

    const session = store.__sessions.get(SESSION_ID);
    expect(session?.chatName).toBe('help');
    expect(session?.userId).toBe(ctx.auth.userId ?? '');

    expect(store.__turns).toHaveLength(2);
    expect(store.__turns[0]?.role).toBe('user');
    expect(store.__turns[0]?.content).toBe('hi');
    expect(store.__turns[1]?.role).toBe('assistant');
    expect(store.__turns[1]?.content).toBe('Here is the answer.');
  });

  it('assigns ascending ordinals across turns and replays stored history', async () => {
    const ctx = contextWithoutData({ ai: mockAI({ generate: inScopeResponse }) });
    const store = createInMemoryChatSessionStore();
    const chat = defineChat({ name: 'help', access: {}, instructions: ['x'] });

    const first = await runTurn(ctx, chat, 'first', store);
    const second = await runTurn(ctx, chat, 'second', store);

    // The store owns the ordinal — callers pass a placeholder of 0.
    expect(store.__turns.map((t) => t.ordinal)).toEqual([0, 1, 2, 3]);

    const startedFirst = first.find((e) => e.type === 'turn.started');
    const startedSecond = second.find((e) => e.type === 'turn.started');
    expect(startedFirst?.type === 'turn.started' && startedFirst.ordinal).toBe(0);
    expect(startedSecond?.type === 'turn.started' && startedSecond.ordinal).toBe(2);

    const history = await store.listTurns(ctx, SESSION_ID);
    expect(history.map((t) => t.content)).toEqual([
      'first',
      'Here is the answer.',
      'second',
      'Here is the answer.',
    ]);
  });

  it('blanks stored content when the chat keeps message content client-side', async () => {
    const ctx = contextWithoutData({ ai: mockAI({ generate: inScopeResponse }) });
    const store = createInMemoryChatSessionStore();
    const chat = defineChat({
      name: 'help',
      access: {},
      instructions: ['x'],
      persistence: { messageContent: 'client' },
    });

    await runTurn(ctx, chat, 'sensitive question', store);

    expect(store.__turns).toHaveLength(2);
    expect(store.__turns.every((t) => t.content === '')).toBe(true);
    // Metadata is still recorded — only the text is withheld.
    expect(store.__turns[1]?.model).not.toBe('');
  });

  it('records behavioral cooldown state through the store', async () => {
    const ctx = contextWithoutData({ ai: mockAI({ generate: refusalResponse }) });
    const store = createInMemoryChatSessionStore();
    const chat = defineChat({
      name: 'help',
      access: {},
      instructions: ['x'],
      policy: {
        behavioral: {
          cooldowns: [{ trigger: 'refusal', count: 1, durationSeconds: 60, scope: 'session' }],
        },
      },
    });

    await runTurn(ctx, chat, 'off topic', store);

    const state = store.__sessions.get(SESSION_ID)?.behavioralState ?? {};
    expect(Object.keys(state)).toContain(`cooldown:refusal:session:${SESSION_ID}`);

    // The recorded cooldown is then honored on the next turn by the pre-guard.
    const events = await runTurn(ctx, chat, 'again', store);
    const failed = events.find((e) => e.type === 'turn.failed');
    expect(failed?.type === 'turn.failed' && failed.code).toBe('cooldown_active');
  });

  it('enforces budgets through the store aggregator', async () => {
    const ctx = contextWithoutData({ ai: mockAI({ generate: inScopeResponse }) });
    const store = createInMemoryChatSessionStore();
    const chat = defineChat({
      name: 'help',
      access: {},
      instructions: ['x'],
      budget: { perSession: { userMessages: 1 } },
    });

    const first = await runTurn(ctx, chat, 'one', store);
    expect(first.map((e) => e.type)).not.toContain('turn.failed');

    // The second turn sees one stored user message and trips the cap.
    const second = await runTurn(ctx, chat, 'two', store);
    expect(second.map((e) => e.type)).toContain('turn.failed');
  });

  it('fails closed rather than skipping a budget the store cannot evaluate', async () => {
    const ctx = contextWithoutData({ ai: mockAI({ generate: inScopeResponse }) });
    const full = createInMemoryChatSessionStore();
    const { aggregateForBudget: _omitted, ...withoutAggregate } = full;
    const chat = defineChat({
      name: 'help',
      access: {},
      instructions: ['x'],
      budget: { perSession: { userMessages: 5 } },
    });

    const events = await runTurn(ctx, chat, 'hi', withoutAggregate as ChatSessionStore);

    const failed = events.find((e) => e.type === 'turn.failed');
    expect(failed?.type).toBe('turn.failed');
    // Surfaced through the turn error path; the cap is never silently ignored.
    expect(failed?.type === 'turn.failed' && failed.message).toContain('aggregateForBudget');
  });

  it('refuses confirmations when no atomic tier backs the injected store', async () => {
    const store = createInMemoryChatSessionStore();
    const chat = defineChat({
      name: 'help',
      access: {},
      instructions: ['x'],
      policy: { action: { allowedCapabilities: ['doThing'] } },
    });

    expect(() => assertChatStoresSupportChats({ chats: [chat], sessionStore: store })).toThrowError(
      ChatStoreUnsupportedError,
    );

    try {
      assertChatStoresSupportChats({ chats: [chat], sessionStore: store });
    } catch (err) {
      expect((err as ChatStoreUnsupportedError).code).toBe('chat.storage_unsupported');
    }
  });

  it('refuses a pending-action cap the store cannot count', async () => {
    const store = createInMemoryChatSessionStore();
    const chat = defineChat({
      name: 'help',
      access: {},
      instructions: ['x'],
      budget: { actions: { perSession: 2 } },
    });

    try {
      assertChatStoresSupportChats({
        chats: [chat],
        sessionStore: store,
        conversationStore: {},
      });
      throw new Error('expected assertChatStoresSupportChats to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ChatStoreUnsupportedError);
      expect((err as ChatStoreUnsupportedError).code).toBe('chat.budget_unsupported');
      expect((err as ChatStoreUnsupportedError).message).toContain('countActivePendingActions');
    }
  });

  it('is a no-op for applications that inject nothing', () => {
    const chat = defineChat({
      name: 'help',
      access: {},
      instructions: ['x'],
      budget: { perSession: { userMessages: 1 }, actions: { perSession: 2 } },
      policy: { action: { allowedCapabilities: ['doThing'] } },
    });

    // No sessionStore injected — the DB-backed default serves every tier, so
    // startup validation must not reject a configuration that works today.
    expect(() => assertChatStoresSupportChats({ chats: [chat] })).not.toThrow();
  });
});
