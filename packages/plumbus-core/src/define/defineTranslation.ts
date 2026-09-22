import type { MessageCatalog, TranslationDefinition } from '../types/translation.js';
import { deepFreeze } from '../types/deep-freeze.js';
import { throwDefineValidationError } from './validation-error.js';

/** Union of message keys across every locale catalog in M */
type UnionKeys<M extends Record<string, MessageCatalog>> = {
  [L in keyof M]: keyof M[L] & string;
}[keyof M];

/**
 * Keys present in the global union but absent from locale L.
 * `never` when L already has every key.
 */
type MissingKeysForLocale<M extends Record<string, MessageCatalog>, L extends keyof M> = Exclude<
  UnionKeys<M>,
  keyof M[L] & string
>;

/**
 * Force TS to expand mapped types in error messages (avoids dumping
 * `Record<UnionKeys<{...}>, string>` into the diagnostic).
 */
type Prettify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Per-locale catalog: pass-through when complete; otherwise expect a
 * concrete `{ key: string; ... }` for the full key union so TS reports
 * native diagnostics on that locale attribute, e.g.:
 *   Property 'farewell' is missing ...
 *   Type '…' is missing the following properties from type '…': greeting1, greeting2
 */
type SameKeyMessages<M extends Record<string, MessageCatalog>> = {
  [L in keyof M]: [MissingKeysForLocale<M, L>] extends [never]
    ? M[L]
    : Prettify<{ [K in UnionKeys<M>]: string }>;
};

interface DefineTranslationInput<M extends Record<string, MessageCatalog>> {
  name: string;
  defaultLocale: string;
  locales: string[];
  /**
   * Infer M from the literal catalogs, then require every locale to cover
   * UnionKeys. Incomplete locales get a prettified concrete object type so
   * TS emits native "missing the following properties: …" diagnostics.
   */
  messages: SameKeyMessages<M>;
}

/**
 * Define a translation catalog — a named set of i18n message strings.
 *
 * Validates at typecheck (for literal / `as const` catalogs):
 * - all locales must declare the exact same message keys
 *
 * Validates at import time:
 * - name is required
 * - defaultLocale must exist in locales
 * - every declared locale must have a messages entry
 * - all locales must have the exact same set of keys
 *
 * Returns a deeply frozen TranslationDefinition.
 */
export function defineTranslation<const M extends Record<string, MessageCatalog>>(
  config: DefineTranslationInput<M>,
): TranslationDefinition {
  if (!config.name) {
    throwDefineValidationError('Translation name is required');
  }
  if (!config.defaultLocale) {
    throwDefineValidationError(`Translation "${config.name}": defaultLocale is required`);
  }
  if (!Array.isArray(config.locales) || config.locales.length === 0) {
    throwDefineValidationError(`Translation "${config.name}": locales must be a non-empty array`);
  }
  if (!config.locales.includes(config.defaultLocale)) {
    throwDefineValidationError(
      `Translation "${config.name}": defaultLocale "${config.defaultLocale}" must be included in locales [${config.locales.join(', ')}]`,
    );
  }

  // Ensure every declared locale has a messages entry
  for (const locale of config.locales) {
    if (!config.messages[locale]) {
      throwDefineValidationError(
        `Translation "${config.name}": missing messages for declared locale "${locale}"`,
      );
    }
  }

  // Collect the reference key set from the default locale
  const defaultMessages = config.messages[config.defaultLocale];
  if (!defaultMessages) {
    throwDefineValidationError(
      `Translation "${config.name}": missing messages for default locale "${config.defaultLocale}"`,
    );
  }
  const referenceKeys = Object.keys(defaultMessages).sort();

  // Validate all locales have the same key set
  for (const locale of config.locales) {
    if (locale === config.defaultLocale) continue;
    const localeMessages = config.messages[locale];
    if (!localeMessages) continue; // already caught above
    const localeKeys = Object.keys(localeMessages).sort();

    const missingKeys = referenceKeys.filter((k) => !localeKeys.includes(k));
    const extraKeys = localeKeys.filter((k) => !referenceKeys.includes(k));

    if (missingKeys.length > 0) {
      throwDefineValidationError(
        `Translation "${config.name}": locale "${locale}" is missing keys: [${missingKeys.map((k) => `"${k}"`).join(', ')}]`,
      );
    }
    if (extraKeys.length > 0) {
      throwDefineValidationError(
        `Translation "${config.name}": locale "${locale}" has extra keys not in default locale: [${extraKeys.map((k) => `"${k}"`).join(', ')}]`,
      );
    }
  }

  // Validate no empty string values
  for (const locale of config.locales) {
    const localeMessages = config.messages[locale];
    if (!localeMessages) continue;
    for (const [key, value] of Object.entries(localeMessages)) {
      if (typeof value !== 'string') {
        throwDefineValidationError(
          `Translation "${config.name}": messages.${locale}.${key} must be a string`,
        );
      }
    }
  }

  return deepFreeze({ ...config });
}
