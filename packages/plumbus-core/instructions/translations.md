# Translations

A translation is a type-safe i18n message catalog defined with `defineTranslation()`.

## Defining a Translation

```ts
import { defineTranslation } from "@plumbus/core";

export const commonTranslation = defineTranslation({
  name: "common",
  defaultLocale: "en",
  locales: ["en", "he"],
  messages: {
    en: {
      "nav.overview": "Overview",
      "greeting": "Hello {name}",
      "items": "{count, plural, one {# item} other {# items}}",
    },
    he: {
      "nav.overview": "סקירה",
      "greeting": "שלום {name}",
      "items": "{count, plural, one {פריט #} other {# פריטים}}",
    },
  },
});
```

## Rules

- Place translation files in `app/translations/<name>.translation.ts` (classic layout), **or** use the locale-folder layout below
- Each assembler exports one `defineTranslation()` result
- All locales **must** have the same key set — mismatched keys fail at typecheck for literal catalogs and throw at import time otherwise
- Prefer literal / `as const` catalogs so `tsc` catches drift. A locale typed as `Record<string, string>` skips compile-time key checks and still relies on import-time validation
- When a non-default locale has an extra key, typecheck may error on the **default** locale (“missing key X”) while runtime errors on the **other** locale (“extra key X”) — both catch the same drift
- Messages use ICU MessageFormat: `{name}` for interpolation, `{count, plural, ...}` for plurals, `{gender, select, ...}` for select
- The `name` field is the namespace: keys resolve as `<namespace>.<key>` (e.g., `common.nav.overview`)

## Locale-folder layout (optional)

For larger catalogs, keep one folder per locale and a thin assembler:

```
app/translations/
  en/common.messages.ts
  he/common.messages.ts
  common.translation.ts   # imports en + he, calls defineTranslation()
```

Scaffold with:

```bash
plumbus translation new myNamespace --locale-folders
```

Large namespaces (e.g. `staff`) can split further under `en/staff/*.messages.ts` and merge with a local `index.ts` before the assembler imports `./en/staff/index.js`.

Discovery still loads only `defineTranslation()` exports; plain `messages` objects in locale folders are ignored.

## Server-Side Usage

In capability handlers, use `ctx.translations.t()`:

```ts
throw ctx.errors.notFound(ctx.translations.t("errors.projectNotFound"));
```

The locale is resolved from the request context.

## CLI Commands

| Command | Description |
|---------|-------------|
| `plumbus translation new <name>` | Scaffold a new translation file |
| `plumbus translation new <name> --locale-folders` | Scaffold `en/`, `he/` message files + thin assembler |
| `plumbus translation export` | Export to JSON or XLIFF 2.0 for professional translation |
| `plumbus translation import` | Import translated JSON/XLIFF files back into source |
| `plumbus translation status` | Report per-locale completion percentage (exits non-zero when incomplete) |

## Frontend

When translations exist, `plumbus ui generate` produces `{frontend}/i18n/` with next-intl integration (messages, config, typed keys, AppConfig, provider, request). Generate fails closed on incomplete locale coverage unless you pass `--skip-locale-parity`.

Optional: emit per-locale bundles (same runtime API, smaller generated files):

```bash
plumbus ui generate --out-dir frontend --split-locale-bundles
```

Without the flag, output is unchanged — a single `i18n/messages.ts`.

```tsx
import { useTranslations } from "../i18n";

function Nav() {
  const t = useTranslations("common");
  return <a>{t("nav.overview")}</a>;
}
```

## Adding a Locale

1. Add the locale to `locales` array in each `defineTranslation()`
2. Add the message catalog with all keys
3. Run `plumbus translation status` to verify 100%
4. Run `plumbus ui generate` to regenerate frontend i18n

## Translation Sync

`defineTranslation()` enforces key consistency at typecheck for literal / `as const` catalogs, and again at import time. If locale "he" is missing keys that "en" has, `tsc` fails for typed catalogs and the app throws immediately otherwise. This ensures tests and CI catch translation drift.

### Dynamic locales

```ts
const he: Record<string, string> = loadFromCms("he"); // no compile-time key parity

defineTranslation({
  name: "common",
  defaultLocale: "en",
  locales: ["en", "he"],
  messages: {
    en: { greeting: "Hello", farewell: "Bye" },
    he,
  },
});
// Runtime still throws if `he` is missing/extra keys relative to `en`.
```
