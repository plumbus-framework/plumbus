# Translation Generator

The translation generator produces `next-intl`-oriented i18n source files from Plumbus translation definitions.

It is implemented by `generateTranslationModule` and exported from `@plumbus/ui`. The generated files intentionally use the package runtime subpaths `@plumbus/ui/next-intl` and `@plumbus/ui/next-intl-server`, which re-export the required `next-intl` APIs.

Locale coverage (incomplete / empty message values) is enforced by `plumbus ui generate` via `computeStatus` from `@plumbus/core` — not inside this generator. Pass `--skip-locale-parity` on the CLI to skip that gate.

## Input

```ts
import type { TranslationDefinition } from "@plumbus/core";

function generateTranslationModule(
  definitions: TranslationDefinition[],
  options?: TranslationGeneratorOptions,
): GeneratedTranslationFile[];
```

If `definitions` is empty, the generator returns an empty array.

## Options

```ts
interface TranslationGeneratorOptions {
  splitLocaleBundles?: boolean;
  serverLocaleCookie?: boolean;
}
```

| Option | Behavior |
|---|---|
| `splitLocaleBundles` | When true, emits one bundle per locale under `i18n/locales/` and an aggregator at `i18n/messages.ts`. When false, emits one `i18n/messages.ts` file. |
| `serverLocaleCookie` | When true, generated request config reads the `plumbus-ui-locale` cookie server-side after `requestLocale`. |

`serverLocaleCookie` uses a Next.js Dynamic API. It opts routes into dynamic rendering and should not be used with static export.

## Generated files

Default output:

```text
i18n/messages.ts
i18n/config.ts
i18n/keys.ts
i18n/global.ts
i18n/request.ts
i18n/provider.tsx
i18n/index.ts
```

With `splitLocaleBundles: true`:

```text
i18n/locales/{locale}.ts
i18n/messages.ts
i18n/config.ts
i18n/keys.ts
i18n/global.ts
i18n/request.ts
i18n/provider.tsx
i18n/index.ts
```

| File | Purpose |
|---|---|
| `keys.ts` | `Messages`, `Namespace`, `MessageKeyOf`, `MessageArgsOf`, `I18nKey` from the default-locale catalog |
| `global.ts` | Official `next-intl` `AppConfig` augmentation (single-locale `Messages`) |
| `index.ts` | Catalog-typed `useTranslations` wrapper (namespaces, keys, and ICU params) |

## Message catalog behavior

The generator expands dotted keys into nested message objects because `next-intl` resolves nested paths.

Example:

```ts
{
  "nav.overview": "Overview"
}
```

becomes:

```ts
{
  nav: {
    overview: "Overview"
  }
}
```

## Locale config

The generated config includes:

- `locales`;
- `defaultLocale` (literal `as const satisfies Locale`);
- `rtlLocales`;
- `localeSchema` (`z.enum(locales)` from `@plumbus/core/zod`);
- `isLocale` (Zod `safeParse` type guard);
- `localeDir(locale)` → `"rtl" | "ltr"`;
- `rtlLocaleSchema` when at least one RTL locale is present.

Known RTL locales include:

```ts
["ar", "he", "fa", "ur", "ps", "sd", "yi"]
```

## Provider behavior

The generated provider:

- wraps children with `NextIntlClientProvider`;
- exposes locale state through a local context;
- persists the selected locale;
- updates `document.documentElement.lang`;
- updates `document.documentElement.dir` to `"rtl"` for known RTL locales and `"ltr"` otherwise;
- wires `onError` / `getMessageFallback` from `@plumbus/ui/next-intl` so missing keys render `[missing: namespace.key]` instead of throwing or blanking.

## Hook re-exports

The generated `i18n/index.ts` exports:

- a catalog-typed `useTranslations` wrapper (prefer this over `@plumbus/ui/next-intl`);
- `useFormatter`;
- `useLocale`;
- locale types and locale constants;
- `localeSchema`, `isLocale`, `localeDir`;
- `I18nKey`, `MessageArgsOf`, `MessageKeyOf`, `Messages`, `Namespace` from `keys.ts`.

`defaultLocale` is emitted as a literal (`as const satisfies Locale`) so `Messages` indexes one catalog, not a union of all locales.

## Usage

```ts
import { generateTranslationModule } from "@plumbus/ui";

const files = generateTranslationModule(definitions, {
  splitLocaleBundles: true,
  serverLocaleCookie: false,
});
```

Write each returned file to the path provided by its `path` field.

## Generation guidance

- Generate no i18n files when there are no translation definitions.
- Keep `serverLocaleCookie` disabled for static-export apps.
- Use split bundles when message catalogs are large or when per-locale chunking matters.
- Keep the generated `@plumbus/ui/next-intl` imports unless the application intentionally owns the `next-intl` dependency directly.
- Test RTL layouts visually for Hebrew, Arabic, Persian, Urdu, and other RTL locales.
