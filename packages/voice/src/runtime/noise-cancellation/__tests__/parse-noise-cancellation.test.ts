import { describe, expect, it } from 'vitest';
import { PlumbusError } from '@plumbus/core';
import {
  parseNoiseCancellation,
  readNoiseCancellationFromTransportOptions,
  serializeNoiseCancellation,
} from '../parse-noise-cancellation.js';

describe('parseNoiseCancellation', () => {
  it('defaults to off when config is missing', () => {
    expect(parseNoiseCancellation(undefined)).toEqual({
      placement: 'off',
      engine: 'none',
      model: null,
      dtlnModelDir: undefined,
      active: false,
    });
  });

  it('parses client Krisp BVC', () => {
    expect(
      parseNoiseCancellation({
        placement: 'client',
        engine: 'krisp',
        model: 'bvc',
      }),
    ).toMatchObject({
      placement: 'client',
      engine: 'krisp',
      model: 'bvc',
      active: true,
    });
  });

  it('parses agent Krisp standard with defaults', () => {
    expect(
      parseNoiseCancellation({
        placement: 'agent',
        model: 'standard',
      }),
    ).toMatchObject({
      placement: 'agent',
      engine: 'krisp',
      model: 'standard',
      active: true,
    });
  });

  it('rejects dtln on client placement', () => {
    expect(() =>
      parseNoiseCancellation({
        placement: 'client',
        engine: 'dtln',
      }),
    ).toThrow(PlumbusError);
  });

  it('reads config from transport options', () => {
    const resolved = readNoiseCancellationFromTransportOptions({
      agentAudioTrackName: 'dvora-voice',
      noiseCancellation: {
        placement: 'client',
        engine: 'krisp',
        model: 'bvc',
      },
    });
    expect(resolved.active).toBe(true);
    expect(resolved.placement).toBe('client');
  });

  it('serializes resolved config for token responses', () => {
    const resolved = parseNoiseCancellation({
      placement: 'agent',
      engine: 'rnnoise',
      model: 'lite',
    });
    expect(serializeNoiseCancellation(resolved)).toEqual({
      placement: 'agent',
      engine: 'rnnoise',
      model: 'lite',
    });
  });
});
