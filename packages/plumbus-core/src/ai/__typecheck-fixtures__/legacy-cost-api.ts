import {
  calculateModelCost,
  estimateModelCost,
  runToolLoop,
  type AIService,
  type RAGPipelineConfig,
  type RunToolLoopParams,
} from '@plumbus/core';

export async function legacyConsumer(ai: AIService, params: RunToolLoopParams): Promise<number> {
  const result = await ai.generateWithUsage({ prompt: 'p', input: {} });
  const cost: number = result.cost;
  const loop = await runToolLoop(ai, params);
  const total: number = loop.aggregatedCost;
  return cost + total + calculateModelCost(1, 1, 'local');
}

export const legacyEmbeddingCallback: RAGPipelineConfig['onEmbeddingCost'] = (info) => {
  const numericCost: number = info.cost;
  void numericCost;
};

// @ts-expect-error Unknown-aware estimates cannot be treated as definitely priced.
export const uncheckedEstimate: number = estimateModelCost(1, 1, 'local');
