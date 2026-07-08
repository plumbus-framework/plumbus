import { describe, expect, it } from 'vitest';
import { createTestContext } from '@plumbus/core/testing';
import { checkBudgetPreflight } from '../enforcer.js';
import { appendTurn, createSession } from '../../session/service.js';

describe('checkBudgetPreflight', () => {
  it('throws when perSession token limit is exceeded', async () => {
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
        tokensIn: 60,
        tokensOut: 50,
        costUsd: 0,
        model: 'm',
        latencyMs: 1,
        recordedAt: new Date(),
        userId: 'u1',
      },
      { persistContent: true },
    );

    await expect(
      checkBudgetPreflight(ctx, {
        chatName: 'help',
        userId: 'u1',
        sessionId: session.id,
        budget: { perSession: { tokens: 100 } },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('throws when perUser daily turn limit is exceeded', async () => {
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
        role: 'user',
        content: 'a',
        inScope: true,
        sources: [],
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        model: 'm',
        latencyMs: 1,
        recordedAt: new Date(),
        userId: 'u1',
      },
      { persistContent: true },
    );

    await expect(
      checkBudgetPreflight(ctx, {
        chatName: 'help',
        userId: 'u1',
        sessionId: session.id,
        budget: { perUser: { turnsPerDay: 1 } },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });

    await expect(
      checkBudgetPreflight(ctx, {
        chatName: 'help',
        userId: 'u1',
        sessionId: crypto.randomUUID(),
        budget: { perUser: { turnsPerDay: 2 } },
      }),
    ).resolves.toBeUndefined();
  });

  it('throws when perTenant daily cost limit is exceeded', async () => {
    const ctx = createTestContext({
      auth: {
        userId: 'u1',
        roles: ['user'],
        scopes: [],
        provider: 'test',
        tenantId: 'tenant-1',
      },
    });
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: 'u1',
      audience: 'user',
      locale: 'en',
      tenantId: 'tenant-1',
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
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 2,
        model: 'm',
        latencyMs: 1,
        recordedAt: new Date(),
        userId: 'u1',
      },
      { persistContent: true },
    );

    await expect(
      checkBudgetPreflight(ctx, {
        chatName: 'help',
        userId: 'u1',
        tenantId: 'tenant-1',
        sessionId: session.id,
        budget: { perTenant: { costUsdPerDay: 1 } },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('throws when perSession userMessages limit is exceeded', async () => {
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
        role: 'user',
        content: 'hello',
        inScope: true,
        sources: [],
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        model: 'm',
        latencyMs: 1,
        recordedAt: new Date(),
        userId: 'u1',
      },
      { persistContent: true },
    );

    await expect(
      checkBudgetPreflight(ctx, {
        chatName: 'help',
        userId: 'u1',
        sessionId: session.id,
        budget: { perSession: { userMessages: 1 } },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});
