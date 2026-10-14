import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, loadAppConfig } from '../index.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(content: string) {
  const root = await mkdtemp(join(tmpdir(), 'plumbus-config-'));
  directories.push(root);
  await mkdir(join(root, 'config'));
  await writeFile(join(root, 'config/app.config.ts'), content);
  return root;
}
describe('configuration resolution', () => {
  it('applies typed nested overrides without losing environment siblings', () => {
    const config = loadConfig({
      env: { QUEUE_HOST: 'broker', QUEUE_PREFIX: 'environment' },
      queue: { prefix: 'explicit', visibilityTimeoutSec: 75 },
    });
    expect(config.queue).toMatchObject({
      host: 'broker',
      port: 6379,
      prefix: 'explicit',
      visibilityTimeoutSec: 75,
    });
  });
  it('rejects unknown nested keys and invalid timing without echoing secrets', () => {
    expect(() =>
      loadConfig({ env: {}, queue: { password: 'do-not-print', typo: 3 } } as any),
    ).toThrow('Invalid configuration');
    expect(() => loadConfig({ env: { QUEUE_POLL_INTERVAL_MS: '-1' } })).toThrow();
    expect(() => loadConfig({ env: { QUEUE_BACKEND: 'reddis' } })).toThrow();
  });
  it('loads TS config with file < env < explicit precedence', async () => {
    const root = await fixture(
      `export const config = { environment: 'staging', queue: { host: 'file-host', prefix: 'file-prefix', visibilityTimeoutSec: 60 }, database: { database: 'file-db' } } as const;`,
    );
    const config = await loadAppConfig(
      {
        env: { QUEUE_HOST: 'localhost', QUEUE_PREFIX: 'env-prefix' },
        environment: 'production',
        queue: { prefix: 'explicit' },
      },
      root,
    );
    expect(config.environment).toBe('production');
    expect(config.queue).toMatchObject({
      host: 'localhost',
      prefix: 'explicit',
      visibilityTimeoutSec: 60,
    });
    expect(config.database.database).toBe('file-db');
  });
  it('supports default exports and rejects unsupported file settings', async () => {
    const root = await fixture(`export default { queue: { prefix: 'default-export' } };`);
    expect((await loadAppConfig({ env: {} }, root)).queue.prefix).toBe('default-export');
    const bad = await fixture(`export default { queue: { unknown: true } };`);
    await expect(loadAppConfig({ env: {} }, bad)).rejects.toThrow('Invalid configuration');
  });
  it('accepts every value the environment loader allows (zero limits, prompt timeouts)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plumbus-config-'));
    directories.push(root);
    const config = await loadAppConfig(
      {
        env: {
          AI_DEFAULT_PROVIDER: 'openai',
          AI_OPENAI_API_KEY: 'k',
          AI_OPENAI_MAX_TOKENS: '0',
          AI_BEDROCK_REGION: 'us-east-1',
          AI_BEDROCK_PRICING_TTL_MS: '0',
          PROMPT_SUMMARY_PROVIDER: 'openai',
          PROMPT_SUMMARY_TIMEOUT_MS: '5000',
        },
      },
      root,
    );
    expect(config.aiProviders?.providers.openai?.maxTokensPerRequest).toBe(0);
    expect(config.aiProviders?.providers.bedrock?.pricingCacheTtlMs).toBe(0);
    expect(config.aiProviders?.promptOverrides?.summary?.timeoutMs).toBe(5000);
    const single = await loadAppConfig(
      { env: { AI_PROVIDER: 'openai', AI_API_KEY: 'k', AI_MAX_TOKENS: '0' } },
      root,
    );
    expect(single.ai?.maxTokensPerRequest).toBe(0);
  });
  it('rejects AI numbers from the file that the environment loader refuses', async () => {
    const cases = [
      `ai: { requestTimeout: 3_000_000_000 }`,
      `ai: { requestTimeout: 2.5 }`,
      `aiProviders: { providers: { openai: { requestTimeout: 3_000_000_000 } } }`,
      `aiProviders: { promptOverrides: { summary: { temperature: 7 } } }`,
      `aiProviders: { promptOverrides: { summary: { temperature: -0.1 } } }`,
      `aiProviders: { promptOverrides: { summary: { maxTokens: 1.5 } } }`,
    ];
    for (const settings of cases) {
      const root = await fixture(`export default { ${settings} };`);
      await expect(loadAppConfig({ env: {} }, root), settings).rejects.toThrow(
        'Invalid configuration',
      );
    }
    const root = await fixture(
      `export default { ai: { requestTimeout: 2_147_483_647 }, aiProviders: { promptOverrides: { summary: { temperature: 2, maxTokens: 1 } } } };`,
    );
    const config = await loadAppConfig({ env: {} }, root);
    expect(config.ai?.requestTimeout).toBe(2_147_483_647);
    expect(config.aiProviders?.promptOverrides?.summary).toMatchObject({
      temperature: 2,
      maxTokens: 1,
    });
  });
});
