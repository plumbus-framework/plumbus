import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFilesystemGovernedArtifactStore,
  createMemoryGovernedArtifactStore,
  digestGovernedArtifact,
  GovernedArtifactConflictError,
  resolveGovernedArtifactStore,
  type GovernedArtifactStore,
} from '../governed-artifacts.js';

const secretBody = 'sk-not-for-logs';

function expectImmutableStore(store: GovernedArtifactStore): void {
  const published = store.publish({
    kind: 'prompt',
    id: 'example.summarize',
    body: 'Summarize clearly.',
  });

  expect(published.digest).toBe(
    digestGovernedArtifact({
      kind: 'prompt',
      id: 'example.summarize',
      body: 'Summarize clearly.',
    }),
  );
  expect(store.get(published.digest)?.body).toBe('Summarize clearly.');

  const first = store.publish({
    kind: 'policy',
    id: 'example.summarize.policy',
    body: 'Do not invent facts.',
  });
  const second = store.publish({
    kind: 'policy',
    id: 'example.summarize.policy',
    body: 'Do not invent facts.',
  });
  expect(second.digest).toBe(first.digest);
  expect(second.publishedAt).toBe(first.publishedAt);

  store.publish({
    kind: 'prompt',
    id: 'example.locked',
    body: secretBody,
  });
  expect(() =>
    store.publish({
      kind: 'prompt',
      id: 'example.locked',
      body: 'changed-body',
    }),
  ).toThrow(GovernedArtifactConflictError);

  try {
    store.publish({
      kind: 'prompt',
      id: 'example.locked',
      body: 'changed-body',
    });
    throw new Error('expected conflict');
  } catch (err) {
    expect(err).toBeInstanceOf(GovernedArtifactConflictError);
    expect((err as Error).message).not.toContain(secretBody);
    expect((err as Error).message).not.toContain('changed-body');
  }

  const other = store.publish({
    kind: 'prompt',
    id: 'example.summarize.v2',
    body: 'Summarize differently.',
  });
  expect(other.digest).not.toBe(published.digest);
  expect(store.get(published.digest)?.id).toBe('example.summarize');
}

describe('createMemoryGovernedArtifactStore', () => {
  it('publishes a digest-addressed artifact and returns the same bytes by digest', () => {
    const store = createMemoryGovernedArtifactStore();
    const published = store.publish({
      kind: 'prompt',
      id: 'example.summarize',
      body: 'Summarize clearly.',
    });

    expect(published.digest).toBe(
      digestGovernedArtifact({
        kind: 'prompt',
        id: 'example.summarize',
        body: 'Summarize clearly.',
      }),
    );
    expect(store.get(published.digest)?.body).toBe('Summarize clearly.');
  });

  it('is idempotent for identical bytes', () => {
    const store = createMemoryGovernedArtifactStore();
    const first = store.publish({
      kind: 'policy',
      id: 'example.summarize.policy',
      body: 'Do not invent facts.',
    });
    const second = store.publish({
      kind: 'policy',
      id: 'example.summarize.policy',
      body: 'Do not invent facts.',
    });
    expect(second.digest).toBe(first.digest);
    expect(second.publishedAt).toBe(first.publishedAt);
  });

  it('refuses a later body change for the same kind and id', () => {
    const store = createMemoryGovernedArtifactStore();
    store.publish({
      kind: 'prompt',
      id: 'example.summarize',
      body: 'Summarize clearly.',
    });

    expect(() =>
      store.publish({
        kind: 'prompt',
        id: 'example.summarize',
        body: 'Summarize differently.',
      }),
    ).toThrow(GovernedArtifactConflictError);
  });

  it('treats a different id as a new artifact', () => {
    const store = createMemoryGovernedArtifactStore();
    const first = store.publish({
      kind: 'prompt',
      id: 'example.summarize',
      body: 'Summarize clearly.',
    });
    const second = store.publish({
      kind: 'prompt',
      id: 'example.summarize.v2',
      body: 'Summarize differently.',
    });
    expect(second.digest).not.toBe(first.digest);
    expect(store.get(first.digest)?.id).toBe('example.summarize');
  });

  it('keeps conflict messages free of artifact bodies', () => {
    expectImmutableStore(createMemoryGovernedArtifactStore());
  });
});

