// ── Translation Definition ──
// Type-safe i18n message catalogs with ICU MessageFormat.
// Messages use ICU syntax: "greeting": "Hello {name}",
// "items": "{count, plural, one {# item} other {# items}}"

/** A record of message keys to ICU MessageFormat strings for one locale */
export type MessageCatalog = Record<string, string>;

/** Translation definition — a named, frozen i18n message catalog */
export interface TranslationDefinition {
  /** Namespace identifier (e.g. "common", "errors", "auth") */
  name: string;
  /** Default fallback locale */
  defaultLocale: string;
  /** All supported locales — must include defaultLocale */
  locales: string[];
  /** Messages keyed by locale, then by message key */
  messages: Record<string, MessageCatalog>;
}

/** Resolver function: look up a translated string by key */
export interface TranslationResolver {
  /**
   * Resolve a translated message.
   * @param key - Dot-namespaced key, e.g. "errors.projectNotFound"
   * @param params - Interpolation values for ICU placeholders
   */
  t(key: string, params?: Record<string, string | number>): string;
}

/** Service that provides translation resolution for a specific locale */
export interface TranslationService extends TranslationResolver {
  /** The currently active locale */
  locale: string;
}
