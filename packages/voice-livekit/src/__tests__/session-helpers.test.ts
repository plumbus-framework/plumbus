import { describe, expect, it } from 'vitest';
import {
  CLIENT_AGENT_AUDIO_FORMAT,
  coerceVoiceEvent,
  float32SamplesToPcm16,
  isAgentAudioPublication,
  normalizeBrowserCapturedPcm16,
  parseLiveKitVoiceDataPayload,
  resolveAgentAudioTrackName,
} from '../client/session-helpers.js';

describe('LiveKit client session helpers', () => {
  it('parses JSON data payloads', () => {
    const payload = new TextEncoder().encode(JSON.stringify({ type: 'session.ready' }));
    const parsed = parseLiveKitVoiceDataPayload(payload);
    expect(parsed).toEqual({ type: 'session.ready' });
  });

  it('returns a voice error event for invalid JSON', () => {
    const parsed = parseLiveKitVoiceDataPayload(new Uint8Array([0xff, 0xfe]));
    expect(parsed).toMatchObject({
      type: 'error',
      code: 'voice.invalid_message',
    });
  });

  it('coerces known voice events and passes through opaque objects', () => {
    expect(coerceVoiceEvent({ type: 'stt.final', text: 'hi' })).toEqual({
      type: 'stt.final',
      text: 'hi',
    });
    expect(coerceVoiceEvent({ custom: true })).toEqual({ custom: true });
  });

  it('resolves agent track names with a default', () => {
    expect(resolveAgentAudioTrackName({})).toBe('agent-voice');
    expect(resolveAgentAudioTrackName({ agentAudioTrackName: 'agent-out' })).toBe('agent-out');
  });

  it('detects agent audio publications', () => {
    expect(isAgentAudioPublication({ trackName: 'agent-voice' }, 'agent-voice')).toBe(true);
    expect(isAgentAudioPublication({ trackName: 'mic' }, 'agent-voice')).toBe(false);
  });

  it('normalizes captured pcm16 to the client agent format', () => {
    const samples = new Float32Array([0, 0.5, -0.5]);
    const pcm = normalizeBrowserCapturedPcm16(samples, CLIENT_AGENT_AUDIO_FORMAT.sampleRate);
    expect(pcm.byteLength).toBe(samples.length * 2);
    expect(float32SamplesToPcm16(samples).byteLength).toBe(pcm.byteLength);
    expect(CLIENT_AGENT_AUDIO_FORMAT.sampleRate).toBe(16_000);
  });
});
