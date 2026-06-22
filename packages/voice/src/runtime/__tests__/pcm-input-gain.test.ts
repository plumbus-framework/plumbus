import { describe, expect, it } from 'vitest';
import { analyzePcm16Levels, applyPcm16InputGain } from '../pcm-input-gain.js';

function encodePcm16(samples: number[]): Uint8Array {
  const output = new Uint8Array(samples.length * 2);
  const view = new DataView(output.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * 2, Math.round((samples[index] ?? 0) * 32_767), true);
  }
  return output;
}

describe('pcm input gain', () => {
  it('reports RMS and peak levels for PCM16 audio', () => {
    const quiet = encodePcm16([0.01, -0.01, 0.02, -0.02]);
    const stats = analyzePcm16Levels(quiet);
    expect(stats.peakDb).toBeGreaterThan(-50);
    expect(stats.peakDb).toBeLessThan(-20);
    expect(stats.rmsDb).toBeLessThan(stats.peakDb);
  });

  it('boosts quiet PCM when normalization is enabled', () => {
    const quiet = encodePcm16([0.005, -0.005, 0.004, -0.004, 0.006, -0.006]);
    const before = analyzePcm16Levels(quiet);
    const gained = applyPcm16InputGain(quiet, {
      enableInputNormalization: true,
      targetRmsDb: -24,
      maxGainDb: 18,
    });
    expect(gained.appliedGainDb).toBeGreaterThan(0);
    expect(gained.stats.peakDb).toBeGreaterThan(before.peakDb);
  });

  it('limits gain to avoid clipping loud PCM', () => {
    const loud = encodePcm16([0.9, -0.85, 0.88, -0.92]);
    const gained = applyPcm16InputGain(loud, {
      inputGainDb: 12,
      enableInputNormalization: true,
      targetRmsDb: -12,
      maxGainDb: 24,
    });
    expect(gained.stats.peakDb).toBeLessThanOrEqual(-0.4);
  });
});
