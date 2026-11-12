import type { AIService } from '@plumbus/core';
import { createTestContext, describe, expect, it, mockAI } from '@plumbus/core/testing';
import { z } from '@plumbus/core/zod';
import { defineChat } from '../../define/defineChat.js';
import { createInMemoryChatSessionStore } from '../../session/in-memory-session-store.js';
import type { ChatDefinition } from '../../types/chat.js';
import type { ChatEvent } from '../../types/event.js';
import type { Guard } from '../../types/policy.js';
import type { ChatReplyValidator } from '../../types/reply.js';
import { runChatTurn } from '../run-turn.js';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';

function answer(extra: Record<string, unknown> = {}) {
  return {
    inScope: true,
    answer: 'Draft reply.',
    refusalReason: null,
    citedSources: [],
    requestedAction: null,
    ...extra,
  };
}

async function run(
  chat: ChatDefinition,
  generate: Record<string, unknown>,
  opts: { validateReply?: ChatReplyValidator; promptInput?: Record<string, unknown> } = {},
) {
  const ctx = createTestContext({
    auth: { userId: 'u1', roles: ['user'] },
    ai: mockAI({ generate }),
  });
  const sessionStore = createInMemoryChatSessionStore();
  const events: ChatEvent[] = [];
  for await (const evt of runChatTurn(
    ctx,
    {
      chatDefinition: chat,
      sessionId: SESSION_ID,
      userMessage: 'hello',
      audience: 'user',
      locale: 'en',
      ...(opts.promptInput ? { promptInput: opts.promptInput } : {}),
    },
    { sessionStore, validateReply: opts.validateReply },
  )) {
    events.push(evt);
  }
  const assistant = sessionStore.__turns.filter((t) => t.role === 'assistant');
  return {
    events,
    sessionStore,
    assistant,
    byType: (t: string) => events.filter((e) => e.type === t),
  };
}

const plainChat = defineChat({ name: 'validated', access: {}, instructions: ['x'] });

