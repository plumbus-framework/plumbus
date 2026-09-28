import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadServerExtensions } from '../load-extensions.js';

const directories: string[] = [];

async function appWithServer(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'plumbus-load-extensions-'));
  directories.push(root);
  await mkdir(join(root, 'app'));
  await writeFile(join(root, 'app', 'server.js'), source);
  return root;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('loadServerExtensions', () => {
  it('loads an authenticationRuntime exported by name', async () => {
    const root = await appWithServer(
      'export const authenticationRuntime = { authenticator: { kind: "named" } };\n',
    );
    const extensions = await loadServerExtensions(root);
    expect(extensions.authenticationRuntime).toEqual({ authenticator: { kind: 'named' } });
  });

  it('loads an authenticationRuntime from the default export', async () => {
    const root = await appWithServer(
      'export default { authenticationRuntime: { authenticator: { kind: "default" } } };\n',
    );
    const extensions = await loadServerExtensions(root);
    expect(extensions.authenticationRuntime).toEqual({ authenticator: { kind: 'default' } });
  });

  it('leaves authenticationRuntime unset when app/server.js does not export one', async () => {
    const root = await appWithServer('export const onRoutesRegistered = () => {};\n');
    const extensions = await loadServerExtensions(root);
    expect(extensions).not.toHaveProperty('authenticationRuntime');
    expect(typeof extensions.onRoutesRegistered).toBe('function');
  });
});
