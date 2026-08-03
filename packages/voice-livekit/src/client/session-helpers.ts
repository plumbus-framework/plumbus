import type { VoiceEvent } from '@plumbus/voice/provider-kit';
import { resamplePcm16 } from './pcm-resample.js';

export const CLIENT_AGENT_AUDIO_FORMAT = {
  sampleRate: 16_000,
  channels: 1,
  format: 'pcm16' as const,
};

export const DEFAULT_AGENT_AUDIO_TRACK_NAME = 'agent-voice';

const VOICE_EVENT_TYPES = new Set<VoiceEvent['type']>([
  'session.hello',
  'session.ready',
  'stt.partial',
  'stt.final',
  'agent.state',
  'agent.tone',
  'assistant.delta',
  'tts.speak',
  'turn.started',
  'turn.completed',
  'turn.interrupted',
  'turn.failed',
  'error',
]);

export function resolveAgentAudioTrackName(metadata: {
  agentAudioTrackName?: string;
  audioTrackName?: string;
}): string {
  const configured = metadata.agentAudioTrackName ?? metadata.audioTrackName;
  return typeof configured === 'string' && configured.length > 0
    ? configured
    : DEFAULT_AGENT_AUDIO_TRACK_NAME;
}

export function parseLiveKitVoiceDataPayload(payload: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(payload)) as unknown;
  } catch {
    return {
      type: 'error',
      code: 'voice.invalid_message',
      message: 'Expected JSON control frame',
    } satisfies VoiceEvent;
  }
}

export function coerceVoiceEvent(value: unknown): VoiceEvent | Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return { type: 'error', code: 'voice.invalid_message', message: 'Expected JSON object' };
  }

  const type = (value as { type?: unknown }).type;
  if (typeof type === 'string' && VOICE_EVENT_TYPES.has(type as VoiceEvent['type'])) {
    return value as VoiceEvent;
  }

  return value as Record<string, unknown>;
}

export function float32SamplesToPcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return bytes;
}

export function normalizeBrowserCapturedPcm16(
  samples: Float32Array,
  sampleRate: number,
): Uint8Array {
  const pcmAtSourceRate = float32SamplesToPcm16(samples);
  if (sampleRate === CLIENT_AGENT_AUDIO_FORMAT.sampleRate) {
    return pcmAtSourceRate;
  }
  return resamplePcm16(pcmAtSourceRate, { sampleRate, channels: 1 }, CLIENT_AGENT_AUDIO_FORMAT);
}

export function isAgentAudioPublication(
  publication: { trackName?: string },
  agentTrackName: string,
): boolean {
  return publication.trackName === agentTrackName;
}
