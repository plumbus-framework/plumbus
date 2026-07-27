#!/usr/bin/env node
/**
 * Offline voice quality harness — manual pre-release check, not CI-gated.
 *
 * Usage:
 *   pnpm tsx packages/voice/scripts/quality-harness.ts /path/to/input.wav
 *
 * Environment (preferred — matches plan default stack):
 *   SONIOX_API_KEY            Soniox STT (`@plumbus/voice-soniox` must be installed)
 *   DEEPDUB_API_KEY           Deepdub TTS (`@plumbus/voice-deepdub` must be installed)
 *   DEEPDUB_VOICE_ID          Deepdub voice id (required with DEEPDUB_API_KEY)
 *
 * Fallback when Soniox/Deepdub keys are absent:
 *   OPENAI_API_KEY            OpenAI Whisper STT + OpenAI TTS
 *
 * Mock fallback (no vendor keys):
 *   QUALITY_HARNESS_TRANSCRIPT  Mock STT transcript (default: "quality harness transcript")
 *
 * Writes `<input-basename>.out.wav` next to the input file.
 *
 * Note: the soniox-deepdub profile explicitly registers `@plumbus/voice-soniox`
 * and `@plumbus/voice-deepdub` — those packages must be present in node_modules.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createTestContext } from '../../plumbus-core/src/testing/context.js';
import { defineVoice } from '../src/define/defineVoice.js';
import { createProviderRegistry } from '../src/providers/registry.js';
import {
  createSTTProvider,
  createTTSProvider,
} from '../src/providers/factory.js';
import { createMockSTTProvider, createMockTransportProvider } from '../src/testing/mock-providers.js';
import { runVoiceTurn } from '../src/runtime/run-turn.js';
import type { TTSProvider } from '../src/providers/base/tts-provider.js';
import type {
  STTProviderRegistration,
  TTSProviderRegistration,
} from '../src/providers/base/provider-registration.js';

type HarnessProfile = 'soniox-deepdub' | 'openai' | 'mock';

async function loadSonioxDeepdubRegistrations(): Promise<{
  stt: Record<string, STTProviderRegistration>;
  tts: Record<string, TTSProviderRegistration>;
}> {
  const soniox = (await import('@plumbus/voice-soniox')) as {
    SONIOX_STT_REGISTRATION: STTProviderRegistration;
  };
  const deepdub = (await import('@plumbus/voice-deepdub')) as {
    DEEPDUB_TTS_REGISTRATION: TTSProviderRegistration;
  };
  return {
    stt: { soniox: soniox.SONIOX_STT_REGISTRATION },
    tts: { deepdub: deepdub.DEEPDUB_TTS_REGISTRATION },
  };
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error('Usage: quality-harness.ts <input.wav>');
  }

  const wav = readWavPcm(readFileSync(inputPath));
  const profile = resolveHarnessProfile();
  const mockTranscript = process.env.QUALITY_HARNESS_TRANSCRIPT ?? 'quality harness transcript';

  const addonRegs =
    profile === 'soniox-deepdub' ? await loadSonioxDeepdubRegistrations() : { stt: {}, tts: {} };
  const registry = createProviderRegistry(addonRegs);
  const providers = buildProvidersConfig(profile);

  let transcript = mockTranscript;
  if (profile !== 'mock') {
    const sttSlice =
      profile === 'soniox-deepdub'
        ? { provider: 'soniox' as const, model: 'stt-rt-preview' }
        : { provider: 'openai-whisper' as const, model: 'whisper-1' };

    const sttProvider = createSTTProvider({ registry, providers, voiceSlice: sttSlice });
    await sttProvider.connect?.({ sessionId: 'quality-harness' });
    await sttProvider.sendAudio?.({
      chunk: wav.pcm,
      contentType: `pcm16;rate=${wav.sampleRate};channels=${wav.channels}`,
    });
    const finalized = await sttProvider.finalize?.();
    transcript = finalized?.text?.trim() || mockTranscript;
    await sttProvider.disconnect?.();
    console.log(`quality harness STT (${profile}): ${transcript}`);
  }

  const ttsProvider = createHarnessTtsProvider(profile, registry, providers, wav);

  const voice = defineVoice({
    name: 'qualityHarness',
    access: {},
    transport: { provider: 'websocket' },
    stt: {
      provider:
        profile === 'soniox-deepdub' ? 'soniox' : profile === 'openai' ? 'openai-whisper' : 'mock-stt',
    },
    tts: {
      provider: profile === 'soniox-deepdub' ? 'deepdub' : profile === 'openai' ? 'openai' : 'mock-tts',
    },
    brain: {
      async run(_ctx, args) {
        const echoed = `echo: ${args.transcript ?? ''}`.trim();
        args.onAssistantDelta?.(echoed);
        return { text: echoed };
      },
    },
  });

  const ctx = createTestContext();
  const transportProvider = createMockTransportProvider();
  const sttProvider = createMockSTTProvider();
  const audioChunks: Uint8Array[] = [];

  for await (const event of runVoiceTurn(ctx, {
    voiceDefinition: voice,
    sessionId: 'quality-harness-session',
    transcript,
    sttProvider,
    ttsProvider,
    transportProvider,
    cleanupProviders: true,
    onAudioChunk: async (chunk) => {
      audioChunks.push(chunk);
    },
  })) {
    if (event.type === 'turn.failed') {
      throw new Error(event.message);
    }
  }

  const outputPath = join(dirname(inputPath), `${basename(inputPath, '.wav')}.out.wav`);
  const pcm = concatChunks(audioChunks);
  writeFileSync(outputPath, wrapPcm16AsWav(pcm, wav.sampleRate, wav.channels));
  console.log(`quality harness (${profile}) wrote ${outputPath}`);
}

function resolveHarnessProfile(): HarnessProfile {
  const sonioxKey = process.env.SONIOX_API_KEY;
  const deepdubKey = process.env.DEEPDUB_API_KEY;
  const deepdubVoiceId = process.env.DEEPDUB_VOICE_ID;

  if (sonioxKey && deepdubKey && deepdubVoiceId) {
    return 'soniox-deepdub';
  }

  if (sonioxKey && deepdubKey && !deepdubVoiceId) {
    throw new Error('DEEPDUB_VOICE_ID is required when SONIOX_API_KEY and DEEPDUB_API_KEY are set');
  }

  if (process.env.OPENAI_API_KEY) {
    return 'openai';
  }

  return 'mock';
}

function buildProvidersConfig(profile: HarnessProfile) {
  if (profile === 'soniox-deepdub') {
    return {
      providers: {
        soniox: { apiKey: process.env.SONIOX_API_KEY ?? '' },
        deepdub: { apiKey: process.env.DEEPDUB_API_KEY ?? '' },
      },
    };
  }

  if (profile === 'openai') {
    return {
      providers: {
        openai: { apiKey: process.env.OPENAI_API_KEY ?? '' },
      },
    };
  }

  return { providers: {} };
}

function createHarnessTtsProvider(
  profile: HarnessProfile,
  registry: ReturnType<typeof createProviderRegistry>,
  providers: ReturnType<typeof buildProvidersConfig>,
  wav: WavPcm,
): TTSProvider {
  if (profile === 'soniox-deepdub') {
    return createTTSProvider({
      registry,
      providers,
      voiceSlice: {
        provider: 'deepdub',
        model: 'phantom-x',
        voiceId: process.env.DEEPDUB_VOICE_ID,
        locale: 'he-IL',
      },
    });
  }

  if (profile === 'openai') {
    return createTTSProvider({
      registry,
      providers,
      voiceSlice: {
        provider: 'openai',
        model: 'tts-1',
        voiceId: 'alloy',
        options: { format: 'pcm' },
      },
    });
  }

  return {
    capabilities: {
      id: 'mock-tts',
      kind: 'tts',
      displayName: 'Mock TTS',
      credentialSchema: [],
      hosting: 'local',
      execution: 'server',
      streaming: true,
      toneSupport: 'none',
      deliveryAxes: [],
      deliveryMode: 'none',
      hebrewQuality: 'unknown',
      knownModels: [],
      voicesSource: 'static',
    },
    async *synthesizeStream() {
      yield generateSilencePcm(wav.sampleRate, wav.channels, 0.5);
    },
    mapDeliveryTone() {
      return {};
    },
    usage() {
      return [];
    },
  };
}

interface WavPcm {
  pcm: Uint8Array;
  sampleRate: number;
  channels: number;
}

function readWavPcm(bytes: Buffer): WavPcm {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Input must be a PCM WAV file');
  }

  let offset = 12;
  let sampleRate = 16_000;
  let channels = 1;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= bytes.length) {
    const chunkId = bytes.toString('ascii', offset, offset + 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === 'fmt ') {
      channels = bytes.readUInt16LE(chunkStart + 2);
      sampleRate = bytes.readUInt32LE(chunkStart + 4);
      bitsPerSample = bytes.readUInt16LE(chunkStart + 14);
    }
    if (chunkId === 'data') {
      dataOffset = chunkStart;
      dataSize = chunkSize;
      break;
    }
    offset = chunkStart + chunkSize;
  }

  if (dataOffset < 0 || bitsPerSample !== 16) {
    throw new Error('Only 16-bit PCM WAV inputs are supported');
  }

  return {
    pcm: bytes.subarray(dataOffset, dataOffset + dataSize),
    sampleRate,
    channels,
  };
}

function wrapPcm16AsWav(pcm: Uint8Array, sampleRate: number, channels: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
}

function generateSilencePcm(sampleRate: number, channels: number, seconds: number): Uint8Array {
  const samples = Math.max(1, Math.floor(sampleRate * seconds));
  return new Uint8Array(samples * channels * 2);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
