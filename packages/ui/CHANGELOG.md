# Changelog

## 0.10.0-beta.0 — 2026-10-14 — core 0.9 beta family

### Upgrade boundary

- Beta prerelease of the coordinated core 0.9 family (core 0.9.x, UI 0.10.x, MCP 0.8.x, voice 0.7.x, other add-ons 0.4.x), published under the branch-named npm dist-tag `plumbus-next`. npm `latest` stays on the 0.8 stabilization family (core 0.8.1, UI 0.9.0, MCP 0.7.0, voice 0.6.0, auth 0.3.1, other add-ons 0.3.0).
- The 0.8 numbers went to that stable family on `main`, so the beta line moved up one minor: 0.10.0-beta.0 follows 0.9.0-beta.1 and contains everything in the previous betas plus the stable changes merged from `main` (stable 0.9.0). Install the whole beta family together and follow the [0.9 upgrade notes](../../docs/upgrading-core-0.9.md) and the [stabilization upgrade guide](../../docs/upgrading-stabilization.md).
- Plumbus peers are now `@plumbus/core` `>=0.9.0-beta.0 <0.10.0`; they stay prerelease-inclusive until the family goes stable.

### From the earlier betas

- **Breaking:** `generateClientModule` and `generateHooksModule` emit HTTP wrappers only for `exposeAs: ['api']` capabilities and skip `eventHandler` (0.9.0-beta.0); generated flow clients require an explicit `FlowTriggerInput.startPath` and emit no phantom routes (0.9.0-beta.1). Neither change is in stable 0.9.0.

### From main

- **Vitest 5.0.4** test toolchain and the Node floor `^22.12.0 || ^24.0.0 || >=26.0.0` (was `>=20.6.0`), with package instructions and compatibility guidance refreshed for core 0.8 and agent wiring v21 (stable 0.9.0). The Browser Mode config uses the matching Playwright provider (`@vitest/browser-playwright` 5.0.4 replaces `@vitest/browser`).
- Runs on `@plumbus/core` 0.9.0-beta.0, which also carries the stable core 0.8.0 fixes (PLB-01..PLB-10: event delivery policy, Redis startup and claim/reclaim recovery, flow claim fencing, durable scheduler ticks and schedule definitions, retry deadlines and flow dead letters, durable job publication, configuration overrides and app config files) and core 0.8.1's background-loop fixes (scheduler poll, delayed-wake promoter).

## 0.9.0 — Stabilization compatibility family

- Upgrade the framework test toolchain to **Vitest 5.0.4** and require Node 22.12+ on the 22.x line, Node 24.x, or Node 26+. Migrate the Browser Mode config to the matching Playwright provider.

Requires the coordinated core 0.8 family. Follow the [stabilization upgrade guide](../../docs/upgrading-stabilization.md) and the installed `node_modules/@plumbus/core/instructions/stabilization.md`; update installed Plumbus packages together.

- Update Plumbus peers to `@plumbus/core` `0.8.x`. This minor line makes the compatibility change an explicit upgrade.
- Refresh package instructions and compatibility guidance for core 0.8 and agent wiring v21. Runtime APIs in this add-on are unchanged.

## 0.9.0-beta.1 — 2026-09-20

### Fixed

- Generated flow clients require an explicit `FlowTriggerInput.startPath`. Automatic flow discovery emits no phantom HTTP routes; expose an authorized start capability and regenerate the client instead. Programmatic trigger descriptors without a served path are omitted.

## 0.9.0-beta.0 — 2026-09-11 — core 0.8 beta family

### Upgrade boundary

- Beta prerelease of the coordinated core 0.8 family (core 0.8.x, UI 0.9.x, MCP 0.7.x, voice 0.6.x, other add-ons 0.3.x), published under the branch-named npm dist-tag `plumbus-next` (`latest` stays on the 0.7 family). Previous caret ranges exclude it; install the whole family together and follow the [0.8 upgrade notes](../../docs/upgrading-core-0.9.md). Internal peers use prerelease-inclusive ranges (for example `>=0.8.0-beta.0 <0.9.0`) until the family goes stable.

### Breaking

- **`generateClientModule` and `generateHooksModule` skip capabilities that are not `exposeAs: ['api']`**, and skip `eventHandler` even when they are. Callers that pass a mixed registry get HTTP wrappers only for HTTP-exposed operations. Regenerate with `plumbus ui generate`.

## 0.8.1 — 2026-09-10

