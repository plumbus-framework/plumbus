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
  resolveE2eBaseUrl,
  resolveUiApiBaseUrl,
  type UiGeneratorModule,
} from '../commands/ui.js';

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
      { apiBaseUrl: 'https://api.example.com' },
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
      { apiBaseUrl: 'https://api.example.com' },
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
    const config = generateE2EVitestConfig('https://app.example.com');

    expect(config).toContain('export default {');
    expect(config).not.toContain('vitest/config');
  });

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
});

describe('resolveUiApiBaseUrl', () => {
  it('uses the explicit flag', () => {
    expect(resolveUiApiBaseUrl('https://api.example.com', {})).toBe('https://api.example.com');
  });

  it('strips trailing slashes', () => {
    expect(resolveUiApiBaseUrl('https://api.example.com/', {})).toBe('https://api.example.com');
  });

  it('falls back to NEXT_PUBLIC_API_BASE_URL', () => {
    expect(
      resolveUiApiBaseUrl(undefined, { NEXT_PUBLIC_API_BASE_URL: 'https://from-next.example.com' }),
    ).toBe('https://from-next.example.com');
  });

  it('falls back to API_BASE_URL', () => {
    expect(resolveUiApiBaseUrl(undefined, { API_BASE_URL: 'https://from-api.example.com' })).toBe(
      'https://from-api.example.com',
    );
  });

  it('prefers the flag over env', () => {
    expect(
      resolveUiApiBaseUrl('https://flag.example.com', { API_BASE_URL: 'https://env.example.com' }),
    ).toBe('https://flag.example.com');
  });

  it('prefers NEXT_PUBLIC_API_BASE_URL over API_BASE_URL', () => {
    expect(
      resolveUiApiBaseUrl(undefined, {
        NEXT_PUBLIC_API_BASE_URL: 'https://next.example.com',
        API_BASE_URL: 'https://api.example.com',
      }),
    ).toBe('https://next.example.com');
  });

  it('rejects missing values', () => {
    expect(() => resolveUiApiBaseUrl(undefined, {})).toThrow(/--api-base-url is required/);
  });

  it('rejects empty flag and empty env', () => {
    expect(() => resolveUiApiBaseUrl('  ', { API_BASE_URL: '' })).toThrow(
      /--api-base-url is required/,
    );
  });

  it('rejects non-http URLs', () => {
    expect(() => resolveUiApiBaseUrl('ftp://api.example.com', {})).toThrow(/http/);
  });

  it('rejects relative URLs', () => {
    expect(() => resolveUiApiBaseUrl('/api', {})).toThrow(/absolute/);
  });
});

describe('resolveE2eBaseUrl', () => {
  it('uses the explicit flag', () => {
    expect(resolveE2eBaseUrl('https://app.example.com', {})).toBe('https://app.example.com');
  });

  it('falls back to E2E_BASE_URL', () => {
    expect(resolveE2eBaseUrl(undefined, { E2E_BASE_URL: 'https://e2e.example.com' })).toBe(
      'https://e2e.example.com',
    );
  });

  it('rejects missing values', () => {
    expect(() => resolveE2eBaseUrl(undefined, {})).toThrow(/--base-url is required/);
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
