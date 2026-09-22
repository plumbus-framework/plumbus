/**
 * Intentional typecheck SUCCESS for defineTranslation SameKeyMessages.
 */
import { defineTranslation } from '../../../dist/define/defineTranslation.js';

export const okTwoLocales = defineTranslation({
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
      farewell: 'להתראות',
    },
  },
});

export const okThreeLocales = defineTranslation({
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
      farewell: 'להתראות',
    },
    fr: {
      greeting: 'Bonjour {name}',
      farewell: 'Au revoir',
    },
  },
});