### Fixed

- Publish the corrected package README without the added “Release family” banner, using normal `latest` publication. Runtime behavior and peer dependencies are unchanged from 0.8.0.

## 0.8.0 — 2026-09-10

### Upgrade boundary

- This release is an explicit minor-line upgrade. Previous caret ranges exclude it; install the coordinated core 0.7.x family and follow the [migration checklist](../../docs/upgrading-security-release.md). Packages publish to npm’s default `latest` dist-tag.

### Agent instructions

- Updated packaged guidance for the security release and linked the core upgrade checklist. Refresh generated app instructions with `plumbus init --patch` (wiring v16).

### Changed

- Replace UI's direct core dependency with the required `@plumbus/core` `0.7.x` peer. This rejects new UI with an old application core instead of silently installing a second core inside UI. Install core and UI together; frontend APIs are unchanged.
- See [security release migration](../../docs/upgrading-security-release.md) for backend authentication and audit requirements.

## 0.7.3

### Fixed

- **Generated `useTranslations` returns a stable `t` identity** — the wrapper is memoized on the underlying next-intl translator so listing `t` in React effect dependency arrays no longer tears down and recreates intervals/timers on every render (which could silently freeze UI that polled or ticked via `t`-keyed effects). Regenerate `i18n/*` (`plumbus ui generate`) to pick up the fix.

### Changed

- **`ClientGeneratorConfig.authModuleImport` default is `./auth` (no `.js` suffix)** — suited to Next/Turbopack (`moduleResolution: "bundler"`). Targets using `node16`/`nodenext` (e.g. the browser-extension scaffold) must pass `authModuleImport: "./auth.js"` explicitly. See [docs/ui/ui-generation.md](../../docs/ui/ui-generation.md).

## 0.7.2

### Added

- **Auth transport** — `AuthHelperConfig.transport` (`session` | `bearer`) with session branch: credentialed `/auth/session`, in-memory CSRF, provider-picker login, no `localStorage`.
- **`ClientGeneratorConfig.authTransport`** — generated clients use `credentials: "include"` and `csrfHeaders()` for session transport; bearer clients merge `getAuthHeaders()`.
- **Next.js template session mode** — provider login page, `loadSession` in `AuthProvider`, no signup page when `authTransport: "session"`.
- **`__resetTransportWarningForTests`** — test helper for one-time deprecation warning when transport is omitted.
- **Auth documentation cross-links** — README ecosystem table and [docs/ui/ui-generation.md](../../docs/ui/ui-generation.md) section on adapting generated clients for `@plumbus/auth` cookie sessions + CSRF.

### Changed

- Omitted auth transport retains legacy bearer behavior and emits a deprecation warning (spec §22.3).
- CLI: `plumbus ui generate` and `plumbus ui nextjs` accept `--auth-transport session|bearer`.

## 0.7.1

### Fixed

- **Generated `i18n/messages.ts` is now assignable to the next-intl provider for multi-locale catalogs.** `generateMessagesCatalog` (and the split-locale `generateSplitMessagesAggregator`) froze the whole catalog with `as const`, which gave every locale a *divergent literal type* (`messages["en"].greeting` = `"Hello"`, `messages["he"].greeting` = `"שלום"` — different types). The generated `provider.tsx` / `request.ts` index it with a runtime locale (`messages[locale]`, `locale: Locale`), producing the union `messages["en"] | messages["he"]`, which is **not** assignable to `Messages` — the default-locale shape next-intl reads from `AppConfig`. Result: `NextIntlClientProvider`'s `messages` prop and `getRequestConfig`'s return both failed to typecheck (`TS2322: '…"Hello"… | …"שלום"…' is not assignable to 'DeepPartial<…"Hello"…>'`) for **any** project with ≥2 locales whose values differ (single-locale or identical-value catalogs were unaffected, which is how it slipped through). The catalog is now emitted as `const rawMessages = … as const` plus a per-locale→default-locale assertion (`export const messages = rawMessages as unknown as { [L in keyof typeof rawMessages]: (typeof rawMessages)[<defaultLocale>] }`), so every locale is typed as the default-locale shape and `messages[locale]` stays exactly `Messages`. The specific translated string *values* are never needed at the type level (keys come from `keyof`; ICU inference reads the default locale), so no type information is lost. **Runtime output is byte-identical** (`rawMessages` holds the same object); only the binding's type changes.

### Changed

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
