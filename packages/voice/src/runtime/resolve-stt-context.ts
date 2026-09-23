import { ErrorCode, PlumbusError, type ExecutionContext } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import type {
  VoiceDefinition,
  VoiceRecognitionContext,
  VoiceResolveSttContextArgs,
} from '../types/voice.js';

const contextSchema = z
  .object({
    general: z
      .array(z.object({ key: z.string().min(1).max(80), value: z.string().min(1).max(500) }))
      .max(10)
      .optional(),
    terms: z.array(z.string().min(1).max(160)).max(100).optional(),
    text: z.string().max(4000).optional(),
  })
  .strict()
  .refine(
    (value) => JSON.stringify(value).length <= 8000,
    'Recognition context must fit within 8000 characters',
  );

export async function resolveSttContext(
  ctx: ExecutionContext,
  voice: VoiceDefinition,
  args: VoiceResolveSttContextArgs,
): Promise<VoiceRecognitionContext | undefined> {
  const value = await voice.resolveSttContext?.(ctx, args);
  if (value === undefined) return undefined;
  const parsed = contextSchema.safeParse(value);
  if (!parsed.success)
    throw new PlumbusError(
      ErrorCode.Validation,
      'Invalid recognition context returned by resolveSttContext',
    );
  return parsed.data;
}
