import type { ExecutionContext } from '@plumbus/core';
import { calculateVoiceCost, lookupVoicePricing } from './voice-pricing.js';
import type { RecordVoiceCostInput } from '../types/cost.js';

export interface RecordVoiceCostResult {
  cost: number | null;
  pricingKnown: boolean;
}

export async function recordVoiceCost(
  ctx: Pick<ExecutionContext, 'ai'>,
  input: RecordVoiceCostInput,
): Promise<RecordVoiceCostResult> {
  const pricing = lookupVoicePricing(input.model);
  const cost = pricing ? calculateVoiceCost(input.model, input.mediaUsage) : null;

  await ctx.ai.recordProviderCost(
    {
      model: input.model,
      provider: input.provider,
      operation: input.operation,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      mediaUsage: { ...input.mediaUsage },
      cost,
      latencyMs: input.latencyMs,
      status: input.status,
      errorMessage: input.errorMessage,
    },
    input.costContext,
  );

  return {
    cost,
    pricingKnown: pricing !== undefined,
  };
}
