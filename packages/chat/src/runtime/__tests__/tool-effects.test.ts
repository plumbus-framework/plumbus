import { describe, expect, it } from 'vitest';
import type { CapabilityContract } from '@plumbus/core';
import { isConfirmCapability } from '../tool-effects.js';

function makeCap(effects: CapabilityContract['effects']): CapabilityContract {
  return {
    name: 'test.read',
    kind: 'action',
    domain: 'test',
    input: {} as CapabilityContract['input'],
    output: {} as CapabilityContract['output'],
    effects,
    handler: async () => ({}),
  } as CapabilityContract;
}

describe('isConfirmCapability', () => {
  it('classifies an ai-only capability as auto', () => {
    expect(isConfirmCapability(makeCap({ data: [], events: [], external: [], ai: true }))).toBe(
      false,
    );
  });

  it('classifies a data-write capability as confirm', () => {
    expect(isConfirmCapability(makeCap({ data: ['x'], events: [], external: [], ai: false }))).toBe(
      true,
    );
  });

  it('classifies external/flows/capabilities effects as confirm', () => {
    expect(isConfirmCapability(makeCap({ data: [], events: [], external: ['h'], ai: false }))).toBe(
      true,
    );
    expect(
      isConfirmCapability(makeCap({ data: [], events: [], external: [], flows: ['f'], ai: false })),
    ).toBe(true);
    expect(
      isConfirmCapability(
        makeCap({
          data: [],
          events: [],
          external: [],
          capabilities: ['c'],
          ai: false,
        }),
      ),
    ).toBe(true);
  });
});
