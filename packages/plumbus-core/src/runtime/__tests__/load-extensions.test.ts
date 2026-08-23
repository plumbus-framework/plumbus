import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadServerExtensions } from '../load-extensions.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeServerModule(source: string): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'plumbus-server-ext-'));
  dirs.push(cwd);
  await mkdir(path.join(cwd, 'app'));
  await writeFile(path.join(cwd, 'app/server.js'), source, 'utf8');
  return cwd;
}

describe('loadServerExtensions', () => {
  it('loads an optional credentials catalog from app/server.js', async () => {
    const cwd = await writeServerModule(
      'export const credentials = { id: "host-catalog" };\n',
    );
    const extensions = await loadServerExtensions(cwd);
    expect(extensions.credentials).toEqual({ id: 'host-catalog' });
  });

  it('leaves credentials unset when app/server.js does not export it', async () => {
    const cwd = await writeServerModule('export function onRoutesRegistered() {}\n');
    const extensions = await loadServerExtensions(cwd);
    expect(extensions.credentials).toBeUndefined();
  });
});
