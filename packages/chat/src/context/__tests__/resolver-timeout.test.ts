import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from '@plumbus/core/testing';
import { resolveContextSources } from '../resolver.js';
import type { ContextSource } from '../../types/context.js';

describe('C12 resolver timeout matrix', () => {
  it('fails the turn when onError is fail and a source times out', async () => {
    const slow: ContextSource = {
      kind: 'static',
      id: 'slow',
      resolve: () =>
        new Promise(() => {
          /* never resolves */
        }),
    };

    await expect(
      resolveContextSources(
        createTestContext(),
        [slow],
        {
          sessionId: 's1',
          ordinal: 0,
          userId: 'u1',
          audience: 'user',
          locale: 'en',
          signal: AbortSignal.timeout(30_000),
        },
        { perSourceTimeoutMs: 20, onError: 'fail' },
      ),
    ).rejects.toThrow(/timed out/);
  });

  it('skips timed-out sources when onError is skip', async () => {
    vi.useFakeTimers();
    const slow: ContextSource = {
      kind: 'static',
      id: 'slow',
      resolve: () =>
        new Promise(() => {
          /* never resolves */
        }),
    };
    const fast: ContextSource = {
      kind: 'static',
      id: 'fast',
      resolve: async () => ({ items: [], sources: [], estimatedTokens: 0 }),
    };

    const promise = resolveContextSources(
      createTestContext(),
      [slow, fast],
      {
        sessionId: 's1',
        ordinal: 0,
        userId: 'u1',
        audience: 'user',
        locale: 'en',
        signal: AbortSignal.timeout(30_000),
      },
      { perSourceTimeoutMs: 50, onError: 'skip' },
    );

    await vi.advanceTimersByTimeAsync(60);
    const result = await promise;
    expect(result.items).toHaveLength(0);
    vi.useRealTimers();
  });

  it('warns when skipping a timed-out source', async () => {
    vi.useFakeTimers();
    const ctx = createTestContext();
    const warnSpy = vi.spyOn(ctx.logger, 'warn');
    const slow: ContextSource = {
      kind: 'static',
      id: 'slow',
      resolve: () =>
        new Promise(() => {
          /* never resolves */
        }),
    };

    const promise = resolveContextSources(
      ctx,
      [slow],
      {
        sessionId: 's1',
        ordinal: 0,
        userId: 'u1',
        audience: 'user',
        locale: 'en',
        signal: AbortSignal.timeout(30_000),
      },
      { perSourceTimeoutMs: 50, onError: 'skip' },
    );

    await vi.advanceTimersByTimeAsync(60);
    await promise;
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('slow'),
      expect.objectContaining({ sourceId: 'slow' }),
    );
    vi.useRealTimers();
  });
});