describe('validateReply — validate before persist', () => {
  it('accept persists the reply unchanged and emits no message.replaced', async () => {
    const r = await run(plainChat, answer(), {
      validateReply: () => ({ decision: 'accept' }),
    });
    expect(r.byType('message.replaced')).toHaveLength(0);
    expect(r.assistant).toHaveLength(1);
    expect(r.assistant[0]?.content).toBe('Draft reply.');
    expect(r.assistant[0]?.moderation).toBeUndefined();
    const completed = r.byType('turn.completed')[0] as Extract<
      ChatEvent,
      { type: 'turn.completed' }
    >;
    expect(completed.moderation).toBeUndefined();
  });

  it('replace persists only the replacement, emits message.replaced and the moderation code', async () => {
    const r = await run(plainChat, answer(), {
      validateReply: () => ({ decision: 'replace', text: 'Fallback line.', code: 'app.unsafe' }),
    });
    const types = r.events.map((e) => e.type);
    expect(types.indexOf('message.delta')).toBeLessThan(types.indexOf('message.replaced'));
    expect(r.byType('message.replaced')[0]).toEqual({
      type: 'message.replaced',
      text: 'Fallback line.',
      code: 'app.unsafe',
    });
    expect(r.assistant).toHaveLength(1);
    expect(r.assistant[0]?.content).toBe('Fallback line.');
    expect(r.assistant[0]?.moderation).toEqual({ code: 'app.unsafe' });
    expect(r.sessionStore.__turns.some((t) => t.content === 'Draft reply.')).toBe(false);
    const completed = r.byType('turn.completed')[0] as Extract<
      ChatEvent,
      { type: 'turn.completed' }
    >;
    expect(completed.moderation).toEqual({ code: 'app.unsafe' });
  });

  it('gives the validator the finished reply, the structured output and the turn context', async () => {
    let seen: Parameters<ChatReplyValidator> | undefined;
    await run(plainChat, answer({ extraField: 7 }), {
      promptInput: { lesson: 'L1' },
      validateReply: (reply, turn) => {
        seen = [reply, turn];
        return { decision: 'accept' };
      },
    });
    expect(seen?.[0].text).toBe('Draft reply.');
    expect((seen?.[0].modelOutput as { extraField?: number }).extraField).toBe(7);
    expect(seen?.[1]).toMatchObject({
      chatName: 'validated',
      sessionId: SESSION_ID,
      userId: 'u1',
      userMessage: 'hello',
      promptInput: { lesson: 'L1' },
      phase: 'turn',
    });
  });

  it('a throwing validator fails closed: nothing persisted, draft withdrawn, turn.failed', async () => {
    const r = await run(plainChat, answer(), {
      validateReply: () => {
        throw new Error('checker down');
      },
    });
    expect(r.sessionStore.__turns).toHaveLength(0);
    expect(r.byType('message.replaced')[0]).toMatchObject({
      text: '',
      code: 'chat.reply_validation_failed',
    });
    expect(r.byType('turn.failed')[0]).toMatchObject({ code: 'chat.reply_validation_failed' });
    expect(r.byType('turn.completed')).toHaveLength(0);
  });

  it('an invalid replace verdict fails closed', async () => {
    const r = await run(plainChat, answer(), {
      validateReply: () => ({ decision: 'replace', text: 'x', code: '' }),
    });
    expect(r.sessionStore.__turns).toHaveLength(0);
    expect(r.byType('turn.failed')[0]).toMatchObject({ code: 'chat.reply_validation_failed' });
  });

  it('without a validator a post-turn guard rewrite is announced with chat.reply_rewritten', async () => {
    const redact: Guard = async (_t, state) => {
      if (state.modelOutput) state.modelOutput.answer = 'Redacted.';
      return { decision: 'allow' };
    };
    const chat = defineChat({
      name: 'redacting',
      access: {},
      instructions: ['x'],
      policy: { customPostTurn: [redact] },
    });
    const r = await run(chat, answer());
    expect(r.byType('message.replaced')[0]).toMatchObject({
      text: 'Redacted.',
      code: 'chat.reply_rewritten',
    });
    expect(r.assistant[0]?.content).toBe('Redacted.');
  });

  it('chats without validateReply and without rewrites behave as before', async () => {
    const r = await run(plainChat, answer());
    expect(r.events.map((e) => e.type)).toEqual([
      'turn.started',
      'message.delta',
      'turn.completed',
    ]);
    const completed = r.byType('turn.completed')[0] as Extract<
      ChatEvent,
      { type: 'turn.completed' }
    >;
    expect(completed).not.toHaveProperty('clientActions');
    expect(completed).not.toHaveProperty('moderation');
  });
});

const actionSchema = z.object({ kind: z.literal('open'), target: z.string() });

