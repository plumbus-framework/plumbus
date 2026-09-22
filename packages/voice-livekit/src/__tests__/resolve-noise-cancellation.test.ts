import { parseNoiseCancellation } from '@plumbus/voice/provider-kit';
import { describe, expect, it, vi } from 'vitest';
import { resolveAgentNoiseCancellationOption } from '../noise-cancellation/resolve-noise-cancellation.js';

vi.mock('@livekit/noise-cancellation-node', () => ({
  NoiseCancellation: vi.fn(() => ({ moduleId: 'nc', options: {} })),
  BackgroundVoiceCancellation: vi.fn(() => ({ moduleId: 'bvc', options: {} })),
}));

describe('resolveAgentNoiseCancellationOption', () => {
  it('returns Krisp BVC option for agent placement', () => {
    const config = parseNoiseCancellation({
      placement: 'agent',
      engine: 'krisp',
      model: 'bvc',
    });
    const option = resolveAgentNoiseCancellationOption(config);
    expect(option).toBeDefined();
    expect(option).toMatchObject({
      moduleId: expect.any(String),
      options: expect.any(Object),
    });
  });

  it('returns undefined for client placement', () => {
    const config = parseNoiseCancellation({
      placement: 'client',
      engine: 'krisp',
      model: 'bvc',
    });
    expect(resolveAgentNoiseCancellationOption(config)).toBeUndefined();
  });

  it('returns RNNoise frame processor for agent rnnoise', () => {
    const config = parseNoiseCancellation({
      placement: 'agent',
      engine: 'rnnoise',
      model: 'standard',
    });
    const option = resolveAgentNoiseCancellationOption(config);
    expect(option).toBeDefined();
    expect(typeof (option as { process?: unknown }).process).toBe('function');
  });
});
