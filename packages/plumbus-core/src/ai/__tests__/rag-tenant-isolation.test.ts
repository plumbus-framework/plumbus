import { describe, expect, it, vi } from 'vitest';
import { createAIService, singleProviderConfig } from '../ai-service.js';
import { createRAGPipeline, createInMemoryVectorStore } from '../rag/index.js';
import { createExecutionContext } from '../../execution/index.js';
import type { AIProviderAdapter } from '../provider.js';

const provider: AIProviderAdapter = {
  name: 'local',
  async complete() {
    return {
      content: 'ok',
      model: 'local',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  },
  async *stream() {
    yield { type: 'done' };
  },
  async embed() {
    return { embeddings: [[1, 0]], model: 'local', usage: { totalTokens: 0 } };
  },
};

describe('RAG tenant isolation', () => {
  it('binds concurrent contexts to their own tenant, including the anonymous namespace', async () => {
    const rag = createRAGPipeline({ provider, vectorStore: createInMemoryVectorStore() });
    for (const tenantId of ['a', 'b', undefined]) {
      await rag.ingest({
        documentId: tenantId ?? 'shared',
        content: tenantId ?? 'shared',
        source: 'test',
        tenantId,
      });
    }
    const ai = createAIService(
      singleProviderConfig(provider, { ragPipeline: rag, budget: { tenantId: 'stale' } }),
    );
    const contexts = ['a', 'b', undefined].map((tenantId) =>
      createExecutionContext({
        auth: { userId: 'reader', tenantId, provider: 'test', roles: [], scopes: [] },
        data: {},
        ai,
      }),
    );
    const results = await Promise.all(
      contexts.map((ctx) => ctx.ai.retrieve({ query: 'anything' })),
    );
    expect(results.map((docs) => docs.map((doc) => doc.content))).toEqual([
      ['a'],
      ['b'],
      ['shared'],
    ]);
  });

  it('filters foreign rows even if a custom vector store ignores tenant filters', async () => {
    const rag = createRAGPipeline({
      provider,
      vectorStore: {
        async insert() {},
        async deleteByDocumentId() {},
        async search() {
          return [
            {
              id: '1',
              documentId: '1',
              content: 'secret',
              chunkIndex: 0,
              embedding: [1, 0],
              tenantId: 'a',
              score: 1,
            },
          ];
        },
      },
    });
    expect(await rag.retrieve({ query: 'secret', tenantId: 'b' })).toEqual([]);
    expect(await rag.retrieve({ query: 'secret' })).toEqual([]);
  });
});

it('marks unknown embedding costs while retaining the numeric callback contract', async () => {
  const onEmbeddingCost = vi.fn();
  const rag = createRAGPipeline({
    provider,
    vectorStore: createInMemoryVectorStore(),
    onEmbeddingCost,
  });
  await rag.ingest({ documentId: 'x', source: 'local', content: 'text' });
  expect(onEmbeddingCost.mock.calls[0]?.[0]).toMatchObject({ cost: 0, costAvailable: false });
});
