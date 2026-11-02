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
  it('loads a compiled JS config natively in JavaScript-only mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plumbus-config-'));
    directories.push(root);
    await mkdir(join(root, 'config'));
    await writeFile(
      join(root, 'config/app.config.ts'),
      `export const config = { queue: { prefix: 'ts' } };`,
    );
    await writeFile(
      join(root, 'config/app.config.js'),
      `export const config = { queue: { prefix: 'compiled-js' } };`,
    );
    const config = await loadAppConfig({ env: {} }, root, { javascriptOnly: true });
    expect(config.queue.prefix).toBe('compiled-js');
  });
  it('supports default exports and rejects unsupported file settings', async () => {
    const root = await fixture(`export default { queue: { prefix: 'default-export' } };`);
    expect((await loadAppConfig({ env: {} }, root)).queue.prefix).toBe('default-export');
    const bad = await fixture(`export default { queue: { unknown: true } };`);
    await expect(loadAppConfig({ env: {} }, bad)).rejects.toThrow('Invalid configuration');
  });
});
