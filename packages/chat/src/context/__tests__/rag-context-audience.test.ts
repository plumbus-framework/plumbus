import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from '@plumbus/core/testing';
import { ragContext } from '../rag-context.js';

describe('C10 ragContext audience gating', () => {
  it('applies default audience filter when applyDefaultAudienceFilter is true', async () => {
    const retrieve = vi.fn(async () => []);
    const ctx = createTestContext({ ai: { ...createTestContext().ai, retrieve } });
    const source = ragContext({ corpus: 'help', query: 'q' });

    await source.resolve(ctx, {
      sessionId: 's1',
      ordinal: 0,
      userId: 'u1',
      audience: 'partner',
      locale: 'en',
      applyDefaultAudienceFilter: true,
      signal: AbortSignal.timeout(5000),
    });

    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { audience: 'partner' } }),
    );
  });

  it('skips audience filter when parentChatAudiencePolicy is false', async () => {
    const retrieve = vi.fn(async () => []);
    const ctx = createTestContext({ ai: { ...createTestContext().ai, retrieve } });
    const source = ragContext({
      corpus: 'help',
      query: 'q',
      parentChatAudiencePolicy: false,
    });

    await source.resolve(ctx, {
      sessionId: 's1',
      ordinal: 0,
      userId: 'u1',
      audience: 'partner',
      locale: 'en',
      applyDefaultAudienceFilter: true,
      signal: AbortSignal.timeout(5000),
    });

    expect(retrieve).toHaveBeenCalledWith(expect.objectContaining({ filter: undefined }));
  });

  it('honors explicit filter over default audience gating', async () => {
    const retrieve = vi.fn(async () => []);
    const ctx = createTestContext({ ai: { ...createTestContext().ai, retrieve } });
    const source = ragContext({
      corpus: 'help',
      query: 'q',
      filter: () => ({ tier: 'internal' }),
    });

    await source.resolve(ctx, {
      sessionId: 's1',
      ordinal: 0,
      userId: 'u1',
      audience: 'partner',
      locale: 'en',
      applyDefaultAudienceFilter: true,
      signal: AbortSignal.timeout(5000),
    });

    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { tier: 'internal' } }),
    );
  });
});
