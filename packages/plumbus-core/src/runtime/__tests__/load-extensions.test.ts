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
    const cwd = await writeServerModule('export const credentials = { id: "host-catalog" };\n');
    const extensions = await loadServerExtensions(cwd);
    expect(extensions.credentials).toEqual({ id: 'host-catalog' });
  });

  it('leaves credentials unset when app/server.js does not export it', async () => {
    const cwd = await writeServerModule('export function onRoutesRegistered() {}\n');
    const extensions = await loadServerExtensions(cwd);
    expect(extensions.credentials).toBeUndefined();
  });

  it('loads provider concurrency, propagation, and span hooks from app/server.js', async () => {
    const cwd = await writeServerModule(
      [
        'export const aiProviderConcurrency = { maxConcurrentCalls: 3 };',
        'export const resolveAIProviderHeaders = () => ({ traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01" });',
        'export const onAIProviderSpan = () => undefined;',
        '',
      ].join('\n'),
    );
    const extensions = await loadServerExtensions(cwd);
    expect(extensions.aiProviderConcurrency).toEqual({ maxConcurrentCalls: 3 });
    expect(typeof extensions.resolveAIProviderHeaders).toBe('function');
    expect(typeof extensions.onAIProviderSpan).toBe('function');
  });

  it('loads the data-plane resolver family from app/server.js', async () => {
    const cwd = await writeServerModule(
      [
        'export const dataPlaneResolver = { resolve: async (ref) => ({ ref }) };',
        'export const listTenantRefs = async () => ["tenant-a"];',
        'export const untenantedDataPlane = "control-plane";',
        'export const requestDataPlane = "control-plane";',
        'export const workerDataPlane = "control-plane";',
        'export const resolveTenantRef = (auth) => auth.tenantId;',
        '',
      ].join('\n'),
    );
    const extensions = await loadServerExtensions(cwd);
    expect(typeof extensions.dataPlaneResolver?.resolve).toBe('function');
    expect(await extensions.listTenantRefs?.()).toEqual(['tenant-a']);
    expect(extensions.untenantedDataPlane).toBe('control-plane');
    expect(extensions.requestDataPlane).toBe('control-plane');
    expect(extensions.workerDataPlane).toBe('control-plane');
    expect(
      extensions.resolveTenantRef?.({ tenantId: 't', roles: [], scopes: [], provider: 'x' }),
    ).toBe('t');
  });

  it('ignores a resolver without resolve and policies outside the vocabulary', async () => {
    const cwd = await writeServerModule(
      [
        'export const dataPlaneResolver = { notResolve: true };',
        'export const untenantedDataPlane = "anything-goes";',
        'export const requestDataPlane = "wherever";',
        'export const workerDataPlane = "elsewhere";',
        'export const listTenantRefs = ["not", "a", "function"];',
        '',
      ].join('\n'),
    );
    const extensions = await loadServerExtensions(cwd);
    expect(extensions.dataPlaneResolver).toBeUndefined();
    expect(extensions.untenantedDataPlane).toBeUndefined();
    expect(extensions.requestDataPlane).toBeUndefined();
    expect(extensions.workerDataPlane).toBeUndefined();
    expect(extensions.listTenantRefs).toBeUndefined();
  });
});
