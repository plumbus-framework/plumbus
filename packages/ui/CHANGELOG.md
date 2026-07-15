# Changelog

## 0.6.2

### Added

- **`generateTranslationModule` typed keys + AppConfig** — emits `i18n/keys.ts` (`Messages`, `Namespace`, `MessageKeyOf`, `I18nKey`) and `i18n/global.ts` (official `declare module "next-intl"` `AppConfig`) plus a catalog-typed `useTranslations` wrapper in `i18n/index.ts` so bad namespaces/keys fail at typecheck even when `next-intl` is nested under `@plumbus/ui`. Generated `request.ts` side-effect-imports `./global` so AppConfig is always in the TypeScript graph.
- **`@plumbus/ui/next-intl`** — re-exports `useFormatter` and `IntlErrorCode`; adds `getMissingMessageFallback` / `onTranslationError` for a visible `[missing: …]` sentinel (no throw / no blank). `next-intl` is also a **peerDependency** so AppConfig and the re-export resolve the same install.
- **`@plumbus/ui/next-intl-server`** — re-exports `getTranslations` and `getFormatter`.
- Generated provider and request config wire the missing-message fallback helpers; generated config uses a literal `defaultLocale` (`as const satisfies Locale`) so `Messages` is not a locale union. Namespaces must share one `defaultLocale` or generate throws.
- **`localeSchema` + Zod-backed `isLocale` / `localeDir`** — generated `i18n/config.ts` imports `z` from `@plumbus/core/zod`; `isLocale` wraps `safeParse`, `localeDir(locale)` returns `"rtl" | "ltr"`.
- **`MessageArgsOf` ICU param typing** — generated `useTranslations` requires the correct ICU values object per key (names + string/number/date types from the message string via `ICUArgs`). Explicit `TranslationsFor<N>` return type keeps per-key inference after `.rich` / `.markup` are attached. Rest args: no ICU fields → no second argument (`[]`); required fields → `[values]`; all-optional → `[values?]`.

## 0.6.1

### Packaging

- Include `CHANGELOG.md` in the published package `files` list.

## 0.6.0

### Added

- **`TranslationProvider` `initialLocale` prop** — pass a server-resolved locale so the correct locale and `dir`/`lang` render on first paint (no flash). Initial state comes from `initialLocale` (matching the server); a differing stored `localStorage` preference is still adopted after hydration and re-syncs the cookie, so a cleared or expired cookie never loses the user's choice.
- **Cookie locale persistence** — `setLocale` writes the active locale to both `localStorage` and a `plumbus-ui-locale` cookie (1-year max-age, `path=/`, `samesite=lax`, `secure` over HTTPS), so a Server Component root layout can read it.
- **`generateTranslationModule` `serverLocaleCookie` option** (CLI `--server-locale-cookie`) — opt-in request config that reads the `plumbus-ui-locale` cookie server-side after `requestLocale`.
- **Client generator: `ZodEffects` support** — capability inputs/outputs wrapped in `.refine`/`.superRefine` now generate their concrete object shape instead of `unknown`.

### Notes

- The **default** `i18n/request.ts` is unchanged from 0.5.x: it resolves locale from `requestLocale` only and stays statically renderable. `--server-locale-cookie` is opt-in because `cookies()` is a Next.js Dynamic API — it opts affected routes into dynamic rendering and is **not** compatible with `output: 'export'`. When enabled, the generated config reads the cookie only when `requestLocale` is unresolved, so URL-locale routes remain static.
- `ZodEffects` types are resolved by position. Refinements (`.refine`/`.superRefine`) unwrap to the inner shape in both positions. A `.transform()` emits its source shape for **input** (the wire carries the pre-transform value) and `unknown` for **output** (the post-transform type is a function return value Zod does not expose statically). `z.preprocess` is the mirror: `unknown` for input, inner shape for output.

## 0.5.1

### Added

- **`generateTranslationModule` split-locale mode** — optional `splitLocaleBundles` emits per-locale bundles under `i18n/locales/` plus a thin aggregator; default output remains a single `i18n/messages.ts`.
- **`TranslationGeneratorOptions`** — exported from `@plumbus/ui` for CLI and tooling.

## 0.5.0

### Documentation

- README ecosystem table updated for `@plumbus/core` **0.5.x** (workers/queues, canonical capability names).

## 0.4.2

### Documentation

- README ecosystem table lists `@plumbus/api` (partner external API add-on).

## 0.4.1

- Released with `@plumbus/core` 0.4.1 (browser-extension scaffolder era).
