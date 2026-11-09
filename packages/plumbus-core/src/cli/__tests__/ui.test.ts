import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CapabilityContract } from '../../types/capability.js';
import type { FlowDefinition } from '../../types/flow.js';
import type { TranslationDefinition } from '../../types/translation.js';
import {
  enforceLocaleParity,
  generateE2EVitestConfig,
  generateNextjsAppFiles,
  generateUiModuleFiles,
  type UiGeneratorModule,
} from '../commands/ui.js';
import { resolveVitest } from '../commands/test.js';

function mockCapability(overrides: Partial<CapabilityContract> = {}): CapabilityContract {
  return {
    name: 'getUser',
    kind: 'query',
    domain: 'users',
    input: z.object({ id: z.string() }),
    output: z.object({ id: z.string() }),
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => ({ id: 'user-1' }),
    ...overrides,
  } as CapabilityContract;
}

function mockFlow(overrides: Partial<FlowDefinition> = {}): FlowDefinition {
  return {
    name: 'syncProfile',
    domain: 'users',
    input: z.object({ userId: z.string() }),
    steps: [],
    ...overrides,
  } as FlowDefinition;
}

function mockUiGenerators(): UiGeneratorModule {
  return {
    generateClientModule: () => 'client-module',
    generateHooksModule: () => 'hooks-module',
    generateAuthModule: () => 'auth-module',
    generateFormHintsModule: () => 'form-hints-module',
    generateNextjsTemplate: () => [
      { path: 'app/page.tsx', content: 'page-module' },
      { path: 'app/layout.tsx', content: 'layout-module' },
    ],
  };
}

const incompleteTranslations: TranslationDefinition[] = [
  {
    name: 'common',
    defaultLocale: 'en',
    locales: ['en', 'he'],
    messages: {
      en: { save: 'Save' },
      he: { save: '' },
    },
  },
];

