import { describe, expect, it } from 'vitest';
import { calculateJevCost, findJevInputRate } from '../pricing.js';

describe('Jev pricing', () => {
  it('prices every published model and alias at the same rate', () => {
    for (const model of ['jev-1.13.0', 'jev-1.13', 'jev-latest', 'jev-preview']) {
      expect(findJevInputRate(model)).toBe(0.042);
    }
  });

  it('falls back to the shared rate for an unreleased jev version', () => {
    expect(findJevInputRate('jev-1.14.0')).toBe(0.042);
  });

  it('reports no rate for a model that is not Jev', () => {
    expect(findJevInputRate('gpt-5.6-sol')).toBeNull();
    expect(calculateJevCost('gpt-5.6-sol', 1_000_000)).toBeUndefined();
  });

  it('charges input tokens only', () => {
    expect(calculateJevCost('jev-latest', 1_000_000)).toBeCloseTo(0.042, 12);
    expect(calculateJevCost('jev-latest', 0)).toBe(0);
  });
});
