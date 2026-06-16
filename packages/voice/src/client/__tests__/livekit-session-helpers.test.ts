import { describe, expect, it } from 'vitest';
import type { VoiceEvent } from '../../types/event.js';
import {
  CLIENT_AGENT_AUDIO_FORMAT,
  coerceVoiceEvent,
  float32SamplesToPcm16,
  isAgentAudioPublication,
  normalizeBrowserCapturedPcm16,
  parseLiveKitVoiceDataPayload,
  resolveAgentAudioTrackName,
} from '../livekit-session-helpers.js';

describe('livekit session helpers', () => {
  it('resolves agent audio track name from token metadata', () => {
    expect(resolveAgentAudioTrackName({ agentAudioTrackName: 'custom-voice' })).toBe('custom-voice');
    expect(resolveAgentAudioTrackName({ audioTrackName: 'legacy-voice' })).toBe('legacy-voice');
    expect(resolveAgentAudioTrackName({})).toBe('dvora-voice');
  });

  it('matches agent audio publications by track name', () => {
    expect(isAgentAudioPublication({ trackName: 'dvora-voice' }, 'dvora-voice')).toBe(true);
    expect(isAgentAudioPublication({ trackName: 'mic' }, 'dvora-voice')).toBe(false);
  });

  it('parses LiveKit data payloads and coerces known voice events', () => {
    const payload = new TextEncoder().encode(
      JSON.stringify({ type: 'agent.state', state: 'Listening' }),
    );
    const parsed = parseLiveKitVoiceDataPayload(payload);
    expect(coerceVoiceEvent(parsed)).toEqual({
      type: 'agent.state',
      state: 'Listening',
    } satisfies VoiceEvent);
  });

  it('returns structured error events for malformed data payloads', () => {
    const parsed = parseLiveKitVoiceDataPayload(new Uint8Array([0xff, 0xfe]));
    expect(coerceVoiceEvent(parsed)).toEqual({
      type: 'error',
      code: 'voice.invalid_message',
      message: 'Expected JSON control frame',
    });
  });

  it('passes through unknown control frames without coercion', () => {
    const parsed = { type: 'custom.debug', value: 1 };
    expect(coerceVoiceEvent(parsed)).toEqual(parsed);
  });

  it('converts float32 samples to little-endian pcm16 bytes', () => {
    const pcm = float32SamplesToPcm16(new Float32Array([0, 1, -1]));
    expect(pcm).toEqual(
      Uint8Array.from([
        0x00, 0x00,
        0xff, 0x7f,
        0x00, 0x80,
      ]),
    );
  });

  it('resamples browser-captured pcm16 to 16kHz mono transport format', () => {
    const samples = new Float32Array(480);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = Math.sin((index / 480) * Math.PI * 2);
    }

    const pcm16k = normalizeBrowserCapturedPcm16(samples, 48_000);
    expect(CLIENT_AGENT_AUDIO_FORMAT.sampleRate).toBe(16_000);
    expect(pcm16k.byteLength).toBeGreaterThan(0);
    expect(pcm16k.byteLength % 2).toBe(0);
    expect(pcm16k.byteLength).toBeLessThan(samples.length * 2);
  });
});
