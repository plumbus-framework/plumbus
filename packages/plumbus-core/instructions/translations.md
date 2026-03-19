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

- Place translation files in `app/translations/<name>.translation.ts`
- Each file exports one `defineTranslation()` result
- All locales **must** have the same key set — mismatched keys throw at import time
- Messages use ICU MessageFormat: `{name}` for interpolation, `{count, plural, ...}` for plurals, `{gender, select, ...}` for select
- The `name` field is the namespace: keys resolve as `<namespace>.<key>` (e.g., `common.nav.overview`)

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
| `plumbus translation export` | Export to JSON or XLIFF 2.0 for professional translation |
| `plumbus translation import` | Import translated JSON/XLIFF files back into source |
| `plumbus translation status` | Report per-locale completion percentage |

## Frontend

When translations exist, `plumbus ui generate` produces `generated/i18n/` with next-intl integration:

```tsx
import { useTranslations } from "next-intl";

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

`defineTranslation()` validates key consistency at import time. If locale "he" is missing keys that "en" has, the app throws immediately. This ensures tests and CI catch translation drift.
