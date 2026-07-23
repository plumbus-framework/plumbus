# Changelog

## 0.7.1

### Added

- **Auth transport** — `AuthHelperConfig.transport` (`session` | `bearer`) with session branch: credentialed `/auth/session`, in-memory CSRF, provider-picker login, no `localStorage`.
- **`ClientGeneratorConfig.authTransport`** — generated clients use `credentials: "include"` and `csrfHeaders()` for session transport; bearer clients merge `getAuthHeaders()`.
- **Next.js template session mode** — provider login page, `loadSession` in `AuthProvider`, no signup page when `authTransport: "session"`.
- **`__resetTransportWarningForTests`** — test helper for one-time deprecation warning when transport is omitted.
- **Auth documentation cross-links** — README ecosystem table and [docs/ui/ui-generation.md](../../docs/ui/ui-generation.md) section on adapting generated clients for `@plumbus/auth` cookie sessions + CSRF.

### Fixed

- **Generated `i18n/messages.ts` is now assignable to the next-intl provider for multi-locale catalogs.** `generateMessagesCatalog` (and the split-locale `generateSplitMessagesAggregator`) froze the whole catalog with `as const`, which gave every locale a *divergent literal type* (`messages["en"].greeting` = `"Hello"`, `messages["he"].greeting` = `"שלום"` — different types). The generated `provider.tsx` / `request.ts` index it with a runtime locale (`messages[locale]`, `locale: Locale`), producing the union `messages["en"] | messages["he"]`, which is **not** assignable to `Messages` — the default-locale shape next-intl reads from `AppConfig`. Result: `NextIntlClientProvider`'s `messages` prop and `getRequestConfig`'s return both failed to typecheck (`TS2322: '…"Hello"… | …"שלום"…' is not assignable to 'DeepPartial<…"Hello"…>'`) for **any** project with ≥2 locales whose values differ (single-locale or identical-value catalogs were unaffected, which is how it slipped through). The catalog is now emitted as `const rawMessages = … as const` plus a per-locale→default-locale assertion (`export const messages = rawMessages as unknown as { [L in keyof typeof rawMessages]: (typeof rawMessages)[<defaultLocale>] }`), so every locale is typed as the default-locale shape and `messages[locale]` stays exactly `Messages`. The specific translated string *values* are never needed at the type level (keys come from `keyof`; ICU inference reads the default locale), so no type information is lost. **Runtime output is byte-identical** (`rawMessages` holds the same object); only the binding's type changes.

### Changed

- Omitted auth transport retains legacy bearer behavior and emits a deprecation warning (spec §22.3).
- CLI: `plumbus ui generate` and `plumbus ui nextjs` accept `--auth-transport session|bearer`.
- Regenerate `i18n/*` (`plumbus ui generate`) to pick up the corrected `messages.ts`. No app-code changes required; no runtime behavior change.

## 0.7.0

### Added

- **`TranslatedText` brand emit** — `generateTranslationModule` emits `i18n/translated-text.ts` (`TranslatedText` + emit-only `brandTranslatedText`). Generated `useTranslations` `t` / `markup` return `TranslatedText` via the brander; the type is re-exported from `i18n/index.ts`, the brander is not. `.rich` stays `ReactNode`. `AppConfig.Messages` / catalog leaves remain plain strings. Server `getTranslations` from `@plumbus/ui/next-intl-server` stays plain `string` (client wrapper only in 0.7.0).

### Changed

- After upgrading to 0.7.0, regenerate `i18n/*` (`plumbus ui generate`).
- Drop any hand-maintained `translated-text.ts` or post-generate rewrite that patched branding into generated output.
- Import `TranslatedText` from generated `i18n` for gated props (`label: TranslatedText`, etc.).

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
