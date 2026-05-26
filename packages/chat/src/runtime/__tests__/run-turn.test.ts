import { describe, expect, it, createTestContext, mockAI } from '@plumbus/core/testing';
import type { AIService } from '@plumbus/core';
import { defineChat } from '../../define/defineChat.js';
import { runChatTurn } from '../run-turn.js';
import { createSession } from '../../session/service.js';
import { staticContext } from '../../context/static-context.js';
import { TraceRecorder } from '../../eval/trace.js';
import type { ChatEvent } from '../../types/event.js';

function collectEvents(): {
  push: (evt: ChatEvent) => void;
  byType: (t: ChatEvent['type']) => ChatEvent[];
  all: ChatEvent[];
} {
  const all: ChatEvent[] = [];
  return {
    push: (evt) => all.push(evt),
    byType: (t) => all.filter((e) => e.type === t),
    all,
  };
}

// Wraps mockAI and counts how many times each generate-style call fired.
// Used to prove the empty-answer-fallback bug stays fixed (refusals must not
// trigger a second model call).
function countingAI(responses: Parameters<typeof mockAI>[0]): {
  ai: AIService;
  callCount: { generate: number; streamGenerate: number; generateWithUsage: number };
} {
  const base = mockAI(responses);
  const callCount = { generate: 0, streamGenerate: 0, generateWithUsage: 0 };
  const ai: AIService = {
    ...base,
    async generate(cfg) {
      callCount.generate++;
      return base.generate(cfg);
    },
    async generateWithUsage(cfg) {
      callCount.generateWithUsage++;
      return base.generateWithUsage(cfg);
    },
    async *streamGenerate(cfg) {
      callCount.streamGenerate++;
      yield* base.streamGenerate(cfg);
    },
  };
  return { ai, callCount };
}

