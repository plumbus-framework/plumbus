import type { MessageCatalog, TranslationDefinition } from '../types/translation.js';

interface DefineTranslationInput {
  name: string;
  defaultLocale: string;
  locales: string[];
  messages: Record<string, MessageCatalog>;
}

/**
 * Define a translation catalog — a named set of i18n message strings.
 *
 * Validates at import time:
 * - name is required
 * - defaultLocale must exist in locales
 * - every declared locale must have a messages entry
 * - all locales must have the exact same set of keys
 *
 * Returns a deeply frozen TranslationDefinition.
 */
export function defineTranslation(config: DefineTranslationInput): TranslationDefinition {
  if (!config.name) {
    throw new Error('Translation name is required');
  }
  if (!config.defaultLocale) {
    throw new Error(`Translation "${config.name}": defaultLocale is required`);
  }
  if (!Array.isArray(config.locales) || config.locales.length === 0) {
    throw new Error(`Translation "${config.name}": locales must be a non-empty array`);
  }
  if (!config.locales.includes(config.defaultLocale)) {
    throw new Error(
      `Translation "${config.name}": defaultLocale "${config.defaultLocale}" must be included in locales [${config.locales.join(', ')}]`,
    );
  }

  // Ensure every declared locale has a messages entry
  for (const locale of config.locales) {
    if (!config.messages[locale]) {
      throw new Error(
        `Translation "${config.name}": missing messages for declared locale "${locale}"`,
      );
    }
  }

  // Collect the reference key set from the default locale
  const defaultMessages = config.messages[config.defaultLocale];
  if (!defaultMessages) {
    throw new Error(
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
      throw new Error(
        `Translation "${config.name}": locale "${locale}" is missing keys: [${missingKeys.map((k) => `"${k}"`).join(', ')}]`,
      );
    }
    if (extraKeys.length > 0) {
      throw new Error(
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
        throw new Error(`Translation "${config.name}": messages.${locale}.${key} must be a string`);
      }
    }
  }

  return Object.freeze({ ...config });
}
