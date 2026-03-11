import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineFlow } from '../defineFlow.js';

describe('defineFlow', () => {
  const validConfig = () => ({
    name: 'approveRefund',
    domain: 'billing',
    input: z.object({ refundId: z.string() }),
    steps: [
      { type: 'capability' as const, name: 'validateRefund' },
      { type: 'capability' as const, name: 'processRefund' },
    ],
  });

  it('creates a valid flow definition', () => {
    const flow = defineFlow(validConfig());
    expect(flow.name).toBe('approveRefund');
    expect(flow.steps).toHaveLength(2);
  });

  it('freezes the returned definition', () => {
    const flow = defineFlow(validConfig());
    expect(Object.isFrozen(flow)).toBe(true);
  });

  it('accepts optional fields', () => {
    const flow = defineFlow({
      ...validConfig(),
      description: 'Processes refund approval',
      tags: ['billing'],
      state: z.object({ approved: z.boolean() }),
      trigger: { event: 'refund.requested' },
      schedule: { cron: '0 * * * *' },
      retry: { attempts: 3, backoff: 'exponential' },
    });
    expect(flow.trigger?.event).toBe('refund.requested');
    expect(flow.retry?.attempts).toBe(3);
  });

  it('throws if name is missing', () => {
    expect(() => defineFlow({ ...validConfig(), name: '' })).toThrow('name is required');
  });

  it('throws if domain is missing', () => {
    expect(() => defineFlow({ ...validConfig(), domain: '' })).toThrow('domain is required');
  });

  it('throws if input is not a Zod schema', () => {
    expect(() => defineFlow({ ...validConfig(), input: {} as any })).toThrow(
      'input must be a Zod schema',
    );
  });

  it('throws if steps is empty', () => {
    expect(() => defineFlow({ ...validConfig(), steps: [] })).toThrow(
      'at least one step is required',
    );
  });
});
