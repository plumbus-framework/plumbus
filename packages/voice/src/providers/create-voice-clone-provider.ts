import { ErrorCode, PlumbusError } from '@plumbus/core';
import type {
  SynthesizeWithVoiceReferenceInput,
  VoiceCloneCapabilities,
  VoiceCloneProvider,
} from '../types/clone.js';
import type { VoiceProvidersConfig } from '../types/provider.js';
import type { VoiceProviderRegistry } from './registry.js';

export interface CreateVoiceCloneProviderArgs {
  providerId: string;
  providers: VoiceProvidersConfig;
  registry: VoiceProviderRegistry;
}

export function supportsVoiceCloning(registry: VoiceProviderRegistry, providerId: string): boolean {
  return registry.tts.get(providerId)?.clone !== undefined;
}

export function getVoiceCloneCapabilities(
  registry: VoiceProviderRegistry,
  providerId: string,
): VoiceCloneCapabilities | undefined {
  return registry.tts.get(providerId)?.clone?.capabilities;
}

export function createVoiceCloneProvider(args: CreateVoiceCloneProviderArgs): VoiceCloneProvider {
  const registration = args.registry.tts.get(args.providerId);
  if (!registration) {
    throw new PlumbusError(
      ErrorCode.NotFound,
      `Voice tts provider "${args.providerId}" is not registered — pass its *_REGISTRATION to createProviderRegistry()`,
      { providerId: args.providerId, kind: 'tts' },
    );
  }
  if (!registration.clone) {
    throw new PlumbusError(
      ErrorCode.Validation,
      `Voice tts provider "${args.providerId}" does not support voice cloning`,
      { providerId: args.providerId },
    );
  }
  const credentials = args.providers.providers[args.providerId] ?? {};
  return registration.clone.create(credentials);
}

export async function synthesizeWithVoiceReference(args: {
  providerId: string;
  providers: VoiceProvidersConfig;
  registry: VoiceProviderRegistry;
  input: SynthesizeWithVoiceReferenceInput;
}): Promise<Uint8Array> {
  const registration = args.registry.tts.get(args.providerId);
  if (!registration) {
    throw new PlumbusError(
      ErrorCode.NotFound,
      `Voice tts provider "${args.providerId}" is not registered — pass its *_REGISTRATION to createProviderRegistry()`,
      { providerId: args.providerId, kind: 'tts' },
    );
  }
  if (!registration.clone?.synthesizeWithVoiceReference) {
    throw new PlumbusError(
      ErrorCode.Validation,
      `Voice tts provider "${args.providerId}" does not support instant voice-reference synthesis`,
      { providerId: args.providerId },
    );
  }
  const credentials = args.providers.providers[args.providerId] ?? {};
  return registration.clone.synthesizeWithVoiceReference(credentials, args.input);
}

/** Enforce sample size against provider capability (and optional route override). */
export function assertCloneSampleWithinLimit(
  audio: Uint8Array | Buffer,
  capabilities: VoiceCloneCapabilities,
  maxSampleBytesOverride?: number,
): void {
  const limit = Math.min(
    maxSampleBytesOverride ?? Number.POSITIVE_INFINITY,
    capabilities.maxSampleBytes,
  );
  if (audio.byteLength > limit) {
    throw new PlumbusError(
      ErrorCode.Validation,
      `Voice clone sample exceeds maxSampleBytes (${limit})`,
      { byteLength: audio.byteLength, maxSampleBytes: limit },
    );
  }
}
