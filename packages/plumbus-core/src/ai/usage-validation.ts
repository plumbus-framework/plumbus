// Validate provider accounting before it can affect prices or budget totals.
import { z } from 'zod';
import { createErrorService } from '../errors/index.js';
import type { TokenUsage } from './provider.js';

const amount = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const usageSchema = z.object({
  inputTokens: amount,
  outputTokens: amount,
  totalTokens: amount,
  cachedInputTokens: amount.optional(),
  cacheWriteTokens: amount.optional(),
});

export function validateTokenUsage(usage: TokenUsage): TokenUsage {
  const parsed = usageSchema.safeParse(usage);
  if (!parsed.success) throw createErrorService().validation('Invalid provider token usage');
  // Also supports the standalone declaration emitter without strictNullChecks.
  return parsed.data as TokenUsage;
}

export function normalizeCost(cost: unknown): number | null {
  const parsed = amount.safeParse(cost);
  return parsed.success ? parsed.data : null;
}
