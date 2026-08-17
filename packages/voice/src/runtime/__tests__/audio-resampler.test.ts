import { describe, expect, it, vi } from 'vitest';
import { normalizeAudioFrame, resamplePcm16 } from '../audio-resampler.js';

describe('audio resampler', () => {
  it('resamples pcm16 mono audio from 16kHz to 24kHz', () => {
    const source = new Uint8Array(32);
    for (let index = 0; index < 16; index += 1) {
      const view = new DataView(source.buffer);
      view.setInt16(index * 2, index * 100, true);
    }

    const resampled = resamplePcm16(
      source,
      { sampleRate: 16_000, channels: 1 },
      { sampleRate: 24_000, channels: 1 },
    );

    expect(resampled.byteLength).toBeGreaterThan(source.byteLength);
  });

  it('normalizes frame metadata and audio bytes together', () => {
    const frame = normalizeAudioFrame(
      {
        data: Uint8Array.from([0, 0, 255, 127]),
        sampleRate: 16_000,
        channels: 1,
      },
      { sampleRate: 24_000, channels: 1 },
    );

    expect(frame.sampleRate).toBe(24_000);
    expect(frame.channels).toBe(1);
    expect(frame.data.byteLength).toBeGreaterThan(4);
  });

  it('warns loudly (once per rate pair) when the anti-alias-free resampler engages', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const frame = {
        data: Uint8Array.from([0, 0, 255, 127]),
        sampleRate: 44_100,
        channels: 1,
      };
      normalizeAudioFrame(frame, { sampleRate: 16_000, channels: 1 });
      normalizeAudioFrame(frame, { sampleRate: 16_000, channels: 1 });

      const resampleWarnings = warn.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('linear resampler engaged'),
      );
      expect(resampleWarnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});
