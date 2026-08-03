import { ErrorCode, PlumbusError } from '@plumbus/core';
import type { VoiceDefinition } from '../types/voice.js';
import { VOICE_ADDON_PACKAGES } from './addons.js';
import type {
  STTProviderRegistration,
  TTSProviderRegistration,
  TransportProviderRegistration,
} from './base/provider-registration.js';
import { createProviderRegistry, type VoiceProviderRegistry } from './registry.js';

const BUILTIN_STT = new Set(['openai-whisper', 'openai-realtime', 'web-speech']);
const BUILTIN_TTS = new Set(['openai', 'browser-tts']);
const BUILTIN_TRANSPORT = new Set(['websocket']);

function isRegistrationLike(value: unknown): value is { descriptor: unknown; create: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'descriptor' in value &&
    'create' in value &&
    typeof (value as { create: unknown }).create === 'function'
  );
}

async function importRegistration(
  providerId: string,
): Promise<
  | { kind: 'stt'; registration: STTProviderRegistration }
  | { kind: 'tts'; registration: TTSProviderRegistration }
  | { kind: 'transport'; registration: TransportProviderRegistration }
> {
  const spec = VOICE_ADDON_PACKAGES[providerId as keyof typeof VOICE_ADDON_PACKAGES];
  if (!spec) {
    throw new PlumbusError(
      ErrorCode.NotFound,
      `Voice provider "${providerId}" is not a known add-on and is not a builtin`,
      { providerId },
    );
  }

  try {
    const pkg: string = spec.pkg;
    const mod = (await import(pkg)) as Record<string, unknown>;
    const registration = mod[spec.exportName];
    if (!isRegistrationLike(registration)) {
      throw new PlumbusError(
        ErrorCode.DependencyViolation,
        `${spec.pkg} does not export ${spec.exportName}`,
        { installPackage: spec.pkg, providerId },
      );
    }
    if (spec.kind === 'stt') {
      return { kind: 'stt', registration: registration as STTProviderRegistration };
    }
    if (spec.kind === 'tts') {
      return { kind: 'tts', registration: registration as TTSProviderRegistration };
    }
    return { kind: 'transport', registration: registration as TransportProviderRegistration };
  } catch (error) {
    if (error instanceof PlumbusError) {
      throw error;
    }
    throw new PlumbusError(
      ErrorCode.NotFound,
      `Voice provider "${providerId}" requires ${spec.pkg}. Run: pnpm add ${spec.pkg}`,
      { installPackage: spec.pkg, providerId, cause: String(error) },
    );
  }
}

/**
 * Builds a registry for the provider ids referenced by `voices`.
 * Referenced add-on packages must be installed — missing packages throw
 * (no silent skip). Pass the result to `registerVoiceRoutes` / workers.
 */
export async function createRegistryForVoices(
  voices: readonly VoiceDefinition[],
): Promise<VoiceProviderRegistry> {
  const sttIds = new Set<string>();
  const ttsIds = new Set<string>();
  const transportIds = new Set<string>();

  for (const voice of voices) {
    sttIds.add(voice.stt.provider);
    ttsIds.add(voice.tts.provider);
    transportIds.add(voice.transport.provider);
  }

  const stt: Record<string, STTProviderRegistration> = {};
  const tts: Record<string, TTSProviderRegistration> = {};
  const transport: Record<string, TransportProviderRegistration> = {};

  for (const id of transportIds) {
    if (BUILTIN_TRANSPORT.has(id)) continue;
    const loaded = await importRegistration(id);
    if (loaded.kind !== 'transport') {
      throw new PlumbusError(
        ErrorCode.Validation,
        `Provider "${id}" is not a transport registration`,
        { providerId: id },
      );
    }
    transport[id] = loaded.registration;
  }

  for (const id of sttIds) {
    if (BUILTIN_STT.has(id)) continue;
    const loaded = await importRegistration(id);
    if (loaded.kind !== 'stt') {
      throw new PlumbusError(ErrorCode.Validation, `Provider "${id}" is not an STT registration`, {
        providerId: id,
      });
    }
    stt[id] = loaded.registration;
  }

  for (const id of ttsIds) {
    if (BUILTIN_TTS.has(id)) continue;
    const loaded = await importRegistration(id);
    if (loaded.kind !== 'tts') {
      throw new PlumbusError(ErrorCode.Validation, `Provider "${id}" is not a TTS registration`, {
        providerId: id,
      });
    }
    tts[id] = loaded.registration;
  }

  return createProviderRegistry({ stt, tts, transport });
}
