import type { CapabilityContract } from '@plumbus/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { selectSampleCapability } from '../sample-capability.js';

function makeCap(overrides: Partial<CapabilityContract> = {}): CapabilityContract {
  return {
    name: 'listItems',
    kind: 'query',
    domain: 'items',
    input: z.object({}),
    output: z.object({ items: z.array(z.string()) }),
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => ({ items: [] }),
    ...overrides,
  } as CapabilityContract;
}

describe('selectSampleCapability', () => {
  it('picks first zero-input query by stable name order', () => {
    const caps = [
      makeCap({ name: 'zQuery', input: z.object({ id: z.string() }) }),
      makeCap({ name: 'aQuery', input: z.object({}) }),
    ];
    const sel = selectSampleCapability(caps);
    expect(sel.mode).toBe('zero-input');
    expect(sel.capability?.name).toBe('aQuery');
  });

  it('returns none when every query requires input', () => {
    const sel = selectSampleCapability([
      makeCap({ input: z.object({ id: z.string() }) }),
      makeCap({ name: 'other', kind: 'command', input: z.object({}) }),
    ]);
    expect(sel.mode).toBe('none');
  });

  it('does not select scalar-only capabilities with required fields', () => {
    const sel = selectSampleCapability([
      makeCap({
        name: 'search',
        input: z.object({ q: z.string() }),
      }),
    ]);
    expect(sel.mode).toBe('none');
  });

  it('does not treat non-object inputs as zero-input', () => {
    const sel = selectSampleCapability([makeCap({ input: z.string() })]);
    expect(sel.mode).toBe('none');
  });

  it('does not treat ZodEffects with required fields as zero-input', () => {
    const sel = selectSampleCapability([
      makeCap({
        input: z.object({ id: z.string() }).transform((v) => v),
      }),
    ]);
    expect(sel.mode).toBe('none');
  });
});
