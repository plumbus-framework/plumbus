import { PlumbusError, ErrorCode } from '@plumbus/core';
import type { VoiceProviderCredentials, VoiceProvidersConfig } from '../types/provider.js';
import type { VoiceSttConfig, VoiceTransportConfig, VoiceTtsConfig } from '../types/voice.js';
import type { VoiceProviderRegistry } from './registry.js';
import type { STTProvider } from './base/stt-provider.js';
import type { TTSProvider } from './base/tts-provider.js';
import type { TransportProvider } from './base/transport-provider.js';

export interface VoiceFactoryArgs {
  registry: VoiceProviderRegistry;
  providers?: VoiceProvidersConfig;
  credentials?: VoiceProviderCredentials;
}

export interface CreateSTTProviderArgs extends VoiceFactoryArgs {
  voiceSlice: VoiceSttConfig;
}

export interface CreateTTSProviderArgs extends VoiceFactoryArgs {
  voiceSlice: VoiceTtsConfig;
}

export interface CreateTransportProviderArgs extends VoiceFactoryArgs {
  voiceSlice: VoiceTransportConfig;
}

export function createSTTProvider(args: CreateSTTProviderArgs): STTProvider {
  const registration = resolveRegisteredProvider(
    args.registry.stt,
    args.voiceSlice.provider,
    'stt',
  );
  return registration.create(
    resolveProviderCredentials(args, args.voiceSlice.provider),
    args.voiceSlice,
  );
}

export function createTTSProvider(args: CreateTTSProviderArgs): TTSProvider {
  const registration = resolveRegisteredProvider(
    args.registry.tts,
    args.voiceSlice.provider,
    'tts',
  );
  return registration.create(
    resolveProviderCredentials(args, args.voiceSlice.provider),
    args.voiceSlice,
  );
}

export function createTransportProvider(args: CreateTransportProviderArgs): TransportProvider {
  const registration = resolveRegisteredProvider(
    args.registry.transport,
    args.voiceSlice.provider,
    'transport',
  );
  return registration.create(
    resolveProviderCredentials(args, args.voiceSlice.provider),
    args.voiceSlice,
  );
}

function resolveRegisteredProvider<T>(
  providers: ReadonlyMap<string, T>,
  providerId: string,
  kind: 'stt' | 'tts' | 'transport',
): T {
  const provider = providers.get(providerId);
  if (!provider) {
    throw new PlumbusError(
      ErrorCode.NotFound,
      `Voice ${kind} provider "${providerId}" is not registered — pass its *_REGISTRATION to createProviderRegistry()`,
      { providerId, kind },
    );
  }
  return provider;
}

function resolveProviderCredentials(
  args: VoiceFactoryArgs,
  providerId: string,
): VoiceProviderCredentials {
  return args.providers?.providers[providerId] ?? args.credentials ?? {};
}
