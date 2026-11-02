import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Node's native loader rejects things tsx accepts (an extensionless relative import, for
// example), so a .js config must keep going through tsx outside compiled voice workers.
const tsImport = vi.fn(async () => ({ config: { queue: { prefix: 'via-tsx' } } }));
vi.mock('tsx/esm/api', () => ({ tsImport }));

const { loadAppConfig } = await import('../app-config.js');

const directories: string[] = [];
afterEach(async () => {
  tsImport.mockClear();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function jsConfigApp() {
  const root = await mkdtemp(join(tmpdir(), 'plumbus-config-'));
  directories.push(root);
  await mkdir(join(root, 'config'));
  await writeFile(
    join(root, 'config/app.config.js'),
    `export const config = { queue: { prefix: 'native' } };`,
  );
  return root;
}

describe('app.config.js loading', () => {
  it('goes through tsx in ordinary mode, as before 0.8.3', async () => {
    const config = await loadAppConfig({ env: {} }, await jsConfigApp());
    expect(tsImport).toHaveBeenCalledOnce();
    expect(config.queue.prefix).toBe('via-tsx');
  });

  it('is imported natively, without tsx, in JavaScript-only (compiled voice) mode', async () => {
    const config = await loadAppConfig({ env: {} }, await jsConfigApp(), { javascriptOnly: true });
    expect(tsImport).not.toHaveBeenCalled();
    expect(config.queue.prefix).toBe('native');
  });
});
