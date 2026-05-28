import { describe, expect, it, vi } from '@plumbus/core/testing';
import { createTestContext, mockAI } from '@plumbus/core/testing';
import {
  createKnowledgeRegistry,
  defineKnowledgeSource,
  ragCorpus,
  staticBlocks,
} from '@plumbus/knowledge-base';
import { knowledgeContext } from '../knowledge-context.js';
import { resolveContextSources } from '../resolver.js';

describe('knowledgeContext registry integration', () => {
  const turnCtx = {
    sessionId: 's1',
    ordinal: 0,
    userId: 'u1',
    audience: 'user',
    locale: 'en',
    signal: AbortSignal.timeout(5000),
    traceId: 't1',
    userMessage: 'how do interviews work?',
  };

  it('uses registry-backed getBlock', async () => {
    const registry = createKnowledgeRegistry({
      sources: [
        defineKnowledgeSource({
          name: 'help-kb',
          provider: staticBlocks({ blocks: [{ text: 'help facts' }] }),
        }),
      ],
    });
    const ctx = createTestContext();
    const resolved = await resolveContextSources(
      ctx,
      [knowledgeContext({ registry, source: 'help-kb' })],
      turnCtx,
      { perSourceTimeoutMs: 1000, onError: 'fail' },
    );
    expect(resolved.items[0]?.content).toContain('help facts');
  });

  it('passes queryFromTurn result as getBlock query', async () => {
    const retrieve = vi.fn(async () => [{ content: 'rag hit', score: 1, source: 's' }]);
    const registry = createKnowledgeRegistry({
      sources: [
        defineKnowledgeSource({
          name: 'rag-kb',
          provider: ragCorpus({ corpus: 'help' }),
        }),
      ],
    });
    const ctx = createTestContext({ ai: { ...mockAI(), retrieve } });
    await resolveContextSources(
      ctx,
      [
        knowledgeContext({
          registry,
          source: 'rag-kb',
          queryFromTurn: (t) => t.userMessage ?? '',
        }),
      ],
      turnCtx,
      { perSourceTimeoutMs: 1000, onError: 'fail' },
    );
    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'how do interviews work?' }),
    );
  });

  it('supports scopeFromTurn override', async () => {
    let scope: unknown;
    const registry = createKnowledgeRegistry({
      sources: [
        defineKnowledgeSource({
          name: 'scope-kb',
          provider: {
            async getBlock(_ctx, s) {
              scope = s;
              return 'ok';
            },
          },
        }),
      ],
    });
    const ctx = createTestContext();
    await resolveContextSources(
      ctx,
      [
        knowledgeContext({
          registry,
          source: 'scope-kb',
          scopeFromTurn: () => ({ custom: { projectId: 'abc' } }),
        }),
      ],
      turnCtx,
      { perSourceTimeoutMs: 1000, onError: 'fail' },
    );
    expect(scope).toEqual({ custom: { projectId: 'abc' } });
  });
});
