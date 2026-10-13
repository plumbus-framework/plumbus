import { ErrorCode, PlumbusError } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import type { FileTranscriptionContext, RecordFileTranscriptionCostInput } from './types.js';

const quantity = z.number().finite().nonnegative();
const measuredUsage = z.object({
  state: z.literal('known'),
  audioSeconds: quantity,
  inputAudioTokens: quantity.int().safe(),
  inputTextTokens: quantity.int().safe(),
  outputTextTokens: quantity.int().safe(),
  costUsd: quantity.nullable(),
});
const rates = z.object({
  inputAudioUsdPerMillion: quantity,
  inputTextUsdPerMillion: quantity,
  outputTextUsdPerMillion: quantity,
});

/** Preserves actual token totals and media duration through the invoking ctx's AI ledger. */
export async function recordFileTranscriptionCost(
  ctx: Pick<FileTranscriptionContext, 'ai'>,
  input: RecordFileTranscriptionCostInput,
) {
  const usage = input.usage.state === 'known' ? measuredUsage.safeParse(input.usage) : undefined;
  const pricing = input.pricing === undefined ? undefined : rates.safeParse(input.pricing);
  if (
    (usage && !usage.success) ||
    (pricing && !pricing.success) ||
    !quantity.safeParse(input.latencyMs).success
  ) {
    throw new PlumbusError(
      ErrorCode.Validation,
      'Invalid measured file transcription usage or pricing',
    );
  }
  const measured = usage?.success ? usage.data : undefined;
  const price = pricing?.success ? pricing.data : undefined;
  const cost =
    measured?.costUsd ??
    (measured && price
      ? (measured.inputAudioTokens * price.inputAudioUsdPerMillion +
          measured.inputTextTokens * price.inputTextUsdPerMillion +
          measured.outputTextTokens * price.outputTextUsdPerMillion) /
        1000000
      : null);
  const inputTokens = measured ? measured.inputAudioTokens + measured.inputTextTokens : 0;
  const outputTokens = measured?.outputTextTokens ?? 0;
  if (
    !quantity.nullable().safeParse(cost).success ||
    !quantity
      .int()
      .safe()
      .safeParse(inputTokens + outputTokens).success
  ) {
    throw new PlumbusError(ErrorCode.Validation, 'File transcription cost or usage overflow');
  }
  await ctx.ai.recordProviderCost(
    {
      model: input.model,
      provider: input.provider,
      operation: 'transcribe',
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      mediaUsage: measured ? { audioInputSeconds: measured.audioSeconds } : undefined,
      cost,
      latencyMs: input.latencyMs,
      status: input.status ?? (measured ? 'success' : 'incomplete'),
    },
    input.costContext,
  );
  return { cost, pricingKnown: cost !== null, usage: input.usage };
}
