import { describe, expect, it } from 'vitest';
import { executeCapability } from '@plumbus/core';
import { createTestContext } from '@plumbus/core/testing';
import { chatListTurns } from '../chat-list-turns.js';
import { appendTurn, createSession } from '../../session/service.js';

describe('chatListTurns', () => {
  it('returns only turns for the authenticated user', async () => {
    const ctx = createTestContext({
      auth: { userId: 'user-b', roles: ['user'], scopes: [], provider: 'test' },
    });
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: 'user-a',
      audience: 'user',
      locale: 'en',
    });

    const baseTurn = {
      sessionId: session.id,
      role: 'user' as const,
      content: 'msg',
      inScope: true,
      sources: [] as string[],
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      model: '',
      latencyMs: 0,
      recordedAt: new Date(),
    };

    await appendTurn(ctx, { ...baseTurn, ordinal: 0, userId: 'user-a' }, { persistContent: true });
    await appendTurn(ctx, { ...baseTurn, ordinal: 0, userId: 'user-b' }, { persistContent: true });

    const result = await executeCapability(chatListTurns, ctx, {
      sessionId: session.id,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.turns).toHaveLength(1);
    }
  });
});
