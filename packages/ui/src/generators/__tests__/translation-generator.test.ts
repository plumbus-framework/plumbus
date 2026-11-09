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

  it('emits cast-free provider, request, and locale helpers', () => {
    const files = generateTranslationModule(sampleDefinitions);
    const provider = files.find((f) => f.path === 'i18n/provider.tsx')?.content ?? '';
    const request = files.find((f) => f.path === 'i18n/request.ts')?.content ?? '';
    const config = files.find((f) => f.path === 'i18n/config.ts')?.content ?? '';
    const index = files.find((f) => f.path === 'i18n/index.ts')?.content ?? '';

    expect(provider).not.toMatch(/\sas\s+Locale\b/);
    expect(request).not.toMatch(/\sas\s+Locale\b/);
    // zod stays out of config.ts: its schemas come from a side-effect-free module.
    expect(config).not.toContain('@plumbus/core/zod');
    expect(config).toContain('export { localeSchema, rtlLocaleSchema } from "./schema/locale"');
    expect(config).toContain('export function isLocale');
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

  it('memoizes the useTranslations wrapper so `t` keeps a stable identity', () => {
    // Regression: an unmemoized wrapper returned a NEW `t` on every render.
    // Any timer effect listing `t` in its deps inside a component that
    // re-renders faster than the timer period (1s elapsed clock vs 5s poll)
    // was torn down every render and never fired — a frozen UI with a silent
    // console. The emitted hook must memoize its return on [translator].
    const index =
      generateTranslationModule(sampleDefinitions).find((f) => f.path === 'i18n/index.ts')
        ?.content ?? '';
    expect(index).toContain('import { useMemo } from "react";');
    expect(index).toContain('return useMemo(() => {');
    expect(index).toContain('}, [translator]);');
  });

  it('emits TranslatedText brand and brands t()/markup return types', () => {
    const files = generateTranslationModule(sampleDefinitions);
    const paths = files.map((f) => f.path);

    expect(paths).toContain('i18n/translated-text.ts');

    const brand = files.find((f) => f.path === 'i18n/translated-text.ts')?.content ?? '';
    expect(brand).toContain('declare const translatedTextBrand: unique symbol');
    expect(brand).toContain('export type TranslatedText');
    expect(brand).toContain('export function brandTranslatedText');
    expect(brand).toContain('return value as TranslatedText');

    const index = files.find((f) => f.path === 'i18n/index.ts')?.content ?? '';
    expect(index).toContain('import { brandTranslatedText } from "./translated-text"');
    expect(index).toContain('import type { TranslatedText } from "./translated-text"');
    expect(index).toContain('export type { TranslatedText } from "./translated-text"');
    expect(index).not.toContain('export { brandTranslatedText');
    expect(index).toContain('): TranslatedText {');
    expect(index).toContain('return brandTranslatedText(translator(key, ...args))');
    expect(index).toContain(
      '): TranslatedText => brandTranslatedText(translator.markup(key, ...args))',
    );
    expect(index).toContain('): ReactNode => translator.rich(key, ...args)');

    const aug = files.find((f) => f.path === 'i18n/global.ts')?.content ?? '';
    expect(aug).toContain('Messages: (typeof messages)[typeof defaultLocale]');
    expect(aug).not.toContain('TranslatedText');
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

describe('locale helpers without zod in config.ts', () => {
  const files = generateTranslationModule(sampleDefinitions);
  const config = files.find((f) => f.path === 'i18n/config.ts')?.content ?? '';
  const schema = files.find((f) => f.path === 'i18n/schema/locale.ts')?.content ?? '';

  it('keeps the zod schemas, in a module marked side-effect free', () => {
    expect(schema).toContain('import { z } from "@plumbus/core/zod"');
    expect(schema).toMatch(/export const localeSchema = z\.enum\(\[/);
    expect(schema).toMatch(/export const rtlLocaleSchema = z\.enum\(\[/);
    const pkg = files.find((f) => f.path === 'i18n/schema/package.json')?.content ?? '';
    expect(JSON.parse(pkg)).toEqual({ sideEffects: false });
  });

  it('answers isLocale and localeDir exactly as the schemas do', async () => {
    const ts = (await import('typescript')).default;
    const { z } = await import('zod');
    const js = ts.transpileModule(
      config.replace(/^export \{[^}]*\} from "\.\/schema\/locale";$/m, ''),
      {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      },
    ).outputText;
    const mod: Record<string, any> = {};
    new Function('exports', js)(mod);
    const localeSchema = z.enum(mod.locales);
    for (const value of [...mod.locales, 'xx', '', 'EN', 'he-IL']) {
      expect(mod.isLocale(value)).toBe(localeSchema.safeParse(value).success);
    }
    for (const locale of mod.locales) {
      expect(mod.localeDir(locale)).toBe(mod.rtlLocales.includes(locale) ? 'rtl' : 'ltr');
    }
  });
});

describe('serverMessages', () => {
  const files = generateTranslationModule(sampleDefinitions, { serverMessages: true });
  const provider = files.find((f) => f.path === 'i18n/provider.tsx')?.content ?? '';

  it('emits per-locale bundles and keeps messages.ts for the server', () => {
    expect(files.some((f) => f.path === 'i18n/locales/en.ts')).toBe(true);
    expect(files.some((f) => f.path === 'i18n/messages.ts')).toBe(true);
  });

  it('keeps every catalog out of the provider: initialMessages, other locales on switch', () => {
    expect(provider).toContain('import type { messages } from "./messages"');
    expect(provider).not.toMatch(/^import \{ messages \}/m);
    expect(provider).toContain('initialMessages?: LocaleCatalog');
    expect(provider).toContain(
      '() => import("./locales/en").then((m) => m.localeMessages as unknown as LocaleCatalog)',
    );
  });

  it('switches the locale at once and shows the new catalog when it has loaded', () => {
    expect(provider).toContain('setLocaleState(next);');
    expect(provider).toContain('const contextValue = useMemo(() => ({ locale, setLocale })');
    expect(provider).toContain('locale={shown.locale}');
    expect(provider).toContain('messages={shown.messages}');
    expect(provider).toContain('document.documentElement.lang = shown.locale;');
  });

  it('leaves the default provider unchanged', () => {
    const plain =
      generateTranslationModule(sampleDefinitions).find((f) => f.path === 'i18n/provider.tsx')
        ?.content ?? '';
    expect(plain).toContain('import { messages } from "./messages"');
    expect(plain).not.toContain('initialMessages');
  });
});
