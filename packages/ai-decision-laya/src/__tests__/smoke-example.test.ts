import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCapability } from '@plumbus/core/testing';

const appModule = await import(
  new URL('../../../../examples/ai-decision-smoke/lib/app.mjs', import.meta.url).href
);
const configModule = await import(
  new URL('../../../../examples/ai-decision-smoke/lib/config.mjs', import.meta.url).href
);
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const config = {
  apiKey: 'local-test-password',
  baseUrl: 'http://127.0.0.1:8080/v1',
  model: 'english',
};
const response = {
  model: 'laya-fixture',
  usage: { input_tokens: 20, output_tokens: 0 },
  routing: { model: 'english', repo: 'fixture', reason: 'test' },
  answers: {
    department: {
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 1, technical: 0, other: 0 },
      confidence: 1,
    },
    urgency: {
      type: 'score',
      score: 1,
      probabilities: { '0': 0, '1': 1, '2': 0 },
      legend: { '0': 'Routine', '1': 'Time sensitive', '2': 'Emergency' },
      confidence: 1,
    },
    refund: { type: 'noul', noul: 0.9 },
  },
};

describe('local decision smoke example', () => {
  it('generates an owner-only password file once and reuses the same password', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plumbus-decision-example-'));
    temporary.push(dir);
    const path = join(dir, '.env');
    const first = await configModule.ensureEnvironment(path);
    const before = await readFile(path, 'utf8');
    const second = await configModule.ensureEnvironment(path);
    expect(first.apiKey).toMatch(/^[a-f0-9]{64}$/);
    expect(second.apiKey).toBe(first.apiKey);
    expect(await readFile(path, 'utf8')).toBe(before);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('rejects hosted URLs and mismatched preload configuration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plumbus-decision-example-'));
    temporary.push(dir);
    const path = join(dir, '.env');
    await configModule.ensureEnvironment(path);
    const original = await readFile(path, 'utf8');
    await writeFile(
      path,
      original.replace('http://127.0.0.1:8080/v1', 'https://api.typesafe.ai/v1'),
    );
    await expect(configModule.loadConfig(path)).rejects.toThrow('local smoke requires');
    await writeFile(path, original.replace('LAYA_MODEL=english', 'LAYA_MODEL=multilingual'));
    await expect(configModule.loadConfig(path)).rejects.toThrow('preload list');
  });

  it('exercises both adapters and the negative paths with no extra inference requests', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, options) => {
      if (!new Headers(options?.headers).has('authorization'))
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      return Response.json(response);
    });
    const result = await appModule.runSmoke(config, { fetch });
    expect(result.checks).toHaveLength(6);
    expect(result.costs).toHaveLength(2);
    expect(
      result.costs.map((row: { operation: string; cost: number | null }) => [
        row.operation,
        row.cost,
      ]),
    ).toEqual([
      ['decide', null],
      ['decide', null],
    ]);
    expect(result.results.map((r: { provider: string }) => r.provider)).toEqual([
      'laya',
      'typesafe',
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [url, options] of fetch.mock.calls.slice(1)) {
      expect(String(url)).toBe(`${config.baseUrl}/systemone`);
      expect(new Headers(options?.headers).get('authorization')).toBe(`Bearer ${config.apiKey}`);
      expect(JSON.parse(String(options?.body))).toMatchObject({
        model: 'english',
        questions: { refund: { type: 'noul' } },
      });
    }
  });

  it('enforces capability access before calling an adapter', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const app = appModule.buildApp(config, { fetch });
    const result = await runCapability(
      app.capability,
      { via: 'laya', message: 'Refund please' },
      { auth: { roles: [] } },
    );
    expect(result.success).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects malformed input through the capability pipeline', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const app = appModule.buildApp(config, { fetch });
    const result = await runCapability(
      app.capability,
      { via: 'laya', message: '' },
      { auth: { roles: ['smoke-tester'] } },
    );
    expect(result.success).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports provider failure without exposing response bodies or the password', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('private-provider-body', { status: 401 }));
    const app = appModule.buildApp(config, { fetch });
    const result = await runCapability(
      app.capability,
      { via: 'laya', message: 'Refund please' },
      { ctx: app.createContext() },
    );
    expect(result.success).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(app.getCostRecords()).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('private-provider-body');
    expect(JSON.stringify(result)).not.toContain(config.apiKey);
  });
});
