import { describe, expect, it } from '@plumbus/core/testing';
import { createTestContext } from '@plumbus/core/testing';
import { staticContext } from '../static-context.js';
import { resolveContextSources } from '../resolver.js';

describe('resolveContextSources', () => {
  const turnCtx = {
    sessionId: 's1',
    ordinal: 0,
    userId: 'u1',
    audience: 'user',
    locale: 'en',
    signal: AbortSignal.timeout(5000),
    traceId: 't1',
  };

  it('resolves multiple sources with stable handles', async () => {
    const ctx = createTestContext();
    const sources = [
      staticContext({ id: 'a', items: [{ id: '1', kind: 'text', content: 'A' }] }),
      staticContext({ id: 'b', items: [{ id: '2', kind: 'text', content: 'B' }] }),
    ];
    const r1 = await resolveContextSources(ctx, sources, turnCtx, {
      perSourceTimeoutMs: 1000,
      onError: 'fail',
    });
    const r2 = await resolveContextSources(ctx, sources, turnCtx, {
      perSourceTimeoutMs: 1000,
      onError: 'fail',
    });
    expect(r1.sourceRefs.map((s) => s.id)).toEqual(r2.sourceRefs.map((s) => s.id));
    expect(r1.items.length).toBe(2);
  });

  it('skips failed source when onError skip', async () => {
    const ctx = createTestContext();
    const bad = {
      kind: 'static' as const,
      id: 'bad',
      async resolve() {
        throw new Error('fail');
      },
    };
    const good = staticContext({ id: 'ok', items: [{ id: '1', kind: 'text', content: 'ok' }] });
    const resolved = await resolveContextSources(ctx, [bad, good], turnCtx, {
      perSourceTimeoutMs: 1000,
      onError: 'skip',
    });
    expect(resolved.items.length).toBe(1);
  });
});
