import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAIService } from '../ai-service.js';
import {
  type AIProviderAdapter,
  createOpenAIAdapter,
  type EmbeddingRequest,
  type EmbeddingResponse,
} from '../provider.js';
import { createInMemoryVectorStore, createRAGPipeline, type VectorStore } from '../rag/pipeline.js';

/** Answers `embed` through `answer` and records every request it gets. */
function embeddingProvider(
  answer: (request: EmbeddingRequest) => Promise<EmbeddingResponse> = async (request) => ({
    embeddings: request.texts.map(() => [0.1, 0.2, 0.3]),
    model: 'embed',
    usage: { totalTokens: request.texts.length },
  }),
): AIProviderAdapter & { embeds: EmbeddingRequest[] } {
  const embeds: EmbeddingRequest[] = [];
  return {
    name: 'openai',
    embeds,
    async complete() {
      throw new Error('not used');
    },
    async *stream() {
      yield { type: 'done' as const, finishReason: 'stop' };
    },
    embed(request) {
      embeds.push(request);
      return answer(request);
    },
  };
}

/** An embedding answer that only ever ends by the request's signal, with its reason. */
function untilAborted(request: EmbeddingRequest): Promise<EmbeddingResponse> {
  return new Promise((_resolve, reject) => {
    request.signal?.addEventListener('abort', () => reject(request.signal?.reason), {
      once: true,
    });
  });
}

function spiedStore(): VectorStore & { search: ReturnType<typeof vi.fn> } {
  const store = createInMemoryVectorStore();
  return { ...store, search: vi.fn(store.search), insert: vi.fn(store.insert) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ctx.ai.retrieve signal', () => {
  it('passes the caller signal through the RAG pipeline to the embedding request', async () => {
    const provider = embeddingProvider();
    const ai = createAIService({
      providers: { openai: provider },
      defaultProvider: 'openai',
      ragPipeline: createRAGPipeline({ provider, vectorStore: createInMemoryVectorStore() }),
    });
    const caller = new AbortController();

    await ai.retrieve({ query: 'refund policy', signal: caller.signal, timeoutMs: 5_000 });

    expect(provider.embeds).toHaveLength(1);
    expect(provider.embeds[0]?.signal).toBe(caller.signal);
    expect(provider.embeds[0]?.timeout).toBe(5_000);
  });

  it('ends an in-flight retrieval when the caller aborts, without searching', async () => {
    const provider = embeddingProvider(untilAborted);
    const vectorStore = spiedStore();
    const ai = createAIService({
      providers: { openai: provider },
      defaultProvider: 'openai',
      ragPipeline: createRAGPipeline({ provider, vectorStore }),
    });
    const caller = new AbortController();
    const reason = new Error('caller went away');
    setTimeout(() => caller.abort(reason), 20);

    await expect(ai.retrieve({ query: 'refund policy', signal: caller.signal })).rejects.toBe(
      reason,
    );
    expect(vectorStore.search).not.toHaveBeenCalled();
  });

  it('does not embed a retrieval whose signal already fired, whatever the adapter', async () => {
    const provider = embeddingProvider();
    const pipeline = createRAGPipeline({ provider, vectorStore: createInMemoryVectorStore() });
    const reason = new Error('cancelled');

    await expect(pipeline.retrieve({ query: 'q', signal: AbortSignal.abort(reason) })).rejects.toBe(
      reason,
    );
    expect(provider.embeds).toHaveLength(0);
  });

  it('does not search once the signal fired during an embedding the adapter finished', async () => {
    const caller = new AbortController();
    const reason = new Error('cancelled');
    const provider = embeddingProvider(async (request) => {
      caller.abort(reason); // An adapter that ignores the signal and answers anyway.
      return {
        embeddings: request.texts.map(() => [1]),
        model: 'embed',
        usage: { totalTokens: 1 },
      };
    });
    const vectorStore = spiedStore();
    const onEmbeddingCost = vi.fn();
    const pipeline = createRAGPipeline({ provider, vectorStore, onEmbeddingCost });

    await expect(pipeline.retrieve({ query: 'q', signal: caller.signal })).rejects.toBe(reason);
    // The embedding was paid for, so it is still reported.
    expect(onEmbeddingCost).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'retrieve' }),
    );
    expect(vectorStore.search).not.toHaveBeenCalled();
  });
});

describe('RAG ingest signal', () => {
  it('passes the signal to every embedding batch', async () => {
    const provider = embeddingProvider();
    const pipeline = createRAGPipeline({
      provider,
      vectorStore: createInMemoryVectorStore(),
      embeddingBatchSize: 1,
    });
    const caller = new AbortController();

    const { chunkCount } = await pipeline.ingest({
      documentId: 'doc',
      content: 'A'.repeat(3000),
      source: 'doc.md',
      signal: caller.signal,
    });

    expect(chunkCount).toBeGreaterThan(1);
    expect(provider.embeds).toHaveLength(chunkCount);
    for (const request of provider.embeds) expect(request.signal).toBe(caller.signal);
  });

  it('embeds no further batch and stores nothing once the signal fires', async () => {
    const caller = new AbortController();
    const reason = new Error('cancelled');
    const provider = embeddingProvider(async (request) => {
      caller.abort(reason); // Fires while the first batch is embedded; the adapter still answers.
      return {
        embeddings: request.texts.map(() => [1]),
        model: 'embed',
        usage: { totalTokens: 1 },
      };
    });
    const vectorStore = spiedStore();
    const pipeline = createRAGPipeline({ provider, vectorStore, embeddingBatchSize: 1 });

    await expect(
      pipeline.ingest({
        documentId: 'doc',
        content: 'A'.repeat(3000),
        source: 'doc.md',
        signal: caller.signal,
      }),
    ).rejects.toBe(reason);
    expect(provider.embeds).toHaveLength(1);
    expect(vectorStore.insert).not.toHaveBeenCalled();
  });
});

describe('OpenAI adapter embed signal', () => {
  /** A provider that takes the request and never answers until its fetch is aborted. */
  function hangingFetch() {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it("aborts the embedding fetch when the caller aborts, rethrowing the caller's reason", async () => {
    hangingFetch();
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', baseUrl: 'http://openai.invalid/v1' });
    const caller = new AbortController();
    const reason = new Error('caller went away');
    setTimeout(() => caller.abort(reason), 20);

    const startedAt = Date.now();
    const error = await adapter
      .embed({ texts: ['a'], timeout: 10_000, signal: caller.signal })
      .catch((e: unknown) => e);

    expect(error).toBe(reason);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('ends ctx.ai.retrieve through the OpenAI adapter when the caller aborts', async () => {
    const fetchMock = hangingFetch();
    const adapter = createOpenAIAdapter({ apiKey: 'sk-test', baseUrl: 'http://openai.invalid/v1' });
    const ai = createAIService({
      providers: { openai: adapter },
      defaultProvider: 'openai',
      ragPipeline: createRAGPipeline({
        provider: adapter,
        vectorStore: createInMemoryVectorStore(),
      }),
    });
    const caller = new AbortController();
    const reason = new Error('caller went away');
    setTimeout(() => caller.abort(reason), 20);

    await expect(
      ai.retrieve({ query: 'q', signal: caller.signal, timeoutMs: 10_000 }),
    ).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
