import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { createLayaDecisionAdapter } from '../index.js';

const request = {
  state: { text: 'נא לבטל את ההזמנה' },
  questions: {
    cancel: { type: 'probability', instructions: 'Does the user request cancellation?' },
  },
} as const;
const wire = {
  model: 'laya-rl-agent',
  usage: { input_tokens: 90, output_tokens: 0 },
  routing: {
    model: 'multilingual',
    repo: 'convaiinnovations/laya/multilingual',
    reason: 'Hebrew script',
  },
  answers: { cancel: { type: 'noul', noul: 0.8, confidence: 0.8, action: 'execute' } },
};

describe('Laya decision adapter', () => {
  it('routes automatically, retains checkpoint identity, and reports unknown infrastructure cost', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(wire));
    const result = await createLayaDecisionAdapter({
      baseUrl: 'http://localhost:8080/v1',
      apiKey: 'key',
      fetch,
    }).decide(request);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).not.toHaveProperty('model');
    expect(result).toMatchObject({
      provider: 'laya',
      routing: wire.routing,
      cost: null,
      costAvailable: false,
    });
    expect(result.answers.cancel).toEqual({
      type: 'probability',
      probability: 0.8,
      confidence: 0.8,
    });
  });

  it('passes explicit checkpoint/language overrides and an operator cost estimate', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(wire));
    const adapter = createLayaDecisionAdapter({
      baseUrl: 'http://localhost:8080/v1',
      model: 'english',
      language: 'he',
      costPerRequestUsd: 0.001,
      fetch,
    });
    const result = await adapter.decide({ ...request, model: 'multilingual' });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'multilingual',
      lang: 'he',
    });
    expect(result).toMatchObject({ cost: 0.001, costAvailable: true });
  });

  it('fails on an unavailable service', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error('connection refused'));
    await expect(
      createLayaDecisionAdapter({ baseUrl: 'http://localhost:8080/v1', fetch }).decide(request),
    ).rejects.toMatchObject({ kind: 'network', provider: 'laya' });
  });

  it('rejects invalid provider answers', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        Response.json({ ...wire, answers: { cancel: { type: 'noul', noul: 2 } } }),
      );
    await expect(
      createLayaDecisionAdapter({ baseUrl: 'http://localhost:8080/v1', fetch }).decide(request),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('rejects invalid local pricing and endpoint configuration', () => {
    expect(() => createLayaDecisionAdapter({ baseUrl: 'file:///socket' })).toThrow();
    expect(() =>
      createLayaDecisionAdapter({ baseUrl: 'http://localhost/v1', costPerRequestUsd: -1 }),
    ).toThrow();
  });

  it('passes the Python service contract tests without downloading models', () => {
    execFileSync(
      'python3',
      ['-B', '-m', 'unittest', 'discover', '-s', 'service', '-p', 'test_*.py'],
      { cwd: new URL('../..', import.meta.url), timeout: 20_000, stdio: 'pipe' },
    );
  });
});
