import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from '@plumbus/core/testing';
import { behavioralPostGuard, behavioralPreGuard } from '../behavioral-guard.js';
import * as sessionService from '../../session/service.js';
import type { ChatSessionRow } from '../../types/session.js';

describe('C8 behavioral cooldown matrix', () => {
  it('budget trigger records cooldown after post-guard', async () => {
    const updateSpy = vi.spyOn(sessionService, 'updateSessionBehavioralState').mockResolvedValue();
    vi.spyOn(sessionService, 'loadSession').mockResolvedValue({
      id: 'sess-1',
      behavioralState: {},
    } as ChatSessionRow);
    vi.spyOn(sessionService, 'loadMergedUserBehavioralState').mockResolvedValue({});

    const turnCtx = {
      sessionId: 'sess-1',
      ordinal: 1,
      userId: 'user-1',
      audience: 'user',
      locale: 'en',
    };

    await behavioralPostGuard(turnCtx, {
      ctx: createTestContext(),
      chatName: 'help',
      policy: {
        behavioral: {
          cooldowns: [{ trigger: 'budget', count: 1, durationSeconds: 60, scope: 'session' }],
        },
      },
      resolvedSources: new Set(),
      saveToDb: true,
      lastBudgetOrGuardSignal: 'budget',
      modelOutput: { inScope: true, answer: 'ok' },
    });

    expect(updateSpy).toHaveBeenCalledWith(
      expect.anything(),
      'sess-1',
      expect.objectContaining({
        'cooldown:budget:session:sess-1': expect.objectContaining({
          until: expect.any(Number),
        }),
      }),
    );

    updateSpy.mockRestore();
  });

  it('user scope pre-guard merges behavioral state across sessions', async () => {
    vi.spyOn(sessionService, 'loadSession').mockResolvedValue({
      id: 'sess-2',
      behavioralState: {},
    } as ChatSessionRow);
    vi.spyOn(sessionService, 'loadMergedUserBehavioralState').mockResolvedValue({
      'cooldown:budget:user:user-1': { until: Date.now() + 60_000 },
    });

    const verdict = await behavioralPreGuard(
      {
        sessionId: 'sess-2',
        ordinal: 0,
        userId: 'user-1',
        audience: 'user',
        locale: 'en',
      },
      {
        ctx: createTestContext(),
        chatName: 'help',
        policy: {
          behavioral: {
            cooldowns: [{ trigger: 'budget', count: 1, durationSeconds: 60, scope: 'user' }],
          },
        },
        resolvedSources: new Set(),
        saveToDb: true,
      },
    );

    expect(verdict.decision).toBe('block');
    expect(verdict.reason).toBe('cooldown_active');
  });

  it('session-scoped cooldown from another session does not block the current session', async () => {
    vi.spyOn(sessionService, 'loadSession').mockResolvedValue({
      id: 'sess-b',
      behavioralState: {},
    } as ChatSessionRow);
    vi.spyOn(sessionService, 'loadMergedUserBehavioralState').mockResolvedValue({
      'cooldown:budget:session:sess-a': { until: Date.now() + 60_000 },
    });

    const verdict = await behavioralPreGuard(
      {
        sessionId: 'sess-b',
        ordinal: 0,
        userId: 'user-1',
        audience: 'user',
        locale: 'en',
      },
      {
        ctx: createTestContext(),
        chatName: 'help',
        policy: {
          behavioral: {
            cooldowns: [{ trigger: 'budget', count: 1, durationSeconds: 60, scope: 'user' }],
          },
        },
        resolvedSources: new Set(),
        saveToDb: true,
      },
    );

    expect(verdict.decision).toBe('allow');
  });

  it('fresher cross-session user cooldown overrides stale local copy', async () => {
    vi.spyOn(sessionService, 'loadSession').mockResolvedValue({
      id: 'sess-b',
      behavioralState: {
        'cooldown:budget:user:user-1': { until: Date.now() - 60_000 },
      },
    } as ChatSessionRow);
    vi.spyOn(sessionService, 'loadMergedUserBehavioralState').mockResolvedValue({
      'cooldown:budget:user:user-1': { until: Date.now() + 60_000 },
    });

    const verdict = await behavioralPreGuard(
      {
        sessionId: 'sess-b',
        ordinal: 0,
        userId: 'user-1',
        audience: 'user',
        locale: 'en',
      },
      {
        ctx: createTestContext(),
        chatName: 'help',
        policy: {
          behavioral: {
            cooldowns: [{ trigger: 'budget', count: 1, durationSeconds: 60, scope: 'user' }],
          },
        },
        resolvedSources: new Set(),
        saveToDb: true,
      },
    );

    expect(verdict.decision).toBe('block');
    expect(verdict.reason).toBe('cooldown_active');
  });

  it('guardFailure trigger records cooldown after post-guard', async () => {
    const updateSpy = vi.spyOn(sessionService, 'updateSessionBehavioralState').mockResolvedValue();
    vi.spyOn(sessionService, 'loadSession').mockResolvedValue({
      id: 'sess-1',
      behavioralState: {},
    } as ChatSessionRow);
    vi.spyOn(sessionService, 'loadMergedUserBehavioralState').mockResolvedValue({});

    await behavioralPostGuard(
      {
        sessionId: 'sess-1',
        ordinal: 1,
        userId: 'user-1',
        audience: 'user',
        locale: 'en',
      },
      {
        ctx: createTestContext(),
        chatName: 'help',
        policy: {
          behavioral: {
            cooldowns: [
              { trigger: 'guardFailure', count: 1, durationSeconds: 60, scope: 'session' },
            ],
          },
        },
        resolvedSources: new Set(),
        saveToDb: true,
        lastBudgetOrGuardSignal: 'guardFailure',
        modelOutput: { inScope: true, answer: 'ok' },
      },
    );

    expect(updateSpy).toHaveBeenCalledWith(
      expect.anything(),
      'sess-1',
      expect.objectContaining({
        'cooldown:guardFailure:session:sess-1': expect.objectContaining({
          until: expect.any(Number),
        }),
      }),
    );

    updateSpy.mockRestore();
  });

  it('windowSeconds resets trigger count after the sliding window elapses', async () => {
    const updateSpy = vi.spyOn(sessionService, 'updateSessionBehavioralState').mockResolvedValue();
    vi.spyOn(sessionService, 'loadSession').mockResolvedValue({
      id: 'sess-1',
      behavioralState: {
        'budget:session:sess-1': { count: 1, windowStart: Date.now() - 120_000 },
      },
    } as ChatSessionRow);
    vi.spyOn(sessionService, 'loadMergedUserBehavioralState').mockResolvedValue({});

    await behavioralPostGuard(
      {
        sessionId: 'sess-1',
        ordinal: 2,
        userId: 'user-1',
        audience: 'user',
        locale: 'en',
      },
      {
        ctx: createTestContext(),
        chatName: 'help',
        policy: {
          behavioral: {
            cooldowns: [
              {
                trigger: 'budget',
                count: 2,
                windowSeconds: 60,
                durationSeconds: 30,
                scope: 'session',
              },
            ],
          },
        },
        resolvedSources: new Set(),
        saveToDb: true,
        lastBudgetOrGuardSignal: 'budget',
        modelOutput: { inScope: true, answer: 'ok' },
      },
    );

    const saved = updateSpy.mock.calls[0]?.[2] as Record<string, { count?: number }>;
    expect(saved['budget:session:sess-1']?.count).toBe(1);
    expect(saved['cooldown:budget:session:sess-1']).toBeUndefined();

    updateSpy.mockRestore();
  });
});
