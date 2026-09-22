import { describe, expect, it } from '@plumbus/core/testing';
import { createTestContext } from '@plumbus/core/testing';
import {
  createKnowledgeRegistry,
  defineKnowledgeSource,
  staticBlocks,
} from '@plumbus/knowledge-base';
import { CHAT_TIER_TOOLS_ERROR_PREFIX, knowledgeContext } from '../knowledge-context.js';
import { resolveContextSources } from '../resolver.js';

describe('knowledgeContext static-blocks vertical slice', () => {
  const turnCtxBase = {
    sessionId: 's1',
    ordinal: 0,
    userId: 'u1',
    audience: 'user',
    locale: 'en',
    tenantId: 'tenant-1',
    signal: AbortSignal.timeout(5000),
    traceId: 't1',
  };

  const registry = createKnowledgeRegistry({
    sources: [
      defineKnowledgeSource({
        name: 'mock-kb',
        provider: staticBlocks({
          blocks: [
            { text: 'scoped user en', scope: { audience: 'user', locale: 'en' } },
            { text: 'admin only', scope: { audience: 'admin' } },
          ],
        }),
      }),
    ],
  });

  it('resolves staticBlocks text from registry-backed knowledgeContext', async () => {
    const ctx = createTestContext();
    const source = knowledgeContext({ registry, source: 'mock-kb' });
    const resolved = await resolveContextSources(ctx, [source], turnCtxBase, {
      perSourceTimeoutMs: 1000,
      onError: 'fail',
    });
    expect(resolved.items[0]?.content).toContain('scoped user en');
  });

  it('passes default audience locale tenant scope from TurnContext', async () => {
    let capturedScope: unknown;
    const spyRegistry = createKnowledgeRegistry({
      sources: [
        defineKnowledgeSource({
          name: 'spy-kb',
          provider: {
            async getBlock(_ctx, scope) {
              capturedScope = scope;
              return 'ok';
            },
          },
        }),
      ],
    });
    const ctx = createTestContext();
    const source = knowledgeContext({ registry: spyRegistry, source: 'spy-kb' });
    await resolveContextSources(ctx, [source], turnCtxBase, {
      perSourceTimeoutMs: 1000,
      onError: 'fail',
    });
    expect(capturedScope).toEqual({
      audience: 'user',
      locale: 'en',
      tenantId: 'tenant-1',
    });
  });

  it('passes contextTokenBudget to provider as maxTokens', async () => {
    let maxTokens: number | undefined;
    const spyRegistry = createKnowledgeRegistry({
      sources: [
        defineKnowledgeSource({
          name: 'budget-kb',
          provider: {
            async getBlock(_ctx, _scope, opts) {
              maxTokens = opts?.maxTokens;
              return 'ok';
            },
          },
        }),
      ],
    });
    const ctx = createTestContext();
    const source = knowledgeContext({ registry: spyRegistry, source: 'budget-kb' });
    await resolveContextSources(
      ctx,
      [source],
      { ...turnCtxBase, contextTokenBudget: 500 },
      { perSourceTimeoutMs: 1000, onError: 'fail' },
    );
    expect(maxTokens).toBe(500);
  });

  it('stamps userMessage with post-beforeTurn text before context resolution', async () => {
    let query: string | undefined;
    const spyRegistry = createKnowledgeRegistry({
      sources: [
        defineKnowledgeSource({
          name: 'query-kb',
          provider: {
            async getBlock(_ctx, _scope, opts) {
              query = opts?.query;
              return 'ok';
            },
          },
        }),
      ],
    });
    const ctx = createTestContext();
    const source = knowledgeContext({
      registry: spyRegistry,
      source: 'query-kb',
      queryFromTurn: (t) => t.userMessage ?? '',
    });
    await resolveContextSources(
      ctx,
      [source],
      { ...turnCtxBase, userMessage: 'effective user text' },
      { perSourceTimeoutMs: 1000, onError: 'fail' },
    );
    expect(query).toBe('effective user text');
  });

  it('throws knowledge.chat_tier_not_supported for tier tools', () => {
    expect(() => knowledgeContext({ registry, source: 'mock-kb', tier: 'tools' })).toThrow(
      CHAT_TIER_TOOLS_ERROR_PREFIX,
    );
  });
});
