import { describe, expect, it } from '@plumbus/core/testing';
import { createTestContext } from '@plumbus/core/testing';
import { appendTurn, aggregateForBudget, createSession, getOrCreateSession } from '../service.js';

describe('session service', () => {
  it('createSession round-trips', async () => {
    const ctx = createTestContext();
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: 'u1',
      audience: 'user',
      locale: 'en',
    });
    expect(session.chatName).toBe('help');
    expect(session.userId).toBe('u1');
  });

  it('appendTurn assigns ordinals', async () => {
    const ctx = createTestContext();
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: 'u1',
      audience: 'user',
      locale: 'en',
    });
    const t0 = await appendTurn(
      ctx,
      {
        sessionId: session.id,
        ordinal: 0,
        role: 'user',
        content: 'hi',
        inScope: true,
        sources: [],
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        model: '',
        latencyMs: 0,
        recordedAt: new Date(),
        userId: 'u1',
      },
      { persistContent: true },
    );
    const t1 = await appendTurn(
      ctx,
      {
        sessionId: session.id,
        ordinal: 0,
        role: 'assistant',
        content: 'hello',
        inScope: true,
        sources: [],
        tokensIn: 1,
        tokensOut: 2,
        costUsd: 0.01,
        model: 'gpt',
        latencyMs: 10,
        recordedAt: new Date(),
        userId: 'u1',
      },
      { persistContent: true },
    );
    expect(t0.ordinal).toBe(0);
    expect(t1.ordinal).toBe(1);
  });

  it('persistContent false writes empty content', async () => {
    const ctx = createTestContext();
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: 'u1',
      audience: 'user',
      locale: 'en',
    });
    const row = await appendTurn(
      ctx,
      {
        sessionId: session.id,
        ordinal: 0,
        role: 'user',
        content: 'secret',
        inScope: true,
        sources: [],
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        model: '',
        latencyMs: 0,
        recordedAt: new Date(),
        userId: 'u1',
      },
      { persistContent: false },
    );
    expect(row.content).toBe('');
  });

  it('getOrCreateSession rejects a different user for an existing session', async () => {
    const ctx = createTestContext();
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: 'user-a',
      audience: 'user',
      locale: 'en',
    });

    await expect(
      getOrCreateSession(ctx, {
        sessionId: session.id,
        chatName: 'help',
        userId: 'user-b',
        audience: 'user',
        locale: 'en',
      }),
    ).rejects.toMatchObject({ code: 'notFound' });
  });

  it('aggregateForBudget sums', async () => {
    const ctx = createTestContext();
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: 'u1',
      audience: 'user',
      locale: 'en',
    });
    await appendTurn(
      ctx,
      {
        sessionId: session.id,
        ordinal: 0,
        role: 'assistant',
        content: 'a',
        inScope: true,
        sources: [],
        tokensIn: 10,
        tokensOut: 20,
        costUsd: 0.5,
        model: 'm',
        latencyMs: 1,
        recordedAt: new Date(),
        userId: 'u1',
      },
      { persistContent: true },
    );
    const agg = await aggregateForBudget(ctx, { sessionId: session.id });
    expect(agg.turns).toBe(1);
    expect(agg.tokens).toBe(30);
    expect(agg.costUsd).toBe(0.5);
  });
});
