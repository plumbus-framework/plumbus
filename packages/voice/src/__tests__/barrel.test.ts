import { describe, expect, it } from 'vitest';
import * as voiceSdk from '../index.js';

describe('@plumbus/voice public barrel', () => {
  it('does not export internal tone mapper helpers', () => {
    expect('mapToneToTtsParams' in voiceSdk).toBe(false);
  });
});
