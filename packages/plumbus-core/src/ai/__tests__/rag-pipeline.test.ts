import { describe, expect, it, vi } from 'vitest';
import { createInMemoryVectorStore, createRAGPipeline } from '../rag/pipeline.js';
import { createMockProvider } from './provider.test.js';

describe('RAG Pipeline', () => {
  function setup() {
    const provider = createMockProvider({
      embed: vi.fn(async (req) => ({
        embeddings: req.texts.map(() => [0.1, 0.2, 0.3]),
        model: 'mock-embed',
        usage: { totalTokens: req.texts.length * 5 },
      })),
    });
    const vectorStore = createInMemoryVectorStore();
    const pipeline = createRAGPipeline({ provider, vectorStore });
    return { provider, vectorStore, pipeline };
  }

  describe('ingest', () => {
    it('chunks and stores a document', async () => {
      const { pipeline, provider } = setup();
      const result = await pipeline.ingest({
        documentId: 'doc-1',
        content: 'Hello world. This is a test document.',
        source: 'test.txt',
        tenantId: 't1',
      });

      expect(result.documentId).toBe('doc-1');
      expect(result.chunkCount).toBeGreaterThanOrEqual(1);
      expect(provider.embed).toHaveBeenCalled();
    });

    it('creates multiple chunks for long documents', async () => {
      const { pipeline } = setup();
      const result = await pipeline.ingest({
        documentId: 'doc-2',
        content: 'A'.repeat(3000),
        source: 'big.txt',
      });

      expect(result.chunkCount).toBeGreaterThan(1);
    });
  });

  describe('retrieve', () => {
    it('retrieves documents based on query', async () => {
      const { pipeline } = setup();
      await pipeline.ingest({
        documentId: 'doc-1',
        content: 'TypeScript is a typed superset of JavaScript.',
        source: 'ts.md',
        tenantId: 't1',
      });

      const results = await pipeline.retrieve({
        query: 'What is TypeScript?',
        tenantId: 't1',
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.content).toContain('TypeScript');
      expect(results[0]!.source).toBe('ts.md');
      expect(typeof results[0]!.score).toBe('number');
    });

    it('isolates results by tenant', async () => {
      const { pipeline } = setup();
      await pipeline.ingest({
        documentId: 'doc-t1',
        content: 'Tenant 1 doc',
        source: 't1.md',
        tenantId: 't1',
      });
      await pipeline.ingest({
        documentId: 'doc-t2',
        content: 'Tenant 2 doc',
        source: 't2.md',
        tenantId: 't2',
      });

      const results = await pipeline.retrieve({
        query: 'doc',
        tenantId: 't1',
      });

      expect(results.every((r) => r.metadata?.documentId !== 'doc-t2')).toBe(true);
    });
  });

  describe('deleteDocument', () => {
    it('removes all chunks for a document', async () => {
      const { pipeline } = setup();
      await pipeline.ingest({
        documentId: 'doc-del',
        content: 'To be deleted',
        source: 'del.md',
      });

      await pipeline.deleteDocument('doc-del');

      const results = await pipeline.retrieve({ query: 'deleted' });
      const hasDeleted = results.some((r) => r.metadata?.documentId === 'doc-del');
      expect(hasDeleted).toBe(false);
    });
  });
});

describe('In-Memory Vector Store', () => {
  it('computes cosine similarity correctly', async () => {
    const store = createInMemoryVectorStore();
    await store.insert([
      {
        id: '1',
        documentId: 'd1',
        content: 'similar',
        chunkIndex: 0,
        embedding: [1, 0, 0],
      },
      {
        id: '2',
        documentId: 'd2',
        content: 'different',
        chunkIndex: 0,
        embedding: [0, 1, 0],
      },
    ]);

    const results = await store.search([1, 0, 0], { limit: 10, minScore: 0 });

    expect(results[0]!.content).toBe('similar');
    expect(results[0]!.score).toBeCloseTo(1.0);
    expect(results[1]!.score).toBeCloseTo(0.0);
  });

  it('filters by minScore', async () => {
    const store = createInMemoryVectorStore();
    await store.insert([
      { id: '1', documentId: 'd1', content: 'a', chunkIndex: 0, embedding: [1, 0] },
      { id: '2', documentId: 'd2', content: 'b', chunkIndex: 0, embedding: [0, 1] },
    ]);

    const results = await store.search([1, 0], { limit: 10, minScore: 0.5 });
    expect(results).toHaveLength(1);
  });
});