describe('createFilesystemGovernedArtifactStore', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function openStore(): { store: GovernedArtifactStore; directory: string } {
    const directory = mkdtempSync(join(tmpdir(), 'plumbus-governed-artifacts-'));
    directories.push(directory);
    return {
      directory,
      store: createFilesystemGovernedArtifactStore({ directory }),
    };
  }

  it('follows the same immutable digest contract as memory', () => {
    expectImmutableStore(openStore().store);
  });

  it('reloads published artifacts from the same directory', () => {
    const { store, directory } = openStore();
    const published = store.publish({
      kind: 'prompt',
      id: 'example.persist',
      body: 'Keep this text.',
    });

    const reloaded = createFilesystemGovernedArtifactStore({ directory });
    expect(reloaded.get(published.digest)).toEqual(published);
    const again = reloaded.publish({
      kind: 'prompt',
      id: 'example.persist',
      body: 'Keep this text.',
    });
    expect(again.publishedAt).toBe(published.publishedAt);
    expect(again.digest).toBe(published.digest);
  });

  it('refuses a later body change after reload', () => {
    const { store, directory } = openStore();
    store.publish({
      kind: 'policy',
      id: 'example.persist.policy',
      body: secretBody,
    });

    const reloaded = createFilesystemGovernedArtifactStore({ directory });
    expect(() =>
      reloaded.publish({
        kind: 'policy',
        id: 'example.persist.policy',
        body: 'other-body',
      }),
    ).toThrow(GovernedArtifactConflictError);

    try {
      reloaded.publish({
        kind: 'policy',
        id: 'example.persist.policy',
        body: 'other-body',
      });
      throw new Error('expected conflict');
    } catch (err) {
      expect(err).toBeInstanceOf(GovernedArtifactConflictError);
      expect((err as Error).message).not.toContain(secretBody);
      expect((err as Error).message).not.toContain('other-body');
    }
  });

  it('keeps path-like ids inside the store directory', () => {
    const { store, directory } = openStore();
    const published = store.publish({
      kind: 'prompt',
      id: '../../outside',
      body: 'Still stored by digest.',
    });

    expect(store.get(published.digest)?.id).toBe('../../outside');
    expect(readdirSync(directory).sort()).toEqual(['artifacts', 'keys']);
    expect(store.get('../artifacts/not-a-digest')).toBeUndefined();
    expect(store.get('../../etc/passwd')).toBeUndefined();
  });

  it('rejects an empty directory', () => {
    expect(() => createFilesystemGovernedArtifactStore({ directory: '   ' })).toThrow(
      /requires a directory/,
    );
  });
});

describe('resolveGovernedArtifactStore', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('returns an explicit store unchanged', () => {
    const store = createMemoryGovernedArtifactStore();
    expect(resolveGovernedArtifactStore({ artifacts: store })).toBe(store);
  });

  it('opens artifactsDirectory even when the folder is new', () => {
    const directory = mkdtempSync(join(tmpdir(), 'plumbus-resolve-artifacts-'));
    directories.push(directory);
    const store = resolveGovernedArtifactStore({ artifactsDirectory: directory });
    expect(store).toBeDefined();
    const published = store?.publish({
      kind: 'prompt',
      id: 'resolve.prompt',
      body: 'Keep this text.',
    });
    expect(published?.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('opens the default directory only when it already exists', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'plumbus-resolve-cwd-'));
    directories.push(cwd);
    expect(resolveGovernedArtifactStore({ cwd })).toBeUndefined();
    const defaultDir = join(cwd, '.plumbus/governed-artifacts');
    mkdirSync(defaultDir, { recursive: true });
    const store = resolveGovernedArtifactStore({ cwd });
    expect(store).toBeDefined();
  });
});
