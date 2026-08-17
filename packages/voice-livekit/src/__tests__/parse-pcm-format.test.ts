import { describe, expect, it } from 'vitest';
import { parsePcmFormat } from '../runtime/livekit-agent-worker.js';

describe('parsePcmFormat', () => {
  it('parses wire-form specs', () => {
    expect(parsePcmFormat('pcm16;rate=48000;channels=2')).toEqual({
      sampleRate: 48000,
      channels: 2,
    });
  });

  it('parses short-form specs instead of silently defaulting to 16 kHz', () => {
    expect(parsePcmFormat('pcm16-16k')).toEqual({ sampleRate: 16000, channels: 1 });
    expect(parsePcmFormat('pcm16-24k')).toEqual({ sampleRate: 24000, channels: 1 });
    expect(parsePcmFormat('pcm16-48k')).toEqual({ sampleRate: 48000, channels: 1 });
  });

  it('defaults to 16 kHz mono when unset', () => {
    expect(parsePcmFormat(undefined)).toEqual({ sampleRate: 16000, channels: 1 });
  });
});
