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
    });
  });
});
