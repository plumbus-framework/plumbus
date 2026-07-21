import { describe, expect, it } from 'vitest';
import { parseDurationToMs } from '../duration.js';

describe('parseDurationToMs', () => {
  it('parses supported units', () => {
    expect(parseDurationToMs('250ms')).toBe(250);
    expect(parseDurationToMs('30s')).toBe(30_000);
    expect(parseDurationToMs('5m')).toBe(300_000);
    expect(parseDurationToMs('1h')).toBe(3_600_000);
    expect(parseDurationToMs('2d')).toBe(172_800_000);
  });

  it('rejects invalid formats', () => {
    expect(() => parseDurationToMs('5')).toThrow(/Invalid duration/);
    expect(() => parseDurationToMs('5x')).toThrow(/Invalid duration/);
    expect(() => parseDurationToMs('-5s')).toThrow(/Invalid duration/);
    expect(() => parseDurationToMs('')).toThrow(/Invalid duration/);
  });

  it('includes label in error message when provided', () => {
    expect(() => parseDurationToMs('5', { label: 'delay' })).toThrow(
      'Invalid delay duration "5". Expected formats like "30s", "5m", "1h".',
    );
  });
});
