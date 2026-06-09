import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defineCapability } from '@plumbus/core';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FixturePathEscapeError, resolveContainedFixturePath } from '../fixture-path.js';
import { runSafeReply } from '../test-intent.js';
import { validateTestFixtures } from '../validate-fixtures.js';
import type { ApiManifest } from '../../manifest/types.js';

describe('resolveContainedFixturePath', () => {
  it('resolves a relative path under appRoot', () => {
    const root = '/app/root';
    const resolved = resolveContainedFixturePath(root, 'fixtures/ok.json');
    expect(resolved).toBe(join('/app/root', 'fixtures/ok.json'));
  });

  it('rejects path traversal', () => {
    expect(() => resolveContainedFixturePath('/app', '../outside.json')).toThrow(
      FixturePathEscapeError,
    );
  });

  it('rejects absolute fixture paths', () => {
    expect(() => resolveContainedFixturePath('/app', '/etc/passwd')).toThrow(
      FixturePathEscapeError,
    );
  });
});

describe('fixture path containment at runtime and validate', () => {
  let tmpDir: string;

  afterEach(() => {
    tmpDir = '';
  });

  async function setupApp() {
    tmpDir = join(tmpdir(), `plumbus-fixture-${Date.now()}`);
    await mkdir(join(tmpDir, 'fixtures'), { recursive: true });
    await writeFile(join(tmpDir, 'fixtures/valid.json'), JSON.stringify({ id: '1', status: 'ok' }));

    const cap = defineCapability({
      name: 'getThing',
      kind: 'query',
      domain: 'demo',
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string(), status: z.string() }),
      effects: { data: [], events: [], external: [], ai: false },
      exposeAs: ['api'],
      api: {
        operationId: 'getThing',
        method: 'GET',
        path: '/things/{id}',
        test: {
          enabled: true,
          modes: ['safe-reply'],
          safeReply: { fixture: 'fixtures/valid.json' },
        },
      },
      handler: async (_ctx, input) => ({ id: input.id, status: 'live' }),
    });

    return cap;
  }

  it('runSafeReply rejects escaped fixture paths', async () => {
    const cap = await setupApp();
    await expect(runSafeReply(cap, tmpDir, '../outside.json')).rejects.toMatchObject({
      name: 'FixtureReadError',
    });
  });

  it('runSafeReply reads a valid relative fixture', async () => {
    const cap = await setupApp();
    const result = await runSafeReply(cap, tmpDir, 'fixtures/valid.json');
    expect(result.data).toEqual({ id: '1', status: 'ok' });
  });

  it('validateTestFixtures rejects escaped paths', async () => {
    await setupApp();
    const capWithEscape = defineCapability({
      name: 'getThing',
      kind: 'query',
      domain: 'demo',
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string(), status: z.string() }),
      effects: { data: [], events: [], external: [], ai: false },
      exposeAs: ['api'],
      api: {
        operationId: 'getThing',
        method: 'GET',
        path: '/things/{id}',
        test: {
          enabled: true,
          modes: ['safe-reply'],
          safeReply: { fixture: '../outside.json' },
        },
      },
      handler: async (_ctx, input) => ({ id: input.id, status: 'live' }),
    });
    const findings = await validateTestFixtures([capWithEscape], tmpDir);
    expect(findings.some((f) => f.code === 'test.fixture-path-escape')).toBe(true);
  });

  it('validateTestFixtures uses manifest-overridden fixture', async () => {
    const cap = await setupApp();
    const manifest: ApiManifest = {
      apiVersion: 'plumbus.dev/v1',
      name: 'test',
      basePath: '/api/v1',
      expose: [
        {
          capability: 'demo.getThing',
          operationId: 'getThing',
          method: 'GET',
          path: '/things/{id}',
          test: {
            enabled: true,
            modes: ['safe-reply'],
            safeReply: { fixture: 'fixtures/missing.json' },
          },
        },
      ],
    };

    const findings = await validateTestFixtures([cap], tmpDir, manifest);
    expect(findings.some((f) => f.code === 'test.fixture-read-failed')).toBe(true);
  });
});
