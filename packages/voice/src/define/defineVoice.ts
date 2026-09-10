import { z } from '@plumbus/core/zod';
import { deepFreeze } from '../internal/deep-freeze.js';
import { throwDefineValidationError } from '../internal/validation-error.js';
import type {
  DeliveryTone,
  ToneProfileId,
  VoiceBrain,
  VoiceConfig,
  VoiceDefinition,
} from '../types/voice.js';

const deliveryToneSchema = z.object({
  profile: z.string().min(1).optional(),
  pace: z.enum(['slow', 'normal', 'fast']).optional(),
  warmth: z.enum(['low', 'medium', 'high']).optional(),
  energy: z.enum(['low', 'medium', 'high']).optional(),
  emotion: z.string().min(1).optional(),
});

const voiceConfigSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  access: z.record(z.unknown()),
  transport: z.object({
    provider: z.string().min(1),
    mode: z.string().optional(),
    audioFormat: z.string().optional(),
    options: z.record(z.unknown()).optional(),
  }),
  stt: z.object({
    provider: z.string().min(1),
    model: z.string().optional(),
    languages: z.array(z.string().min(1)).optional(),
    options: z.record(z.unknown()).optional(),
  }),
  tts: z.object({
    provider: z.string().min(1),
    model: z.string().optional(),
    voiceId: z.string().optional(),
    locale: z.string().optional(),
    options: z.record(z.unknown()).optional(),
  }),
  brain: z.custom<VoiceBrain>(
    (value: unknown) =>
      typeof value === 'object' &&
      value !== null &&
      'run' in value &&
      typeof value.run === 'function',
    {
      message: 'brain.run must be a function',
    },
  ),
  instructions: z.array(z.string()).optional(),
  toneProfiles: z.record(deliveryToneSchema).optional(),
  resolveTone: z
    .custom((value: unknown) => value === undefined || typeof value === 'function', {
      message: 'resolveTone must be a function',
    })
    .optional(),
  onHearingRepair: z
    .custom((value: unknown) => value === undefined || typeof value === 'function', {
      message: 'onHearingRepair must be a function',
    })
    .optional(),
  preprocessForTts: z
    .custom((value: unknown) => value === undefined || typeof value === 'function', {
      message: 'preprocessForTts must be a function',
    })
    .optional(),
});

export function defineVoice(config: VoiceConfig): VoiceDefinition {
  const parsed = voiceConfigSchema.safeParse(config);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map(
        (issue: { path: Array<string | number>; message: string }) =>
          `${issue.path.join('.')}: ${issue.message}`,
      )
      .join('; ');
    throwDefineValidationError(`defineVoice: ${detail}`);
  }

  const toneProfiles = normalizeToneProfiles(config.toneProfiles);

  return deepFreeze({
    ...config,
    instructions: config.instructions ?? [],
    toneProfiles,
    kind: 'voice' as const,
  });
}

function normalizeToneProfiles(
  toneProfiles: Record<ToneProfileId, DeliveryTone> | undefined,
): Record<ToneProfileId, DeliveryTone> {
  if (!toneProfiles) return {};
  const normalizedEntries = Object.entries(toneProfiles).map(([profileId, tone]) => [
    profileId,
    {
      ...tone,
      profile: tone.profile ?? profileId,
    },
  ]);
  return Object.fromEntries(normalizedEntries);
}
