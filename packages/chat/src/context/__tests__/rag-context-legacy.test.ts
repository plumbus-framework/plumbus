import { describe, expect, it, vi } from '@plumbus/core/testing';
import { createTestContext, mockAI } from '@plumbus/core/testing';
import { knowledgeContextLegacy, ragContext } from '../../index.js';
import { resolveContextSources } from '../resolver.js';

describe('ragContext legacy', () => {
  const turnCtx = {
    sessionId: 's1',
    ordinal: 0,
    userId: 'u1',
    audience: 'user',
    locale: 'en',
    signal: AbortSignal.timeout(5000),
    traceId: 't1',
  };

  it('ragContext preserves legacy direct retrieve behavior', async () => {
    const retrieve = vi.fn(async () => [{ content: 'doc', score: 0.9, source: 's1' }]);
    const ctx = createTestContext({ ai: { ...mockAI(), retrieve } });
    const resolved = await resolveContextSources(
      ctx,
      [ragContext({ corpus: 'help', query: 'test query' })],
      turnCtx,
      { perSourceTimeoutMs: 1000, onError: 'fail' },
    );
    expect(retrieve).toHaveBeenCalled();
    expect(resolved.items[0]?.content).toBe('doc');
  });

  it('knowledgeContextLegacy aliases ragContext', () => {
    expect(knowledgeContextLegacy).toBe(ragContext);
  });
});
