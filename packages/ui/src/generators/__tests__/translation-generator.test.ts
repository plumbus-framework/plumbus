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

  it('emits keys.ts and global.ts AppConfig augmentation', () => {
    const files = generateTranslationModule(sampleDefinitions);
    const paths = files.map((f) => f.path);

    expect(paths).toContain('i18n/keys.ts');
    expect(paths).toContain('i18n/global.ts');
    expect(paths).not.toContain('i18n/next-intl.d.ts');

    const keys = files.find((f) => f.path === 'i18n/keys.ts')?.content ?? '';
    expect(keys).toContain('export type Messages');
    expect(keys).toContain('typeof import("./messages").messages');
    expect(keys).toContain('export type Namespace');
    expect(keys).toContain('export type MessageKeyOf');
    expect(keys).toContain('export type MessageArgsOf');
    expect(keys).toContain('import type { ICUArgs } from "@plumbus/ui/next-intl"');
    expect(keys).toContain('export type I18nKey');

    const aug = files.find((f) => f.path === 'i18n/global.ts')?.content ?? '';
    expect(aug).toContain('declare module "next-intl"');
    expect(aug).toContain('interface AppConfig');
    expect(aug).toContain('Messages: (typeof messages)[typeof defaultLocale]');
    expect(aug).not.toMatch(/\sas\s+/);
  });

  it('emits cast-free provider, request, and Zod-backed locale helpers', () => {
    const files = generateTranslationModule(sampleDefinitions);
    const provider = files.find((f) => f.path === 'i18n/provider.tsx')?.content ?? '';
    const request = files.find((f) => f.path === 'i18n/request.ts')?.content ?? '';
    const config = files.find((f) => f.path === 'i18n/config.ts')?.content ?? '';
    const index = files.find((f) => f.path === 'i18n/index.ts')?.content ?? '';

    expect(provider).not.toMatch(/\sas\s+Locale\b/);
    expect(request).not.toMatch(/\sas\s+Locale\b/);
    expect(config).toContain('import { z } from "@plumbus/core/zod"');
    expect(config).toContain('export const localeSchema = z.enum(locales)');
    expect(config).toContain('export function isLocale');
    expect(config).toContain('localeSchema.safeParse(value).success');
    expect(config).toContain('export const rtlLocaleSchema = z.enum(rtlLocales)');
    expect(config).toContain('export function localeDir');
    expect(config).toContain('? "rtl" : "ltr"');
    expect(config).toContain('export const defaultLocale = "en" as const satisfies Locale');
    expect(config).not.toMatch(/defaultLocale:\s*Locale\s*=/);
    expect(provider).toContain('isLocale(stored)');
    expect(provider).toContain('localeDir(locale)');
    expect(provider).not.toContain('isRtlLocale');
    expect(request).toContain('isLocale(requested)');
    expect(index).toContain('localeSchema');
    expect(index).toContain('localeDir');
  });

  it('emits a catalog-typed useTranslations wrapper from index', () => {
    const index =
      generateTranslationModule(sampleDefinitions).find((f) => f.path === 'i18n/index.ts')
        ?.content ?? '';
    expect(index).toContain('useFormatter');
    expect(index).toContain('TranslationsFor<N>');
    expect(index).toContain('export type TranslationsFor');
    expect(index).toContain('[Args] extends [infer A]');
    expect(index).toContain('keyof A extends never');
    expect(index).toContain('? []');
    expect(index).toContain('[values?: A]');
    expect(index).toContain('[values: A]');
    expect(index).toContain('MessageArgsOf');
    expect(index).toContain('useCatalogTranslations');
    expect(index).not.toMatch(/\sas\s+(?:Locale|any|unknown|const)\b/);
    expect(index).toContain('export type {');
    expect(index).toContain('MessageArgsOf');
    expect(index).toContain('MessageKeyOf');
  });

  it('emits localeDir as ltr-only when no RTL locales are configured', () => {
    const ltrOnly: TranslationDefinition[] = [
      {
        name: 'common',
        defaultLocale: 'en',
        locales: ['en', 'fr'],
        messages: {
          en: { save: 'Save' },
          fr: { save: 'Enregistrer' },
        },
      },
    ];
    const config =
      generateTranslationModule(ltrOnly).find((f) => f.path === 'i18n/config.ts')?.content ?? '';
    expect(config).not.toContain('rtlLocaleSchema');
    expect(config).toContain('export function localeDir(_locale: Locale): "rtl" | "ltr"');
    expect(config).toContain('return "ltr"');
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
    expect(c).toContain('useState<Locale>(initialLocale ?? defaultLocale)');
  });

  it('persists locale to both cookie and localStorage', () => {
    const c = providerContent();
    expect(c).toContain('function persistLocale');
    expect(c).toContain('document.cookie');
    expect(c).toContain('localStorage.setItem(LOCALE_STORAGE_KEY');
  });

  it('reads localStorage on mount and re-syncs the cookie when it differs from initialLocale', () => {
    const c = providerContent();
    expect(c).not.toContain('if (initialLocale) return;');
    expect(c).toContain('localStorage.getItem(LOCALE_STORAGE_KEY)');
    expect(c).toContain('initialLocale !== undefined && stored !== initialLocale');
  });

  it('marks the persisted cookie secure over https', () => {
    const c = providerContent();
    expect(c).toContain('location.protocol === "https:"');
    expect(c).toContain('samesite=lax');
  });

  it('wires missing-message fallback helpers on NextIntlClientProvider', () => {
    const c = providerContent();
    expect(c).toContain('getMissingMessageFallback');
    expect(c).toContain('onTranslationError');
    expect(c).toContain('onError={onTranslationError}');
    expect(c).toContain('getMessageFallback={getMissingMessageFallback}');
  });
});