describe('plumbus ui helpers', () => {
  it('generates UI module file entries', () => {
    const files = generateUiModuleFiles([mockCapability()], [mockFlow()], mockUiGenerators(), {
      baseUrl: '/api',
    });

    expect(files.map((file) => file.path)).toEqual([
      'lib/client.ts',
      'hooks/hooks.ts',
      'lib/auth.ts',
      'lib/form-hints.ts',
    ]);
  });

  it('generates a Next.js scaffold with generated modules', () => {
    const files = generateNextjsAppFiles(
      'AcmeApp',
      [mockCapability()],
      [mockFlow()],
      mockUiGenerators(),
      { apiBaseUrl: 'http://localhost:3000' },
    );

    const paths = files.map((file) => file.path);
    expect(paths).toContain('app/page.tsx');
    expect(paths).toContain('next-env.d.ts');
    expect(paths).toContain('lib/client.ts');
    expect(paths).toContain('hooks/hooks.ts');
    expect(paths).toContain('lib/auth.ts');
    expect(paths).toContain('lib/form-hints.ts');
  });

  it('separates template files from module files in nextjs output', () => {
    const files = generateNextjsAppFiles(
      'TestApp',
      [mockCapability()],
      [mockFlow()],
      mockUiGenerators(),
      { apiBaseUrl: 'http://localhost:3000' },
    );

    // Template files (from generateNextjsTemplate)
    expect(files.map((f) => f.path)).toContain('app/page.tsx');
    expect(files.map((f) => f.path)).toContain('app/layout.tsx');

    // Module files (from generateUiModuleFiles) — always regenerated
    const moduleFiles = ['lib/client.ts', 'hooks/hooks.ts', 'lib/auth.ts', 'lib/form-hints.ts'];
    for (const modFile of moduleFiles) {
      expect(files.map((f) => f.path)).toContain(modFile);
    }
  });

  it('generates an E2E Vitest config without external imports', () => {
    const config = generateE2EVitestConfig('http://localhost:3001');

    expect(config).toContain('export default {');
    expect(config).not.toContain('vitest/config');
    expect(config).toContain('maxWorkers: 1');
    expect(config).toContain('fileParallelism: false');
    expect(config).not.toContain('poolOptions');
  });

  it('discovers E2E tests without collecting the generated config as a test', () => {
    const directory = mkdtempSync(join(tmpdir(), 'plumbus-vitest-discovery-'));
    try {
      const configPath = join(directory, 'vitest.config.e2e.ts');
      writeFileSync(configPath, generateE2EVitestConfig('http://localhost:3001'));
      writeFileSync(join(directory, 'home.e2e.ts'), '// discovered without executing test code\n');
      const output = execFileSync(
        process.execPath,
        [
          resolveVitest().bin,
          'list',
          '--config',
          configPath,
          '--configLoader',
          'runner',
          '--root',
          directory,
          '--filesOnly',
          '--json',
        ],
        { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const files = JSON.parse(output) as unknown[];
      expect(files).toHaveLength(1);
      expect(output).toContain('home.e2e.ts');
      expect(output).not.toContain('vitest.config.e2e.ts');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);

  it('passes splitLocaleBundles to the translation generator', () => {
    const translations: TranslationDefinition[] = [
      {
        name: 'common',
        defaultLocale: 'en',
        locales: ['en', 'he'],
        messages: { en: { 'nav.home': 'Home' }, he: { 'nav.home': 'בית' } },
      },
    ];
    let capturedOptions: { splitLocaleBundles?: boolean } | undefined;
    const generators: UiGeneratorModule = {
      ...mockUiGenerators(),
      generateTranslationModule: (_defs, options) => {
        capturedOptions = options;
        return [{ path: 'i18n/messages.ts', content: 'messages-module' }];
      },
    };

    const files = generateUiModuleFiles(
      [],
      [],
      generators,
      { splitLocaleBundles: true },
      '',
      translations,
    );

    expect(capturedOptions?.splitLocaleBundles).toBe(true);
    expect(files.map((f) => f.path)).toContain('i18n/messages.ts');
  });

  it('passes authTransport to auth and client generators', () => {
    let authConfig: { transport?: string } | undefined;
    let clientConfig: { authTransport?: string } | undefined;
    const generators: UiGeneratorModule = {
      ...mockUiGenerators(),
      generateAuthModule: (config) => {
        authConfig = config;
        return 'auth-module';
      },
      generateClientModule: (_caps, _flows, config) => {
        clientConfig = config;
        return 'client-module';
      },
    };

    generateUiModuleFiles([], [], generators, { authTransport: 'session' });

    expect(authConfig?.transport).toBe('session');
    expect(clientConfig?.authTransport).toBe('session');
  });

  it('writes the split client and hooks with --split-client, and the single files without', () => {
    const generators: UiGeneratorModule = {
      ...mockUiGenerators(),
      generateSplitClientFiles: () => [
        { path: 'lib/client.ts', content: 'barrel' },
        { path: 'lib/client/getUser.ts', content: 'module' },
      ],
      generateSplitHooksFiles: () => [
        { path: 'hooks/hooks.ts', content: 'hooks-barrel' },
        { path: 'hooks/generated/useGetUser.ts', content: 'hook' },
      ],
    };
    const split = generateUiModuleFiles(
      [mockCapability()],
      [],
      generators,
      { splitClient: true },
      'frontend',
    );
    expect(split.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        'frontend/lib/client.ts',
        'frontend/lib/client/getUser.ts',
        'frontend/hooks/generated/useGetUser.ts',
      ]),
    );
    expect(split.find((f) => f.path === 'frontend/lib/client.ts')?.content).toBe('barrel');
    const single = generateUiModuleFiles([mockCapability()], [], generators, {}, 'frontend');
    expect(single.find((f) => f.path === 'frontend/lib/client.ts')?.content).toBe('client-module');
    expect(single.some((f) => f.path.includes('lib/client/'))).toBe(false);
  });

  it('refuses --split-client and --dedupe-queries with a @plumbus/ui that cannot do them', () => {
    expect(() => generateUiModuleFiles([], [], mockUiGenerators(), { splitClient: true })).toThrow(
      /0\.9\.1/,
    );
    expect(() =>
      generateUiModuleFiles([], [], mockUiGenerators(), { dedupeQueries: true }),
    ).toThrow(/0\.9\.1/);
  });

  it('passes dedupeQueries to the client generator and serverMessages to translations', () => {
    let clientConfig: { dedupeQueries?: boolean } | undefined;
    let translationOptions: { serverMessages?: boolean } | undefined;
    const generators: UiGeneratorModule = {
      ...mockUiGenerators(),
      generateSplitClientFiles: () => [],
      generateSplitHooksFiles: () => [],
      generateClientModule: (_caps, _flows, config) => {
        clientConfig = config;
        return 'client-module';
      },
      generateTranslationModule: (_defs, options) => {
        translationOptions = options;
        return [];
      },
    };
    const translations: TranslationDefinition[] = [
      {
        name: 'common',
        defaultLocale: 'en',
        locales: ['en'],
        messages: { en: { 'nav.home': 'Home' } },
      },
    ];
    generateUiModuleFiles(
      [],
      [],
      generators,
      { dedupeQueries: true, serverMessages: true },
      '',
      translations,
    );
    expect(clientConfig?.dedupeQueries).toBe(true);
    expect(translationOptions?.serverMessages).toBe(true);
  });
});

describe('enforceLocaleParity', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits when translations are incomplete', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    enforceLocaleParity(incompleteTranslations);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('warns and continues when skipLocaleParity is true', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    enforceLocaleParity(incompleteTranslations, true);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Skipping locale parity'))).toBe(
      true,
    );
  });

  it('is a no-op when catalogs are complete', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    enforceLocaleParity([
      {
        name: 'common',
        defaultLocale: 'en',
        locales: ['en', 'he'],
        messages: { en: { save: 'Save' }, he: { save: 'שמור' } },
      },
    ]);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
