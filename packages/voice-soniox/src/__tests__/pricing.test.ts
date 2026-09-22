import { describe, expect, it } from 'vitest';
import { SONIOX_VOICE_PRICING } from '../pricing.js';

describe('Soniox voice pricing', () => {
  it('prices real-time STT at the vendor list rate of $0.12/hour', () => {
    // soniox.com/pricing (2026): $2.00 per 1M input audio tokens, which the
    // vendor equates to ~$0.12/hour for real-time streaming transcription.
    expect(SONIOX_VOICE_PRICING['soniox-stt']?.unit).toBe('audioInputSeconds');
    expect(SONIOX_VOICE_PRICING['soniox-stt']?.usdPerUnit).toBeCloseTo(0.12 / 3600, 8);
  });

  it('keeps TTS at the vendor-equivalent ~$0.70/hour of generated speech', () => {
    expect(SONIOX_VOICE_PRICING['soniox-tts']?.unit).toBe('characters');
    expect(SONIOX_VOICE_PRICING['soniox-tts']?.usdPerUnit).toBeCloseTo(0.000014, 8);
  });
});