const inScopeResponse = {
  inScope: true,
  answer: 'Visit the Project page.',
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

async function newSession(ctx: ReturnType<typeof createTestContext>) {
  return createSession(ctx, { chatName: 'test', userId: 'u1', audience: 'user', locale: 'en' });
}

describe('runChatTurn — event sequence', () => {
  it('emits turn.started, message.delta, and turn.completed in order', async () => {
    const ctx = createTestContext({ ai: mockAI({ generate: inScopeResponse }) });
    const chat = defineChat({ name: 'test', access: {}, instructions: ['You are helpful'] });
    const session = await newSession(ctx);
    const events = collectEvents();

    for await (const evt of runChatTurn(ctx, {
      chatDefinition: chat,
      sessionId: session.id,
      userMessage: 'hi',
      audience: 'user',
      locale: 'en',
    })) {
      events.push(evt);
    }

    const types = events.all.map((e) => e.type);
    expect(types[0]).toBe('turn.started');
    expect(types).toContain('message.delta');
    expect(types[types.length - 1]).toBe('turn.completed');
  });

  it('turn.completed includes inScope, refusalReason, and sources metadata', async () => {
    const ctx = createTestContext({ ai: mockAI({ generate: refusalResponse }) });
    const chat = defineChat({ name: 'test', access: {}, instructions: ['x'] });
    const session = await newSession(ctx);
    const events = collectEvents();

    for await (const evt of runChatTurn(ctx, {
      chatDefinition: chat,
      sessionId: session.id,
      userMessage: 'off topic',
      audience: 'user',
      locale: 'en',
    })) {
      events.push(evt);
    }

    const completed = events.byType('turn.completed')[0];
    expect(completed?.type).toBe('turn.completed');
    if (completed?.type !== 'turn.completed') return;
    expect(completed.inScope).toBe(false);
    expect(completed.refusalReason).toBe('off_topic');
    expect(completed.sources).toEqual([]);
  });

  it('emits one source.added per resolved source', async () => {
    const ctx = createTestContext({ ai: mockAI({ generate: inScopeResponse }) });
    const chat = defineChat({
      name: 'test',
      access: {},
      instructions: ['x'],
      context: [
        staticContext({
          id: 'paths',
          items: [{ id: 'p1', kind: 'text', content: 'one' }],
          sourceId: 'paths-src',
        }),
        staticContext({
          id: 'glossary',
          items: [{ id: 'g1', kind: 'text', content: 'two' }],
          sourceId: 'glossary-src',
        }),
      ],
    });
    const session = await newSession(ctx);
    const events = collectEvents();

    for await (const evt of runChatTurn(ctx, {
      chatDefinition: chat,
      sessionId: session.id,
      userMessage: 'hi',
      audience: 'user',
      locale: 'en',
    })) {
      events.push(evt);
    }

    expect(events.byType('source.added')).toHaveLength(2);
  });

  it('auto-creates the session when it does not exist (saveToDb: true default)', async () => {
    // This used to emit chat.session_not_found, requiring consumers to ship a
    // separate "chatStart" capability. Now runChatTurn calls getOrCreateSession
    // so a client-generated UUID Just Works on first turn.
    const ctx = createTestContext({
      auth: { userId: 'u1', roles: ['user'], tenantId: 't1', scopes: [], provider: 'test' },
      ai: mockAI({ generate: inScopeResponse }),
    });
    const chat = defineChat({ name: 'test', access: {}, instructions: ['x'] });
    const events = collectEvents();
    const missingId = '00000000-0000-4000-a000-000000000999';

    for await (const evt of runChatTurn(ctx, {
      chatDefinition: chat,
      sessionId: missingId,
      userMessage: 'hi',
      audience: 'user',
      locale: 'en',
    })) {
      events.push(evt);
    }

    expect(events.byType('turn.failed')).toHaveLength(0);
    expect(events.byType('turn.completed')).toHaveLength(1);
    const created = await ctx.data.ChatSession?.findById(missingId);
    expect(created?.id).toBe(missingId);
  });
});

describe('runChatTurn — empty-answer fallback regression', () => {
  it('does NOT call generateWithUsage when streaming delivered a valid done payload', async () => {
    // mockAI's streamGenerate yields delta + done; streamCompleted should be
    // true, fallback must NOT fire. Bug being guarded: previously the runtime
    // fell back whenever `answer` was empty, double-charging refusals.
    const { ai, callCount } = countingAI({ generate: inScopeResponse });
    const ctx = createTestContext({ ai });
    const chat = defineChat({ name: 'test', access: {}, instructions: ['x'] });
    const session = await newSession(ctx);

    for await (const _evt of runChatTurn(ctx, {
      chatDefinition: chat,
      sessionId: session.id,
      userMessage: 'hi',
      audience: 'user',
      locale: 'en',
    })) {
      // drain
    }

    expect(callCount.streamGenerate).toBe(1);
    expect(callCount.generateWithUsage).toBe(0);
  });

  it('does NOT call generateWithUsage on a legitimate refusal (inScope=false, empty answer)', async () => {
    // The bug we fixed: refusals legitimately produce inScope:false answer:''.
    // The old code's `if (!modelOutput.answer)` would fall back to
    // generateWithUsage, double-charging every refusal turn.
    const { ai, callCount } = countingAI({ generate: refusalResponse });
    const ctx = createTestContext({ ai });
    const chat = defineChat({ name: 'test', access: {}, instructions: ['x'] });
    const session = await newSession(ctx);

    for await (const _evt of runChatTurn(ctx, {
      chatDefinition: chat,
      sessionId: session.id,
      userMessage: 'something off-topic',
      audience: 'user',
      locale: 'en',
    })) {
      // drain
    }

    expect(callCount.streamGenerate).toBe(1);
    expect(callCount.generateWithUsage).toBe(0);
  });
});

describe('runChatTurn — trace recorder', () => {
  it('records resolved sources, prompt, model output, guard verdicts, and events', async () => {
    const ctx = createTestContext({ ai: mockAI({ generate: inScopeResponse }) });
    const chat = defineChat({
      name: 'test',
      access: {},
      instructions: ['x'],
      context: [
        staticContext({
          id: 'paths',
          items: [{ id: 'p1', kind: 'text', content: 'one' }],
          sourceId: 'paths-src',
        }),
      ],
    });
    const session = await newSession(ctx);
    const trace = new TraceRecorder();

    for await (const _evt of runChatTurn(ctx, {
      chatDefinition: chat,
      sessionId: session.id,
      userMessage: 'hi',
      audience: 'user',
      locale: 'en',
      traceRecorder: trace,
    })) {
      // drain
    }

    expect(trace.trace.resolvedSources).not.toBeNull();
    expect(trace.trace.systemPrompt).toBeDefined();
    expect((trace.trace.systemPrompt ?? '').length).toBeGreaterThan(0);
    expect(trace.trace.modelOutput).toBeDefined();
    expect(trace.trace.modelOutput?.inScope).toBe(true);
    expect(trace.trace.guardVerdicts.length).toBeGreaterThan(0);
    expect(trace.trace.events.length).toBeGreaterThan(0);
    expect(trace.trace.events.map((e) => e.type)).toContain('turn.started');
    expect(trace.trace.events.map((e) => e.type)).toContain('turn.completed');
  });
});

describe('runChatTurn — cited-sources persistence', () => {
  it('persists only the sources the model actually cited, not the full retrieved set', async () => {
    // The model cites only "paths-src". The chat retrieves two sources. The
    // saved ChatTurnRow.sources should contain only the cited one — the other
    // was retrieved-but-not-used and shouldn't pollute the audit trail.
    //
    // The resolver issues handles in stable order: src_a, src_a2, ...
    // So the first source's runtime handle is "src_a", second is "src_a2".
    const ctx = createTestContext({
      ai: mockAI({
        generate: {
          inScope: true,
          answer: 'See [src:src_a].',
          refusalReason: null,
          citedSources: ['src_a'],
          requestedAction: null,
        },
      }),
    });
    const chat = defineChat({
      name: 'test',
      access: {},
      instructions: ['x'],
      context: [
        staticContext({
          id: 'paths',
          items: [{ id: 'p1', kind: 'text', content: 'one' }],
          sourceId: 'paths-src',
        }),
        staticContext({
          id: 'glossary',
          items: [{ id: 'g1', kind: 'text', content: 'two' }],
          sourceId: 'glossary-src',
        }),
      ],
    });
    const session = await newSession(ctx);

    for await (const _evt of runChatTurn(ctx, {
      chatDefinition: chat,
      sessionId: session.id,
      userMessage: 'hi',
      audience: 'user',
      locale: 'en',
    })) {
      // drain
    }

    const turns = await ctx.data.ChatTurn?.findMany({ sessionId: session.id });
    const assistant = turns?.find((t) => t.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant?.sources).toHaveLength(1);
    expect(assistant?.sources?.[0]?.id).toBe('src_a');
  });

  it('persists empty sources when the model cites nothing', async () => {
    const ctx = createTestContext({
      ai: mockAI({
        generate: {
          inScope: true,
          answer: 'fine',
          refusalReason: null,
          citedSources: [],
          requestedAction: null,
        },
      }),
    });
    const chat = defineChat({
      name: 'test',
      access: {},
      instructions: ['x'],
      context: [
        staticContext({
          id: 'paths',
          items: [{ id: 'p1', kind: 'text', content: 'one' }],
          sourceId: 'paths-src',
        }),
      ],
    });
    const session = await newSession(ctx);

    for await (const _evt of runChatTurn(ctx, {
      chatDefinition: chat,
      sessionId: session.id,
      userMessage: 'hi',
      audience: 'user',
      locale: 'en',
    })) {
      // drain
    }

    const turns = await ctx.data.ChatTurn?.findMany({ sessionId: session.id });
    const assistant = turns?.find((t) => t.role === 'assistant');
    expect(assistant?.sources).toEqual([]);
  });
});

describe('runChatTurn — persistence modes', () => {
  it('client-persistence: uses provided clientHistory verbatim and stores empty content', async () => {
    const ctx = createTestContext({ ai: mockAI({ generate: inScopeResponse }) });
    const chat = defineChat({
      name: 'test',
      access: {},
      instructions: ['x'],
      persistence: { messageContent: 'client' },
    });
    const session = await newSession(ctx);

    for await (const _evt of runChatTurn(ctx, {
      chatDefinition: chat,
      sessionId: session.id,
      userMessage: 'hi',
      audience: 'user',
      locale: 'en',
      clientHistory: [
        { role: 'user', content: 'earlier user msg' },
        { role: 'assistant', content: 'earlier reply' },
      ],
    })) {
      // drain
    }

    const turns = await ctx.data.ChatTurn?.findMany({ sessionId: session.id });
    // Both stored turns should have empty content in client-persistence mode.
    for (const t of turns ?? []) {
      expect(t.content).toBe('');
    }
  });

  it('server-persistence: stores message content on both user and assistant rows', async () => {
    const ctx = createTestContext({ ai: mockAI({ generate: inScopeResponse }) });
    const chat = defineChat({
      name: 'test',
      access: {},
      instructions: ['x'],
      persistence: { messageContent: 'server' },
    });
    const session = await newSession(ctx);

    for await (const _evt of runChatTurn(ctx, {
      chatDefinition: chat,
      sessionId: session.id,
      userMessage: 'hi from user',
      audience: 'user',
      locale: 'en',
    })) {
      // drain
    }

    const turns = await ctx.data.ChatTurn?.findMany({ sessionId: session.id });
    const user = turns?.find((t) => t.role === 'user');
    const assistant = turns?.find((t) => t.role === 'assistant');
    expect(user?.content).toBe('hi from user');
    expect(assistant?.content).toBe(inScopeResponse.answer);
  });
});

describe('runChatTurn — ordinal incrementing', () => {
  it('appendTurn auto-increments ordinal across turns in the same session', async () => {
    const ctx = createTestContext({ ai: mockAI({ generate: inScopeResponse }) });
    const chat = defineChat({ name: 'test', access: {}, instructions: ['x'] });
    const session = await newSession(ctx);

    for (let i = 0; i < 2; i++) {
      for await (const _evt of runChatTurn(ctx, {
        chatDefinition: chat,
        sessionId: session.id,
        userMessage: `turn ${i}`,
        audience: 'user',
        locale: 'en',
      })) {
        // drain
      }
    }

    const turns = await ctx.data.ChatTurn?.findMany({ sessionId: session.id });
    const ordinals = (turns ?? []).map((t) => t.ordinal).sort((a, b) => a - b);
    // 2 turns × (user + assistant) = 4 rows, ordinals 0..3.
    expect(ordinals).toEqual([0, 1, 2, 3]);
  });
});

describe('runChatTurn — saveToDb: false (ephemeral mode)', () => {
  it('does not write chat_session or chat_turn rows when saveToDb is false', async () => {
    const ctx = createTestContext({ ai: mockAI({ generate: inScopeResponse }) });
    const chat = defineChat({
      name: 'help',
      access: {},
      instructions: ['x'],
      persistence: { messageContent: 'client', saveToDb: false },
    });

    // Client-generated UUID; no createSession call.
    const sessionId = '00000000-0000-4000-8000-00000000aaaa';

    for await (const _evt of runChatTurn(ctx, {
      chatDefinition: chat,
      sessionId,
      userMessage: 'hi',
      audience: 'user',
      locale: 'en',
      clientHistory: [],
    })) {
      // drain
    }

    const sessions = await ctx.data.ChatSession?.findMany({});
    const turns = await ctx.data.ChatTurn?.findMany({});
    expect(sessions ?? []).toHaveLength(0);
    expect(turns ?? []).toHaveLength(0);
  });

  it('emits turn.started + turn.completed even with no session row', async () => {
    const ctx = createTestContext({ ai: mockAI({ generate: inScopeResponse }) });
    const chat = defineChat({
      name: 'help',
      access: {},
      instructions: ['x'],
      persistence: { messageContent: 'client', saveToDb: false },
    });
    const events = collectEvents();

    for await (const evt of runChatTurn(ctx, {
      chatDefinition: chat,
      sessionId: '00000000-0000-4000-8000-00000000aaaa',
      userMessage: 'hi',
      audience: 'user',
      locale: 'en',
      clientHistory: [],
    })) {
      events.push(evt);
    }

    const types = events.all.map((e) => e.type);
    expect(types[0]).toBe('turn.started');
    expect(types[types.length - 1]).toBe('turn.completed');
    expect(events.byType('turn.failed')).toHaveLength(0);
  });

  it('enforces budget.perSession.userMessages by counting clientHistory', async () => {
    const ctx = createTestContext({ ai: mockAI({ generate: inScopeResponse }) });
    const chat = defineChat({
      name: 'help',
      access: {},
      instructions: ['x'],
      persistence: { messageContent: 'client', saveToDb: false },
      budget: { perSession: { userMessages: 2 } },
    });
    const events = collectEvents();

    // 2 prior user messages already in clientHistory → cap is 2 → this turn
    // would make it 3, which exceeds the cap.
    for await (const evt of runChatTurn(ctx, {
      chatDefinition: chat,
      sessionId: '00000000-0000-4000-8000-00000000aaaa',
      userMessage: 'third',
      audience: 'user',
      locale: 'en',
      clientHistory: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'fine' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'fine' },
      ],
    })) {
      events.push(evt);
    }

    const failed = events.byType('turn.failed')[0] as { code: string } | undefined;
    expect(failed?.code).toBe('chat.budget_exceeded');
  });

  it('enforces refusal cooldown from clientHistory when last N assistants are refusals', async () => {
    const ctx = createTestContext({ ai: mockAI({ generate: inScopeResponse }) });
    const chat = defineChat({
      name: 'help',
      access: {},
      instructions: ['x'],
      persistence: { messageContent: 'client', saveToDb: false },
      policy: {
        behavioral: {
          cooldowns: [
            { trigger: 'refusal', count: 3, durationSeconds: 30, scope: 'session' },
          ],
        },
      },
    });
    const events = collectEvents();

    // Last 3 assistant turns in history are all refusals → cooldown trips.
    for await (const evt of runChatTurn(ctx, {
      chatDefinition: chat,
      sessionId: '00000000-0000-4000-8000-00000000aaaa',
      userMessage: 'one more',
      audience: 'user',
      locale: 'en',
      clientHistory: [
        { role: 'user', content: 'off1' },
        { role: 'assistant', content: '', refusalReason: 'off_topic' },
        { role: 'user', content: 'off2' },
        { role: 'assistant', content: '', refusalReason: 'off_topic' },
        { role: 'user', content: 'off3' },
        { role: 'assistant', content: '', refusalReason: 'off_topic' },
      ],
    })) {
      events.push(evt);
    }

    const notice = events.byType('notice')[0] as
      | { code: string; retryAfterSeconds?: number }
      | undefined;
    expect(notice?.code).toBe('chat.cooldown_active');
    expect(notice?.retryAfterSeconds).toBe(30);
    const failed = events.byType('turn.failed')[0] as { code: string } | undefined;
    expect(failed?.code).toBe('cooldown_active');
  });

  it('allows normal turn when refusal count in clientHistory is below threshold', async () => {
    const ctx = createTestContext({ ai: mockAI({ generate: inScopeResponse }) });
    const chat = defineChat({
      name: 'help',
      access: {},
      instructions: ['x'],
      persistence: { messageContent: 'client', saveToDb: false },
      policy: {
        behavioral: {
          cooldowns: [
            { trigger: 'refusal', count: 3, durationSeconds: 30, scope: 'session' },
          ],
        },
      },
    });
    const events = collectEvents();

    // Only 2 refusals in history → below threshold of 3.
    for await (const evt of runChatTurn(ctx, {
      chatDefinition: chat,
      sessionId: '00000000-0000-4000-8000-00000000aaaa',
      userMessage: 'continuing',
      audience: 'user',
      locale: 'en',
      clientHistory: [
        { role: 'user', content: 'off1' },
        { role: 'assistant', content: '', refusalReason: 'off_topic' },
        { role: 'user', content: 'real question' },
        { role: 'assistant', content: 'real answer' },
        { role: 'user', content: 'off2' },
        { role: 'assistant', content: '', refusalReason: 'off_topic' },
      ],
    })) {
      events.push(evt);
    }

    // No cooldown should fire — last 3 assistant messages aren't all refusals.
    expect(events.byType('notice').find((n) => (n as { code: string }).code === 'chat.cooldown_active')).toBeUndefined();
    expect(events.byType('turn.completed')).toHaveLength(1);
  });
});

