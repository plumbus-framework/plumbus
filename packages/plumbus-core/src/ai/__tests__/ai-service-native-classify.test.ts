import { describe, expect, it, vi } from 'vitest';
import { createAIService } from '../ai-service.js';
import type { AICostRecord, AICostRecordInput } from '../cost-tracker.js';
import { createCostTracker } from '../cost-tracker.js';
import { createExplainabilityTracker } from '../explainability.js';
import type { AIProviderAdapter } from '../provider.js';
import { createMockProvider } from './provider.test.js';

/** A provider that answers `classify` natively rather than through `complete`. */
function createNativeClassifyProvider(
  labels: string[],
  overrides?: Partial<AIProviderAdapter>,
): AIProviderAdapter {
  return createMockProvider({
    name: 'native',
    capabilities: {
      tools: false,
      streamingTools: false,
      parallelToolCalls: false,
      parallelToolCallControl: false,
      namedToolChoice: false,
      nativeClassify: true,
    },
    classify: vi.fn(async () => ({
      labels,
      usage: { inputTokens: 40, outputTokens: 0, totalTokens: 40 },
      cost: 0.5,
    })),
    ...overrides,
  });
}

function setup(provider: AIProviderAdapter) {
  const records: AICostRecordInput[] = [];
  const costTracker = {
    ...createCostTracker(),
    record(entry: AICostRecordInput) {
      records.push(entry);
      return entry as AICostRecord;
    },
  };
  const explainability = createExplainabilityTracker();
  const service = createAIService({
    providers: { [provider.name]: provider },
    defaultProvider: provider.name,
    costTracker,
    explainability,
  });
  return { service, records, explainability };
}

describe('ctx.ai.classify with a native adapter hook', () => {
  it('routes to the adapter hook instead of synthesizing a prompt', async () => {
    const provider = createNativeClassifyProvider(['billing']);
    const { service } = setup(provider);

    const result = await service.classify({
      labels: ['billing', 'sales'],
      text: 'I was charged twice',
    });

    expect(result).toEqual(['billing']);
    expect(provider.classify).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['billing', 'sales'], text: 'I was charged twice' }),
    );
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('keeps the prompt-based path for adapters without the hook', async () => {
    const provider = createMockProvider({
      complete: vi.fn(async () => ({
        content: '["billing"]',
        model: 'mock-model',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        finishReason: 'stop',
      })),
    });
    const { service } = setup(provider);

    await expect(service.classify({ labels: ['billing'], text: 'x' })).resolves.toEqual([
      'billing',
    ]);
    expect(provider.complete).toHaveBeenCalledOnce();
  });

  it('ignores the hook when the adapter does not declare nativeClassify', async () => {
    const provider = createMockProvider({
      capabilities: {
        tools: false,
        streamingTools: false,
        parallelToolCalls: false,
        parallelToolCallControl: false,
        namedToolChoice: false,
      },
      classify: vi.fn(async () => ({
        labels: ['billing'],
        usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
      })),
      complete: vi.fn(async () => ({
        content: '["billing"]',
        model: 'mock-model',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        finishReason: 'stop',
      })),
    });
    const { service } = setup(provider);

    await service.classify({ labels: ['billing'], text: 'x' });

    expect(provider.classify).not.toHaveBeenCalled();
    expect(provider.complete).toHaveBeenCalledOnce();
  });

  it('never returns a label the caller did not ask for', async () => {
    const provider = createNativeClassifyProvider(['billing', 'hallucinated']);
    const { service } = setup(provider);

    await expect(service.classify({ labels: ['billing'], text: 'x' })).resolves.toEqual([
      'billing',
    ]);
  });

  it('records cost and an explanation, same as the prompt path', async () => {
    const provider = createNativeClassifyProvider(['billing']);
    const { service, records, explainability } = setup(provider);

    await service.classify({ labels: ['billing', 'sales'], text: 'x' });

    expect(records[0]).toMatchObject({
      operation: 'classify',
      provider: 'native',
      status: 'success',
      cost: 0.5,
    });
    expect(explainability.getRecords()[0]).toMatchObject({
      operation: 'classify',
      provider: 'native',
      output: ['billing'],
    });
  });

  it('records a failed row and rethrows when the hook fails', async () => {
    const provider = createNativeClassifyProvider([], {
      classify: vi.fn(async () => {
        throw new Error('classify exploded');
      }),
    });
    const { service, records } = setup(provider);

    await expect(service.classify({ labels: ['billing'], text: 'x' })).rejects.toThrow(
      'classify exploded',
    );
    expect(records[0]).toMatchObject({
      operation: 'classify',
      status: 'failed',
      errorMessage: 'classify exploded',
    });
  });
});
