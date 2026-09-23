import { describe, expect, it, vi } from 'vitest';
import { createTypeSafeDecisionAdapter } from '../index.js';

const request = {
  state: 'Please refund the duplicate charge.',
  questions: { refund: { type: 'probability', instructions: 'Does the user request a refund?' } },
} as const;
const wire = {
  model: 'jev-1.13.0',
  usage: { input_tokens: 1000, output_tokens: 25 },
  answers: { refund: { type: 'noul', noul: 0.95 } },
};

describe('TypeSafe decision adapter', () => {
  it('maps public probability questions to noul and returns typed results and actual usage', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(wire));
    const adapter = createTypeSafeDecisionAdapter({ apiKey: 'key', fetch });
    const result = await adapter.decide(request);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'jev-latest',
      questions: { refund: { type: 'noul' } },
    });
    expect(result).toMatchObject({
      provider: 'typesafe',
      model: 'jev-1.13.0',
      costAvailable: true,
      usage: { totalTokens: 1025 },
    });
    expect(result.cost).toBeCloseTo(0.000042, 12);
    expect(result.answers.refund.probability).toBe(0.95);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('supports model overrides and explicit rates for new models', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ ...wire, model: 'jev-next' }));
    const adapter = createTypeSafeDecisionAdapter({
      apiKey: 'key',
      model: 'jev-preview',
      inputRates: { 'jev-next': 0.1 },
      fetch,
    });
    const result = await adapter.decide({ ...request, model: 'jev-next' });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).model).toBe('jev-next');
    expect(result.cost).toBe(0.0001);
  });

  it('leaves unknown response model pricing unknown even when requesting a known model', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ ...wire, model: 'new-model' }));
    expect(
      await createTypeSafeDecisionAdapter({ apiKey: 'key', fetch }).decide(request),
    ).toMatchObject({ cost: null, costAvailable: false });
  });

  it('honors a configured zero rate', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(wire));
    expect(
      await createTypeSafeDecisionAdapter({
        apiKey: 'key',
        inputRates: { 'jev-1.13.0': 0 },
        fetch,
      }).decide(request),
    ).toMatchObject({ cost: 0, costAvailable: true });
  });

  it('rejects invalid requests before making a billable call', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      createTypeSafeDecisionAdapter({ apiKey: 'key', fetch }).decide({ ...request, questions: {} }),
    ).rejects.toMatchObject({ kind: 'invalid_request' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { apiKey: '' },
    { apiKey: '  ' },
    { apiKey: 'key', inputRates: { model: -1 } },
    { apiKey: 'key', inputRates: { model: Number.NaN } },
  ])('rejects invalid configuration', (config) => {
    expect(() => createTypeSafeDecisionAdapter(config)).toThrow();
  });
});
