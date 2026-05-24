import { describe, expect, it } from 'vitest';
import {
  applyChatEvent,
  buildTurnRequestBody,
  initialChatUiState,
  pushUserMessage,
} from '../useChat-helpers.js';

describe('pushUserMessage', () => {
  it('appends a user message and sets status streaming', () => {
    const next = pushUserMessage(initialChatUiState, 'hello');
    expect(next.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(next.status).toBe('streaming');
  });
});

describe('applyChatEvent — message.delta', () => {
  it('starts a new assistant message when no assistant message exists yet', () => {
    const state = pushUserMessage(initialChatUiState, 'hi');
    const next = applyChatEvent(state, { type: 'message.delta', text: 'Hello!' });
    expect(next.messages).toHaveLength(2);
    expect(next.messages[1]).toEqual({ role: 'assistant', content: 'Hello!' });
  });

  it('appends to the in-progress assistant message instead of pushing a new one', () => {
    let s = pushUserMessage(initialChatUiState, 'hi');
    s = applyChatEvent(s, { type: 'message.delta', text: 'Hel' });
    s = applyChatEvent(s, { type: 'message.delta', text: 'lo!' });
    expect(s.messages).toHaveLength(2);
    expect(s.messages[1]?.content).toBe('Hello!');
  });
});

describe('applyChatEvent — source.added', () => {
  it('attaches the source id to the in-progress assistant message', () => {
    let s = pushUserMessage(initialChatUiState, 'hi');
    s = applyChatEvent(s, { type: 'message.delta', text: 'See it.' });
    s = applyChatEvent(s, {
      type: 'source.added',
      source: { id: 'src_a', origin: 'static', label: 'paths' },
    });
    expect(s.messages[1]?.sources).toEqual(['src_a']);
  });

  it('dedupes when the same source id arrives twice', () => {
    let s = pushUserMessage(initialChatUiState, 'hi');
    s = applyChatEvent(s, { type: 'message.delta', text: 'x' });
    s = applyChatEvent(s, {
      type: 'source.added',
      source: { id: 'src_a', origin: 'static' },
    });
    s = applyChatEvent(s, {
      type: 'source.added',
      source: { id: 'src_a', origin: 'static' },
    });
    expect(s.messages[1]?.sources).toEqual(['src_a']);
  });

  it('ignores source.added before any assistant message exists (no-op)', () => {
    const s = applyChatEvent(initialChatUiState, {
      type: 'source.added',
      source: { id: 'src_a', origin: 'static' },
    });
    expect(s.messages).toEqual([]);
  });
});

describe('applyChatEvent — notices and status', () => {
  it('records notices', () => {
    const s = applyChatEvent(initialChatUiState, {
      type: 'notice',
      code: 'chat.out_of_scope',
      message: 'off-topic',
    });
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]?.code).toBe('chat.out_of_scope');
  });

  it('flips status to cooldown only on chat.cooldown_active', () => {
    const s = applyChatEvent(initialChatUiState, {
      type: 'notice',
      code: 'chat.cooldown_active',
      message: 'wait',
      retryAfterSeconds: 30,
    });
    expect(s.status).toBe('cooldown');
    expect(s.notices[0]?.retryAfterSeconds).toBe(30);
  });

  it('does NOT flip status to cooldown for other notice codes', () => {
    const s = applyChatEvent(initialChatUiState, {
      type: 'notice',
      code: 'chat.provenance_missing',
      message: 'no cites',
    });
    expect(s.status).toBe('idle');
  });
});

describe('applyChatEvent — confirmation_required', () => {
  it('sets pendingConfirmation and flips status', () => {
    const s = applyChatEvent(initialChatUiState, {
      type: 'confirmation_required',
      actionId: 'a1',
      capabilityName: 'createTicket',
      confirmationMessage: 'Create a ticket?',
      expiresAt: '2099-01-01T00:00:00Z',
    });
    expect(s.status).toBe('awaiting_confirmation');
    expect(s.pendingConfirmation?.actionId).toBe('a1');
    expect(s.pendingConfirmation?.capabilityName).toBe('createTicket');
  });
});

describe('applyChatEvent — terminal events', () => {
  it('turn.completed flips status back to idle', () => {
    const s = applyChatEvent(
      { ...initialChatUiState, status: 'streaming' },
      { type: 'turn.completed', turnId: 't1', usage: { tokensIn: 0, tokensOut: 0 }, cost: 0 },
    );
    expect(s.status).toBe('idle');
  });

  it('turn.failed flips status to error', () => {
    const s = applyChatEvent(
      { ...initialChatUiState, status: 'streaming' },
      { type: 'turn.failed', code: 'chat.turn_error', message: 'boom' },
    );
    expect(s.status).toBe('error');
  });
});

describe('buildTurnRequestBody', () => {
  it('server-persistence: omits clientHistory entirely', () => {
    const body = buildTurnRequestBody({
      sessionId: 's1',
      userMessage: 'hi',
      audience: 'user',
      locale: 'en',
      persistence: 'server',
      currentMessages: [
        { role: 'user', content: 'earlier' },
        { role: 'assistant', content: 'older' },
      ],
    });
    expect(body.clientHistory).toBeUndefined();
    expect(body.sessionId).toBe('s1');
    expect(body.userMessage).toBe('hi');
  });

  it('client-persistence: sends local history plus the new user message, capped at 20', () => {
    const longHistory = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `m${i}`,
    }));
    const body = buildTurnRequestBody({
      sessionId: 's1',
      userMessage: 'new',
      audience: 'user',
      locale: 'en',
      persistence: 'client',
      currentMessages: longHistory,
    });
    expect(body.clientHistory).toBeDefined();
    expect(body.clientHistory).toHaveLength(20);
    // Last entry should always be the new user message.
    expect(body.clientHistory?.[19]).toEqual({ role: 'user', content: 'new' });
  });

  it('client-persistence with short history: includes everything plus the new message', () => {
    const body = buildTurnRequestBody({
      sessionId: 's1',
      userMessage: 'new',
      audience: 'user',
      locale: 'en',
      persistence: 'client',
      currentMessages: [{ role: 'assistant', content: 'one' }],
    });
    expect(body.clientHistory).toEqual([
      { role: 'assistant', content: 'one' },
      { role: 'user', content: 'new' },
    ]);
  });

  it('persistence undefined defaults to server-style (no clientHistory)', () => {
    const body = buildTurnRequestBody({
      sessionId: 's1',
      userMessage: 'hi',
      audience: 'user',
      locale: 'en',
      currentMessages: [],
    });
    expect(body.clientHistory).toBeUndefined();
  });
});