describe('runChatTurn — saveToDb: true with client-generated sessionId', () => {
  it('auto-creates the chat_session row when loadSession returns null', async () => {
    const ctx = createTestContext({
      auth: { userId: 'u1', roles: ['user'], tenantId: 't1', scopes: [], provider: 'test' },
      ai: mockAI({ generate: inScopeResponse }),
    });
    const chat = defineChat({
      name: 'help',
      access: {},
      instructions: ['x'],
      // explicit default — exercises the auto-create path under DB mode
      persistence: { messageContent: 'client', saveToDb: true },
    });

    const clientSessionId = '00000000-0000-4000-8000-00000000c0fe';
    expect(await ctx.data.ChatSession?.findById(clientSessionId)).toBeNull();

    const events = collectEvents();
    for await (const evt of runChatTurn(ctx, {
      chatDefinition: chat,
      sessionId: clientSessionId,
      userMessage: 'hi',
      audience: 'user',
      locale: 'en',
      clientHistory: [],
    })) {
      events.push(evt);
    }

    // Session row exists now with the caller-supplied id and identity.
    const created = await ctx.data.ChatSession?.findById(clientSessionId);
    expect(created).not.toBeNull();
    expect(created?.id).toBe(clientSessionId);
    expect(created?.userId).toBe('u1');
    expect(created?.tenantId).toBe('t1');
    expect(created?.chatName).toBe('help');
    expect(created?.audience).toBe('user');
    expect(created?.locale).toBe('en');

    // Turn completed cleanly — no chat.session_not_found.
    expect(events.byType('turn.failed')).toHaveLength(0);
    expect(events.byType('turn.completed')).toHaveLength(1);

    // Turn rows written under the new session.
    const turns = await ctx.data.ChatTurn?.findMany({ sessionId: clientSessionId });
    expect((turns ?? []).length).toBeGreaterThan(0);
  });

  it('reuses the existing session on subsequent turns (no double-create)', async () => {
    const ctx = createTestContext({
      auth: { userId: 'u1', roles: ['user'], tenantId: 't1', scopes: [], provider: 'test' },
      ai: mockAI({ generate: inScopeResponse }),
    });
    const chat = defineChat({
      name: 'help',
      access: {},
      instructions: ['x'],
      persistence: { messageContent: 'client', saveToDb: true },
    });

    const sid = '00000000-0000-4000-8000-00000000c0ff';

    // Turn 1: auto-creates
    for await (const _evt of runChatTurn(ctx, {
      chatDefinition: chat,
      sessionId: sid,
      userMessage: 'first',
      audience: 'user',
      locale: 'en',
      clientHistory: [],
    })) {
      // drain
    }
    // Turn 2: same sessionId — must NOT throw "primary key collision"
    for await (const _evt of runChatTurn(ctx, {
      chatDefinition: chat,
      sessionId: sid,
      userMessage: 'second',
      audience: 'user',
      locale: 'en',
      clientHistory: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'fine' }],
    })) {
      // drain
    }

    // One session, two turns × (user+assistant) = 4 chat_turn rows
    const sessions = await ctx.data.ChatSession?.findMany({ id: sid });
    expect(sessions ?? []).toHaveLength(1);
    const turns = await ctx.data.ChatTurn?.findMany({ sessionId: sid });
    expect((turns ?? []).length).toBe(4);
  });
});