describe('client actions', () => {
  const chat = defineChat({
    name: 'actions',
    access: {},
    instructions: ['x'],
    clientActions: { schema: actionSchema },
  });

  it('returns valid client actions on turn.completed and persists them with the turn', async () => {
    const r = await run(chat, answer({ clientActions: [{ kind: 'open', target: 'lesson-2' }] }));
    const completed = r.byType('turn.completed')[0] as Extract<
      ChatEvent,
      { type: 'turn.completed' }
    >;
    expect(completed.clientActions).toEqual([{ kind: 'open', target: 'lesson-2' }]);
    expect(r.assistant[0]?.clientActions).toEqual([{ kind: 'open', target: 'lesson-2' }]);
  });

  it('drops actions failing the schema with a notice', async () => {
    const r = await run(chat, answer({ clientActions: [{ kind: 'delete', target: 'x' }] }));
    expect(r.byType('notice').map((e) => (e as { code: string }).code)).toContain(
      'chat.client_action_invalid',
    );
    const completed = r.byType('turn.completed')[0] as Extract<
      ChatEvent,
      { type: 'turn.completed' }
    >;
    expect(completed.clientActions).toEqual([]);
    expect(r.assistant[0]?.clientActions).toBeUndefined();
  });

  it('caps at maxPerReply (default 1) with a notice', async () => {
    const r = await run(
      chat,
      answer({
        clientActions: [
          { kind: 'open', target: 'a' },
          { kind: 'open', target: 'b' },
        ],
      }),
    );
    expect(r.byType('notice').map((e) => (e as { code: string }).code)).toContain(
      'chat.client_actions_truncated',
    );
    const completed = r.byType('turn.completed')[0] as Extract<
      ChatEvent,
      { type: 'turn.completed' }
    >;
    expect(completed.clientActions).toEqual([{ kind: 'open', target: 'a' }]);
  });

  it('honors a configured maxPerReply', async () => {
    const two = defineChat({
      name: 'two',
      access: {},
      instructions: ['x'],
      clientActions: { schema: actionSchema, maxPerReply: 2 },
    });
    const r = await run(
      two,
      answer({
        clientActions: [
          { kind: 'open', target: 'a' },
          { kind: 'open', target: 'b' },
        ],
      }),
    );
    const completed = r.byType('turn.completed')[0] as Extract<
      ChatEvent,
      { type: 'turn.completed' }
    >;
    expect(completed.clientActions).toHaveLength(2);
  });

  it('ignores clientActions in the model output when the chat declares none', async () => {
    const r = await run(plainChat, answer({ clientActions: [{ kind: 'open', target: 'a' }] }));
    const completed = r.byType('turn.completed')[0] as Extract<
      ChatEvent,
      { type: 'turn.completed' }
    >;
    expect(completed).not.toHaveProperty('clientActions');
    expect(r.assistant[0]?.clientActions).toBeUndefined();
  });

  it('validateReply may set the client actions on accept, and drops them on replace', async () => {
    const accepted = await run(chat, answer({ clientActions: [{ kind: 'open', target: 'a' }] }), {
      validateReply: () => ({ decision: 'accept', clientActions: [{ kind: 'open', target: 'z' }] }),
    });
    const a = accepted.byType('turn.completed')[0] as Extract<
      ChatEvent,
      { type: 'turn.completed' }
    >;
    expect(a.clientActions).toEqual([{ kind: 'open', target: 'z' }]);

    const replaced = await run(chat, answer({ clientActions: [{ kind: 'open', target: 'a' }] }), {
      validateReply: () => ({ decision: 'replace', text: 'No.', code: 'app.x' }),
    });
    const b = replaced.byType('turn.completed')[0] as Extract<
      ChatEvent,
      { type: 'turn.completed' }
    >;
    expect(b.clientActions).toEqual([]);
  });

  it('reads client actions from the agent prompt output in agent orchestration', async () => {
    const agentChat = defineChat({
      name: 'agentActions',
      access: {},
      prompt: { name: 'app.agent' } as never,
      clientActions: { schema: actionSchema },
      policy: { toolCalling: { enabled: true, orchestration: 'agent', capabilities: [] } },
    });
    const ai: AIService = {
      ...mockAI({}),
      generateWithUsage: (async () => ({
        finishReason: 'stop',
        data: { content: 'Open lesson 2.', clientActions: [{ kind: 'open', target: 'l2' }] },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        model: 'm',
        provider: 'p',
        cost: 0,
      })) as AIService['generateWithUsage'],
    };
    const ctx = createTestContext({ auth: { userId: 'u1', roles: ['user'] }, ai });
    const sessionStore = createInMemoryChatSessionStore();
    const events: ChatEvent[] = [];
    for await (const evt of runChatTurn(
      ctx,
      {
        chatDefinition: agentChat,
        sessionId: SESSION_ID,
        userMessage: 'hi',
        audience: 'user',
        locale: 'en',
      },
      { sessionStore, resolveCapability: () => undefined },
    )) {
      events.push(evt);
    }
    const completed = events.find((e) => e.type === 'turn.completed') as Extract<
      ChatEvent,
      { type: 'turn.completed' }
    >;
    expect(completed.clientActions).toEqual([{ kind: 'open', target: 'l2' }]);
  });
});
