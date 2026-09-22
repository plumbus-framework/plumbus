/**
 * Intentional typecheck FAILURES for defineTranslation SameKeyMessages.
 * Excluded from the package tsconfig; checked by scripts/check-define-translation-types.mjs.
 */
import { defineTranslation } from '../../../dist/define/defineTranslation.js';

// ❌ he missing farewell → TS2741
export const missingOneKey = defineTranslation({
  name: 'common',
  defaultLocale: 'en',
  locales: ['en', 'he'],
  messages: {
    en: {
      greeting: 'Hello {name}',
      farewell: 'Goodbye',
    },
    he: {
      greeting: 'שלום {name}',
    },
  },
});

// ❌ mutual 2-locale drift → TS2741 on en, TS2739 on he
export const twoLocaleMutualMismatch = defineTranslation({
  name: 'common',
  defaultLocale: 'en',
  locales: ['en', 'he'],
  messages: {
    en: {
      greeting: 'Hello {name}',
      greeting1: 'Hi',
      greeting2: 'Hey',
    },
    he: {
      greeting: 'שלום {name}',
      farewell: 'להתראות',
    },
  },
});

// ❌ mutual 3-locale drift → TS2739 on en, he, fr
export const threeLocaleMutualMismatch = defineTranslation({
  name: 'common',
  defaultLocale: 'en',
  locales: ['en', 'he', 'fr'],
  messages: {
    en: {
      greeting: 'Hello {name}',
      farewell: 'Goodbye',
    },
    he: {
      greeting: 'שלום {name}',
      goodbye: 'להתראות',
    },
    fr: {
      greeting: 'Bonjour {name}',
      salut: 'Salut',
    },
  },
});
