import type { ExecutionContext } from '@plumbus/core';
import type { RecordVoiceCostInput } from '../types/cost.js';
import { calculateVoiceCost, lookupVoicePricing } from './voice-pricing.js';

export interface RecordVoiceCostResult {
  cost: number | null;
  pricingKnown: boolean;
}

export async function recordVoiceCost(
  ctx: Pick<ExecutionContext, 'ai'>,
  input: RecordVoiceCostInput,
): Promise<RecordVoiceCostResult> {
  const pricing = lookupVoicePricing(input.model);
  const cost =
    input.cost !== undefined
      ? input.cost
      : pricing
        ? calculateVoiceCost(input.model, input.mediaUsage)
        : null;

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
    pricingKnown: input.cost !== undefined || pricing !== undefined,
  };
}