describe('generateRequestConfig (via generateTranslationModule)', () => {
  const requestContent = (options?: { serverLocaleCookie?: boolean }) =>
    generateTranslationModule(sampleDefinitions, options).find((f) => f.path === 'i18n/request.ts')
      ?.content ?? '';

  it('resolves locale from requestLocale only by default (no next/headers import)', () => {
    const c = requestContent();
    expect(c).not.toContain('next/headers');
    expect(c).not.toContain('cookies()');
    expect(c).toContain('isLocale(requested)');
    expect(c).toContain('const locale: Locale =');
  });

  it('reads the locale cookie via next/headers when serverLocaleCookie is enabled', () => {
    const c = requestContent({ serverLocaleCookie: true });
    expect(c).toContain('import { cookies } from "next/headers"');
    expect(c).toContain('LOCALE_COOKIE_KEY');
    expect(c).toContain('isLocale(candidate)');
  });

  it('wires missing-message fallback helpers in request config', () => {
    const c = requestContent();
    expect(c).toContain('onError: onTranslationError');
    expect(c).toContain('getMessageFallback: getMissingMessageFallback');
  });

  it('side-effect-imports global.ts so AppConfig is in the TypeScript graph', () => {
    expect(requestContent()).toContain('import "./global"');
    expect(requestContent({ serverLocaleCookie: true })).toContain('import "./global"');
  });
});

describe('generateTranslationModule defaultLocale consistency', () => {
  it('throws when namespaces disagree on defaultLocale', () => {
    const diverging: TranslationDefinition[] = [
      {
        name: 'common',
        defaultLocale: 'en',
        locales: ['en'],
        messages: { en: { save: 'Save' } },
      },
      {
        name: 'auth',
        defaultLocale: 'he',
        locales: ['he', 'en'],
        messages: {
          he: { login: 'התחבר' },
          en: { login: 'Log in' },
        },
      },
    ];
    expect(() => generateTranslationModule(diverging)).toThrow(/must share the same defaultLocale/);
  });
});
