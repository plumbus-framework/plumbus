import type { TranslationDefinition } from '@plumbus/core';
import { describe, expect, it } from 'vitest';
import { generateTranslationModule } from '../translation-generator.js';

const sampleDefinitions: TranslationDefinition[] = [
  {
    name: 'common',
    defaultLocale: 'en',
    locales: ['en', 'he'],
    messages: {
      en: { 'nav.home': 'Home' },
      he: { 'nav.home': 'בית' },
    },
  },
];

describe('generateTranslationModule', () => {
  it('emits a single messages.ts by default', () => {
    const files = generateTranslationModule(sampleDefinitions);
    const paths = files.map((f) => f.path);

    expect(paths).toContain('i18n/messages.ts');
    expect(paths).not.toContain('i18n/locales/en.ts');
    expect(files.find((f) => f.path === 'i18n/messages.ts')?.content).toContain('"nav"');
  });

  it('emits per-locale bundles when splitLocaleBundles is enabled', () => {
    const files = generateTranslationModule(sampleDefinitions, { splitLocaleBundles: true });
    const paths = files.map((f) => f.path);

    expect(paths).toContain('i18n/locales/en.ts');
    expect(paths).toContain('i18n/locales/he.ts');
    expect(paths).toContain('i18n/messages.ts');

    const enBundle = files.find((f) => f.path === 'i18n/locales/en.ts')?.content ?? '';
    expect(enBundle).toContain('export const localeMessages');
    expect(enBundle).toContain('"common"');

    const aggregator = files.find((f) => f.path === 'i18n/messages.ts')?.content ?? '';
    expect(aggregator).toContain('from "./locales/en"');
    expect(aggregator).toContain('from "./locales/he"');
    expect(aggregator).not.toMatch(/"nav":\s*\{/);
  });
});

describe('generateProvider (via generateTranslationModule)', () => {
  const providerContent = () =>
    generateTranslationModule(sampleDefinitions).find((f) => f.path === 'i18n/provider.tsx')
      ?.content ?? '';

  it('emits an optional initialLocale prop used for initial state', () => {
    const c = providerContent();
    expect(c).toContain('initialLocale?: Locale');
    expect(c).toContain('useState<Locale>(initialLocale ?? (defaultLocale as Locale))');
  });

  it('persists locale to both cookie and localStorage', () => {
    const c = providerContent();
    expect(c).toContain('function persistLocale');
    expect(c).toContain('document.cookie');
    expect(c).toContain('localStorage.setItem(LOCALE_STORAGE_KEY');
  });

  it('skips the localStorage fallback when initialLocale is provided', () => {
    expect(providerContent()).toContain('if (initialLocale) return;');
  });
});

describe('generateRequestConfig (via generateTranslationModule)', () => {
  it('reads the locale cookie via next/headers as a fallback', () => {
    const c =
      generateTranslationModule(sampleDefinitions).find((f) => f.path === 'i18n/request.ts')
        ?.content ?? '';
    expect(c).toContain('import { cookies } from "next/headers"');
    expect(c).toContain('(await cookies()).get(LOCALE_COOKIE_KEY)?.value');
    expect(c).toContain('requested ?? cookieLocale ?? defaultLocale');
  });
});
