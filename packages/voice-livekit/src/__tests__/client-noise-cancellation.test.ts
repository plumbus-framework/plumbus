import { parseNoiseCancellation } from '@plumbus/voice/provider-kit';
import { describe, expect, it } from 'vitest';
import { micConstraintsForNoiseCancellation } from '../client/client-noise-cancellation.js';

describe('micConstraintsForNoiseCancellation', () => {
  it('keeps browser noiseSuppression false when client NC is active', () => {
    const config = parseNoiseCancellation({
      placement: 'client',
      engine: 'krisp',
      model: 'bvc',
    });
    expect(micConstraintsForNoiseCancellation(config)).toEqual({
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: true,
      voiceIsolation: false,
    });
  });

  it('re-enables browser noiseSuppression when no client NC is configured, voiceIsolation stays off', () => {
    const config = parseNoiseCancellation(undefined);
    expect(micConstraintsForNoiseCancellation(config)).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      // livekit-client defaults voiceIsolation true — a hidden enhancement
      // stage in front of STT input. Exactly zero or one stage, explicitly.
      voiceIsolation: false,
    });
  });
});
