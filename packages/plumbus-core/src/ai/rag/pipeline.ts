// ── RAG Pipeline ──
// Ingestion, embedding, storage, and retrieval

import type { AIDocument } from '../../types/context.js';
import type { AIProviderAdapter } from '../provider.js';
import { chunkDocument, type ChunkConfig, type DocumentChunk } from './chunking.js';

// ── Ingestion Input ──
export interface IngestDocumentInput {
  /** Unique document identifier */
  documentId: string;
  /** Raw text content */
  content: string;
  /** Source reference (URL, file path, etc.) */
  source: string;
  /** Tenant isolation */
  tenantId?: string;
  /** Data classification level */
  classification?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

// ── Stored Chunk ──
export interface StoredChunk {
  id: string;
  documentId: string;
  content: string;
  chunkIndex: number;
  embedding: number[];
  source?: string;
  tenantId?: string;
  classification?: string;
  metadata?: Record<string, unknown>;
}

// ── Retrieval Query ──
export interface RetrievalQuery {
  query: string;
  tenantId?: string;
  /** Max classification level allowed (default: no filter) */
  maxClassification?: string;
  /** Max results (default: 5) */
  limit?: number;
  /** Minimum similarity score (default: 0.0) */
  minScore?: number;
}

// ── Vector Store Interface ──
export interface VectorStore {
  insert(chunks: StoredChunk[]): Promise<void>;
  search(
    embedding: number[],
    options: {
      tenantId?: string;
      maxClassification?: string;
      limit: number;
      minScore: number;
    },
  ): Promise<Array<StoredChunk & { score: number }>>;
  deleteByDocumentId(documentId: string): Promise<void>;
}

// ── RAG Pipeline ──
export interface RAGPipeline {
  ingest(input: IngestDocumentInput): Promise<{ documentId: string; chunkCount: number }>;
  retrieve(query: RetrievalQuery): Promise<AIDocument[]>;
  deleteDocument(documentId: string): Promise<void>;
}

export interface RAGPipelineConfig {
  provider: AIProviderAdapter;
  vectorStore: VectorStore;
  chunkConfig?: ChunkConfig;
  embeddingModel?: string;
  /** Max chunks to embed in a single batch (default: 100) */
  embeddingBatchSize?: number;
}

export function createRAGPipeline(config: RAGPipelineConfig): RAGPipeline {
  const { provider, vectorStore } = config;
  const batchSize = config.embeddingBatchSize ?? 100;

  return {
    async ingest(input: IngestDocumentInput) {
      // 1. Chunk the document
      const chunks: DocumentChunk[] = chunkDocument(input.content, config.chunkConfig);

      // 2. Generate embeddings in batches
      const storedChunks: StoredChunk[] = [];
      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const embeddingResponse = await provider.embed({
          texts: batch.map((c) => c.content),
          model: config.embeddingModel,
        });

        for (let j = 0; j < batch.length; j++) {
          const chunk = batch[j];
          const emb = embeddingResponse.embeddings[j];
          if (!chunk || !emb) continue;
          storedChunks.push({
            id: crypto.randomUUID(),
            documentId: input.documentId,
            content: chunk.content,
            chunkIndex: chunk.index,
            embedding: emb,
            source: input.source,
            tenantId: input.tenantId,
            classification: input.classification,
            metadata: input.metadata,
          });
        }
      }

      // 3. Store chunks with embeddings
      await vectorStore.insert(storedChunks);

      return { documentId: input.documentId, chunkCount: storedChunks.length };
    },

    async retrieve(query: RetrievalQuery): Promise<AIDocument[]> {
      const limit = query.limit ?? 5;
      const minScore = query.minScore ?? 0.0;

      // 1. Embed the query
      const embeddingResponse = await provider.embed({
        texts: [query.query],
        model: config.embeddingModel,
      });
      const queryEmbedding = embeddingResponse.embeddings[0];
      if (!queryEmbedding) return [];

      // 2. Search vector store
      const results = await vectorStore.search(queryEmbedding, {
        tenantId: query.tenantId,
        maxClassification: query.maxClassification,
        limit,
        minScore,
      });

      // 3. Deduplicate by documentId+chunkIndex
      const seen = new Set<string>();
      const deduplicated = results.filter((r) => {
        const key = `${r.documentId}:${r.chunkIndex}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // 4. Map to AIDocument
      return deduplicated.map((r) => ({
        content: r.content,
        source: r.source ?? r.documentId,
        score: r.score,
        metadata: {
          ...r.metadata,
          documentId: r.documentId,
          chunkIndex: r.chunkIndex,
          classification: r.classification,
        },
      }));
    },

    async deleteDocument(documentId: string) {
      await vectorStore.deleteByDocumentId(documentId);
    },
  };
}

// ── In-Memory Vector Store (for testing) ──
export function createInMemoryVectorStore(): VectorStore {
  const chunks: StoredChunk[] = [];

  function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < a.length; i++) {
      const ai = a[i] ?? 0;
      const bi = b[i] ?? 0;
      dot += ai * bi;
      magA += ai * ai;
      magB += bi * bi;
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
  }

  return {
    async insert(newChunks: StoredChunk[]) {
      chunks.push(...newChunks);
    },

    async search(embedding, options) {
      const filtered = chunks.filter((c) => {
        if (options.tenantId && c.tenantId !== options.tenantId) return false;
        return true;
      });

      const scored = filtered
        .map((c) => ({
          ...c,
          score: cosineSimilarity(embedding, c.embedding),
        }))
        .filter((c) => c.score >= options.minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, options.limit);

      return scored;
    },

    async deleteByDocumentId(documentId: string) {
      const idxs: number[] = [];
      for (let i = chunks.length - 1; i >= 0; i--) {
        if (chunks[i]?.documentId === documentId) idxs.push(i);
      }
      for (const idx of idxs) {
        chunks.splice(idx, 1);
      }
    },
  };
}
